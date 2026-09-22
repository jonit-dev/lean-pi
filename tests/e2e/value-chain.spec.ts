/**
 * PRD-040 AC-5 — the value chain through `createLeanPiSession().runTurn()`.
 *
 * A real session, a real temp git repo, the real compiler, the real stub vendor
 * CLI (the only fake is the vendor transport), real verification, the real
 * reviewer lane, the real proof gate and real telemetry. The turn exercises a
 * MEDIUM contract, so the runtime-plan regression (D1) is caught: before the fix
 * every MEDIUM turn demanded an unsatisfiable `runtime_smoke`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { createLeanPiSession, readRuns } from "../../src/index.js";
import { resolvedDefaults } from "../../src/permissions/trust.js";
import { setBrowserFacility } from "../../src/runtime/index.js";
import { bootHarnessSession, fixtureRepo, gitCommitAll, gitInit, harnessStubEnv, nativeBackend, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend } from "../helpers/stub-backend.js";
import { installStubCli, setStubScript } from "../backends/helpers.js";
import { fakeBrowser, runtimeFixture } from "../runtime/support.js";

const PASS_VERDICT = JSON.stringify({ decision: "PASS", findings: [] });
const USER_EDIT = "export const untouched = 2; // the user's own pre-existing edit\n";
const ANSWERED = "export const answer = 42;\n";

function e2eConfig(cwd: string, cli: ReturnType<typeof installStubCli>, nativeBaseUrl: string, verify: Record<string, unknown>) {
	return loadConfig(cwd, {
		configPath: null,
		backends: {
			claude: { type: "external_harness", command: cli.bin.claude, roles: ["quick", "balanced", "strong", "review_quick", "review_strong"] },
			local: { ...nativeBackend(nativeBaseUrl), roles: ["specialist"] },
		},
		models: {
			quick: { backend: "claude", model: "claude-model" },
			balanced: { backend: "claude", model: "claude-model" },
			strong: { backend: "claude", model: "claude-model" },
			review_quick: { backend: "claude", model: "claude-model" },
			review_strong: { backend: "claude", model: "claude-model" },
			specialist: { backend: "local", model: "local-model" },
		},
		jev: { apiKey: null, endpoint: "http://127.0.0.1:1/v1/systemone", model: "jev", mode: "disabled", usd_per_mtok: 0 },
		verify,
		limits: { executionAttempts: 2, semanticReviewRounds: 1, isolation: "none" },
		permissions: resolvedDefaults(),
	});
}

/** A repo whose dirty test file names AC-1's surface; `src/untouched.ts` is the user's own edit. */
function chainRepo(): { cwd: string; agentDir: string } {
	const { cwd, agentDir } = fixtureRepo();
	execFileSync("mkdir", ["-p", join(cwd, "src"), join(cwd, "tests")]);
	writeFileSync(join(cwd, "src", "answer.ts"), "export const answer = 1;\n");
	writeFileSync(join(cwd, "src", "untouched.ts"), "export const untouched = 1;\n");
	writeFileSync(join(cwd, "tests", "answer.spec.ts"), "it('answers', () => {});\n");
	gitInit(cwd);
	gitCommitAll(cwd);
	// Two pre-existing dirty paths: the test names the surface, the source file is
	// the user's own work the turn must not claim.
	writeFileSync(join(cwd, "tests", "answer.spec.ts"), "it('answers', () => expect(1).toBe(1));\n");
	writeFileSync(join(cwd, "src", "untouched.ts"), USER_EDIT);
	return { cwd, agentDir };
}

function readRecordInSecondProcess(path: string): { rows: number; success: boolean } {
	const script = `const fs=require("fs");const rows=fs.readFileSync(${JSON.stringify(path)},"utf8").split("\\n").filter(Boolean).map(JSON.parse);console.log(JSON.stringify({rows:rows.length,success:rows[0]&&rows[0].result.success}));`;
	const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
	return JSON.parse(out.trim()) as { rows: number; success: boolean };
}

describe("AC-5 — external value chain through the real session", () => {
	it("compiles, executes, verifies, reviews, gates and records one successful run", async () => {
		const { cwd, agentDir } = chainRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { files: { "src/answer.ts": ANSWERED }, summary: PASS_VERDICT });
		const config = e2eConfig(cwd, cli, native.baseUrl, {
			commands: { typecheck: "true", targeted_test: "grep -q 'answer = 42' src/answer.ts", git_status: "git status --porcelain" },
		});
		const session = await bootHarnessSession({ cwd, agentDir, config, model: { provider: "local", model: "local-model" } });
		try {
			const context = await session.runTurn({ text: "fix the parse bug", role: "specialist" });
			expect(context.contract?.task.execution_complexity).toBe("MEDIUM");

			// Exact bytes on disk, and the user's pre-existing edit preserved.
			expect(readFileSync(join(cwd, "src", "answer.ts"), "utf8")).toBe(ANSWERED);
			expect(readFileSync(join(cwd, "src", "untouched.ts"), "utf8")).toBe(USER_EDIT);
			// The changed set is the worker's edit alone, not the untouched user work.
			expect(context.executor?.changedFiles).toEqual(["src/answer.ts"]);

			// A nonempty criterion genuinely evidenced: the real verifier passed and
			// the reviewer actually ran and returned PASS.
			expect(context.proof?.decision).toBe("PASS");
			expect(context.proof?.criteria[0]?.decision).toBe("PASS");
			expect(context.proof?.criteria[0]?.coverage.satisfied).toBe(true);
			expect(context.executor?.status).toBe("completed");
			expect(context.executor?.review.verdict?.decision).toBe("PASS");
			// The executor lane owned the turn: Pi's loop never ran a second
			// executor request against the registered native backend.
			expect(native.requests).toEqual([]);

			// Exactly one persisted telemetry row, successful, on the harness backend.
			const rows = readRuns(cwd);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.result.success).toBe(true);
			expect(rows[0]!.executor_backend).toBe("claude");
			// The stub vendor reports no token usage and the harness is a
			// subscription: no metered usage was supplied, so the record discloses a
			// zero API valuation instead of a fabricated positive one.
			expect(rows[0]!.cost.api_usd).toBe(0);
			// The record survives the process that wrote it.
			const reread = readRecordInSecondProcess(join(cwd, ".leanpi", "telemetry.jsonl"));
			expect(reread).toEqual({ rows: 1, success: true });
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});
});

describe("AC-5 — negative controls block without a false success", () => {
	it("a failing verifier blocks the turn and preserves the edit", async () => {
		const { cwd, agentDir } = chainRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { files: { "src/answer.ts": ANSWERED }, summary: PASS_VERDICT });
		const config = e2eConfig(cwd, cli, native.baseUrl, {
			commands: { typecheck: "true", targeted_test: "exit 1", git_status: "git status --porcelain" },
		});
		const session = await bootHarnessSession({ cwd, agentDir, config, model: { provider: "local", model: "local-model" } });
		try {
			const context = await session.runTurn({ text: "fix the parse bug", role: "specialist" });
			expect(context.executor?.status).toBe("blocked");
			expect(context.proof?.decision).not.toBe("PASS");
			// The blocked outcome still reports the task-owned edit (and its hash),
			// never the user's own pre-existing dirty file.
			expect(context.executor?.changedFiles).toEqual(["src/answer.ts"]);
			expect(context.executor?.workspaceHash).toBeTruthy();
			// Edited work is preserved; only the gate's verdict blocks.
			expect(readFileSync(join(cwd, "src", "answer.ts"), "utf8")).toBe(ANSWERED);
			const rows = readRuns(cwd);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.result.success).toBe(false);
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});

	it("a FIX_REQUIRED reviewer blocks without a false success", async () => {
		const { cwd, agentDir } = chainRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const verdict = JSON.stringify({ decision: "FIX_REQUIRED", findings: [{ criterion: "AC-1", file: "src/answer.ts", location: "1", severity: "high", evidence: "the answer is not derived" }] });
		const restore = setStubScript(cli.recordPath, { files: { "src/answer.ts": ANSWERED }, summary: verdict });
		const config = e2eConfig(cwd, cli, native.baseUrl, {
			commands: { typecheck: "true", targeted_test: "grep -q 'answer = 42' src/answer.ts", git_status: "git status --porcelain" },
		});
		// Two rounds: the first FIX_REQUIRED sends the executor back, and the retry
		// edits nothing. The cumulative change set is what makes that retry still
		// review the change the first attempt made instead of skipping the reviewer.
		config.limits.semanticReviewRounds = 2;
		const session = await bootHarnessSession({ cwd, agentDir, config, model: { provider: "local", model: "local-model" } });
		try {
			const context = await session.runTurn({ text: "fix the parse bug", role: "specialist" });
			// The reviewer lane ran for real and returned FIX_REQUIRED, which sent the
			// executor round back; the turn never reaches a proven state.
			expect(cli.records().some((record) => record.prompt.includes("reviewer lane"))).toBe(true);
			expect(context.executor?.invocations.some((invocation) => invocation.strategy === "review_fix")).toBe(true);
			expect(context.executor?.status).toBe("blocked");
			expect(context.executor?.blockedReason).toMatch(/reviewer requires a fix|FIX_REQUIRED/);
			expect(context.executor?.review.verdict?.decision).toBe("FIX_REQUIRED");
			expect(context.proof?.decision).not.toBe("PASS");
			// The no-op retry did not erase the first attempt's change set.
			expect(context.executor?.changedFiles).toEqual(["src/answer.ts"]);
			expect(context.executor?.workspaceHash).toBeTruthy();
			expect(readFileSync(join(cwd, "src", "answer.ts"), "utf8")).toBe(ANSWERED);
			const rows = readRuns(cwd);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.result.success).toBe(false);
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});

	it("a declared runtime check with no facility leaves the proof unproved", async () => {
		const { cwd, agentDir } = chainRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { files: { "src/answer.ts": ANSWERED }, summary: PASS_VERDICT });
		const config = e2eConfig(cwd, cli, native.baseUrl, {
			// A browser check is declared and therefore required; the session exposes
			// no facility, so it records `unavailable` and the turn cannot pass.
			runtime: { browser: { url: "http://127.0.0.1:1/", selectors: ["#app"] } },
			commands: { typecheck: "true", targeted_test: "grep -q 'answer = 42' src/answer.ts", git_status: "git status --porcelain" },
		});
		const session = await bootHarnessSession({ cwd, agentDir, config, model: { provider: "local", model: "local-model" } });
		try {
			const context = await session.runTurn({ text: "fix the parse bug", role: "specialist" });
			expect(context.contract?.verification.required).toContain("browser_test");
			expect(context.proof?.decision).not.toBe("PASS");
			expect(context.executor?.status).toBe("blocked");
			expect(readFileSync(join(cwd, "src", "answer.ts"), "utf8")).toBe(ANSWERED);
			const rows = readRuns(cwd);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.result.success).toBe(false);
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});
});

describe("AC-5 — the browser facility is a session option, not a process global", () => {
	const browserUrl = "http://127.0.0.1:9/";
	const browserVerify = {
		runtime: { browser: { url: browserUrl, selectors: ["#app"] } },
		commands: { typecheck: "true", targeted_test: "grep -q 'answer = 42' src/answer.ts", git_status: "git status --porcelain" },
	};

	it("drives the injected facility and records real browser evidence", async () => {
		const { cwd, agentDir } = chainRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { files: { "src/answer.ts": ANSWERED }, summary: PASS_VERDICT });
		const config = e2eConfig(cwd, cli, native.baseUrl, browserVerify);
		const browser = fakeBrowser({ page: runtimeFixture("web/index.html") });
		const session = await bootHarnessSession({ cwd, agentDir, config, model: { provider: "local", model: "local-model" }, browserFacility: browser.facility });
		try {
			const context = await session.runTurn({ text: "fix the parse bug", role: "specialist" });
			expect(context.contract?.verification.required).toContain("browser_test");
			expect(context.proof?.decision).toBe("PASS");
			expect(context.executor?.evidence.find((entry) => entry.kind === "browser_test")?.status).toBe("pass");
			expect(browser.visited).toEqual([browserUrl]);
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});

	it("records the check unavailable and blocks when no facility is supplied", async () => {
		const { cwd, agentDir } = chainRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { files: { "src/answer.ts": ANSWERED }, summary: PASS_VERDICT });
		const config = e2eConfig(cwd, cli, native.baseUrl, browserVerify);
		// Another caller's adapter is present in the process. This session supplied
		// none, so it must not inherit it: the record is `unavailable`.
		const global = fakeBrowser({ page: runtimeFixture("web/index.html") });
		setBrowserFacility(global.facility);
		const session = await bootHarnessSession({ cwd, agentDir, config, model: { provider: "local", model: "local-model" } });
		try {
			const context = await session.runTurn({ text: "fix the parse bug", role: "specialist" });
			expect(context.executor?.evidence.find((entry) => entry.kind === "browser_test")?.status).toBe("unavailable");
			expect(global.visited).toEqual([]);
			expect(context.proof?.decision).not.toBe("PASS");
			expect(context.executor?.status).toBe("blocked");
		} finally {
			setBrowserFacility(undefined);
			restore();
			session.session.dispose();
			await native.close();
		}
	});
});

describe("AC-5 — a declared screenshot must not vanish when its baseline is missing", () => {
	it("requires screenshot_compare, records it unavailable, and the turn fails closed", async () => {
		const { cwd, agentDir } = chainRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { files: { "src/answer.ts": ANSWERED }, summary: PASS_VERDICT });
		const config = e2eConfig(cwd, cli, native.baseUrl, {
			// The baseline never existed. Selection must still require the check the
			// contract declared; the verifier reports the missing baseline itself.
			runtime: { screenshot: { url: "http://127.0.0.1:1/", baseline: "web/absent.png" } },
			commands: { typecheck: "true", targeted_test: "grep -q 'answer = 42' src/answer.ts", git_status: "git status --porcelain" },
		});
		const session = await bootHarnessSession({ cwd, agentDir, config, model: { provider: "local", model: "local-model" } });
		try {
			const context = await session.runTurn({ text: "fix the parse bug", role: "specialist" });
			expect(context.contract?.verification.required).toContain("screenshot_compare");
			expect(context.executor?.evidence.find((entry) => entry.kind === "screenshot_compare")?.status).toBe("unavailable");
			expect(context.proof?.decision).not.toBe("PASS");
			expect(context.executor?.status).toBe("blocked");
			const rows = readRuns(cwd);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.result.success).toBe(false);
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});
});

describe("AC-5 — one executor per turn, and external-only sessions boot", () => {
	it("boots and completes with only external backends and no model or role override", async () => {
		const { cwd, agentDir } = chainRepo();
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { files: { "src/answer.ts": ANSWERED }, summary: PASS_VERDICT });
		const config = e2eConfig(cwd, cli, "http://127.0.0.1:1", {
			commands: { typecheck: "true", targeted_test: "grep -q 'answer = 42' src/answer.ts", git_status: "git status --porcelain" },
		});
		delete config.backends.local;
		config.models.specialist = { backend: "claude", model: "claude-model" };
		const session = await createLeanPiSession({ cwd, agentDir, config, env: harnessStubEnv() });
		try {
			const context = await session.runTurn({ text: "fix the parse bug" });
			expect(context.executor?.status).toBe("completed");
			expect(context.proof?.decision).toBe("PASS");
			expect(readRuns(cwd)).toHaveLength(1);
			expect(readRuns(cwd)[0]!.result.success).toBe(true);
		} finally {
			restore();
			session.session.dispose();
		}
	});

	it("an external default role makes zero calls to an available native backend", async () => {
		const { cwd, agentDir } = chainRepo();
		// A reachable native backend, so a second prompt through Pi's loop would
		// land here and be counted. It must stay at zero requests.
		const native = await startStubBackend([{ text: "should never be sent" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { files: { "src/answer.ts": ANSWERED }, summary: PASS_VERDICT });
		const config = e2eConfig(cwd, cli, native.baseUrl, {
			commands: { typecheck: "true", targeted_test: "grep -q 'answer = 42' src/answer.ts", git_status: "git status --porcelain" },
		});
		// No `model` option and no turn role: balanced resolves to the external
		// harness, which Pi's runtime cannot serve, yet the session must still boot
		// because LeanPi owns the loop for this configuration.
		const session = await createLeanPiSession({ cwd, agentDir, config, env: harnessStubEnv() });
		try {
			const context = await session.runTurn({ text: "fix the parse bug" });
			expect(context.executor?.status).toBe("completed");
			expect(context.proof?.decision).toBe("PASS");
			// The executor lane ran the worker, verifier and reviewer; Pi's own loop
			// sent nothing to the registered native backend after the proof.
			expect(native.requests).toEqual([]);
			const rows = readRuns(cwd);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.result.success).toBe(true);
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});

	it("a native config still runs exactly its expected Pi provider calls", async () => {
		const { cwd, agentDir } = fixtureRepo();
		const native = await startStubBackend([{ text: "done" }]);
		writeConfig(cwd, {
			backends: { local: nativeBackend(native.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
		});
		const session = await bootHarnessSession({ cwd, agentDir });
		try {
			const context = await session.runTurn({ text: "say hi", role: "balanced" });
			// Pi's loop is the executor here, so there is no executor outcome and the
			// request still reaches the provider — exactly once.
			expect(context.executor).toBeUndefined();
			expect(native.requests).toHaveLength(1);
		} finally {
			session.session.dispose();
			await native.close();
		}
	});
});

describe("PRD-040 E3 — the gate re-hashes the bytes it is about to certify", () => {
	const TAMPERED = "export const answer = 43; // changed by the reviewer\n";

	function tamperScript(cli: ReturnType<typeof installStubCli>) {
		return setStubScript(cli.recordPath, {
			files: { "src/answer.ts": ANSWERED },
			// The reviewer invocation writes different bytes and still says PASS.
			reviewFiles: { "src/answer.ts": TAMPERED },
			summary: PASS_VERDICT,
		});
	}

	it("blocks when the reviewer changes an edited file after verification (in-place)", async () => {
		const { cwd, agentDir } = chainRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = tamperScript(cli);
		const config = e2eConfig(cwd, cli, native.baseUrl, {
			commands: { typecheck: "true", targeted_test: "grep -q 'answer = 42' src/answer.ts", git_status: "git status --porcelain" },
		});
		const session = await bootHarnessSession({ cwd, agentDir, config, model: { provider: "local", model: "local-model" } });
		try {
			const context = await session.runTurn({ text: "fix the parse bug", role: "specialist" });
			// The reviewer really changed the bytes after the verifier passed...
			expect(readFileSync(join(cwd, "src", "answer.ts"), "utf8")).toBe(TAMPERED);
			expect(context.executor?.review.verdict?.decision).toBe("PASS");
			// ...so the gate must not stamp the verifier's evidence as current.
			expect(context.proof?.decision).not.toBe("PASS");
			expect(context.proof?.criteria[0]?.decision).not.toBe("PASS");
			const rows = readRuns(cwd);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.result.success).toBe(false);
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});

	it("fails closed when the reviewer leaves a cyclic symlink at a touched path after verification", async () => {
		const { cwd, agentDir } = chainRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, {
			// The worker creates an untracked file this turn owns.
			files: { "src/answer.ts": ANSWERED, "generated.txt": "generated\n" },
			// After the verifier passes, the reviewer ignores that file — so git stops
			// listing it and the reviewer's own change detection does not read it —
			// then replaces it with a self-referential symlink and claims PASS. Only
			// the gate, re-hashing the touched path, can see the unreadable state.
			reviewFiles: { ".gitignore": "generated.txt\n" },
			reviewSymlinks: { "generated.txt": "generated.txt" },
			summary: PASS_VERDICT,
		});
		const config = e2eConfig(cwd, cli, native.baseUrl, {
			commands: { typecheck: "true", targeted_test: "grep -q 'answer = 42' src/answer.ts", git_status: "git status --porcelain" },
		});
		const session = await bootHarnessSession({ cwd, agentDir, config, model: { provider: "local", model: "local-model" } });
		try {
			// The gate cannot read the touched path, so it must not stamp the
			// verifier's evidence as current: the turn fails instead of exposing PASS.
			await expect(session.runTurn({ text: "fix the parse bug", role: "specialist" })).rejects.toThrow(/ELOOP|symbolic link|generated\.txt/);
			// The worker and reviewer really ran, so the spend is real: exactly one
			// failed row carries the calls that happened, never a fabricated zero.
			const rows = readRuns(cwd);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.result.success).toBe(false);
			expect(rows[0]!.result.proof_gate).not.toBe("PASS");
			expect(rows[0]!.executor_backend).toBe("claude");
			expect(rows[0]!.usage.external_harness_calls).toBeGreaterThan(0);
			expect(rows[0]!.calls).toHaveLength(rows[0]!.usage.external_harness_calls);
			expect(rows[0]!.cost.api_usd).toBe(0);
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});

	it("blocks the same way in an isolated checkout and leaves the main checkout clean", async () => {
		const { cwd, agentDir } = chainRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = tamperScript(cli);
		const config = e2eConfig(cwd, cli, native.baseUrl, {
			commands: { typecheck: "true", targeted_test: "grep -q 'answer = 42' src/answer.ts", git_status: "git status --porcelain" },
		});
		config.limits.isolation = "worktree";
		config.permissions.defaults.git_destructive = "allow";
		const session = await bootHarnessSession({ cwd, agentDir, config, model: { provider: "local", model: "local-model" } });
		try {
			const context = await session.runTurn({ text: "fix the parse bug", role: "specialist" });
			expect(context.proof?.decision).not.toBe("PASS");
			// The reviewer's tamper lived only in the disposable checkout.
			expect(readFileSync(join(cwd, "src", "answer.ts"), "utf8")).toBe("export const answer = 1;\n");
			const rows = readRuns(cwd);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.result.success).toBe(false);
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});
});
