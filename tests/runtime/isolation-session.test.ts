/**
 * PRD-022 AC-6/AC-9 through the real session — config triggers isolation, the
 * main checkout is untouched, the patch is persisted and no worktree remains.
 *
 * The executor is the real stub vendor CLI, the verifier runs a real command
 * against the edited content, and the reviewer is the same stub's verdict; only
 * the vendor transport is fake. The isolation seam wraps execution, verification
 * and the proof gate together, so the evidence is stamped with the isolated
 * tree's hash and never a reclaimed one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { readRuns } from "../../src/index.js";
import { renderTurnOutcome } from "../../src/cli/outcome.js";
import { resolvedDefaults } from "../../src/permissions/trust.js";
import { bootSession, fixtureRepo, gitCommitAll, gitInit, nativeBackend } from "../helpers/fixtures.js";
import { startStubBackend } from "../helpers/stub-backend.js";
import { installStubCli, setStubScript } from "../backends/helpers.js";

const PASS_VERDICT = JSON.stringify({ decision: "PASS", findings: [] });

function sessionConfig(cwd: string, cli: ReturnType<typeof installStubCli>, nativeBaseUrl: string, isolation: "none" | "worktree", allowGit: boolean) {
	const permissions = resolvedDefaults();
	if (allowGit) permissions.defaults.git_destructive = "allow";
	return loadConfig(cwd, {
		configPath: null,
		backends: {
			claude: { type: "external_harness", command: cli.bin.claude, roles: ["quick", "balanced", "strong", "review_quick", "review_strong"] },
			// A native role only so the Pi session has a registered model to boot
			// on; the executor roles stay external so LeanPi owns the loop.
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
		verify: { commands: { typecheck: "true", targeted_test: "grep -q 'version = 2' src/app.ts", git_status: "git status --porcelain" } },
		limits: { executionAttempts: 2, semanticReviewRounds: 1, isolation },
		permissions,
	});
}

/** A repo with a committed test file, then a dirty edit to name AC-1's surface. */
function isolationRepo(): { cwd: string; agentDir: string } {
	const { cwd, agentDir } = fixtureRepo();
	execFileSync("mkdir", ["-p", join(cwd, "src"), join(cwd, "tests")]);
	writeFileSync(join(cwd, "src", "app.ts"), "export const version = 1;\n");
	writeFileSync(join(cwd, "tests", "parse.spec.ts"), "it('parses', () => {});\n");
	gitInit(cwd);
	gitCommitAll(cwd);
	// Dirty only in the main checkout; the worktree starts from HEAD.
	writeFileSync(join(cwd, "tests", "parse.spec.ts"), "it('parses', () => expect(1).toBe(1));\n");
	return { cwd, agentDir };
}

describe("PRD-022 — isolation through the real session", () => {
	it("runs executor, verifier and gate in an owned worktree, persists the patch and reclaims it", async () => {
		const { cwd, agentDir } = isolationRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { files: { "src/app.ts": "export const version = 2;\n" }, summary: PASS_VERDICT });
		const config = sessionConfig(cwd, cli, native.baseUrl, "worktree", true);
		const session = await bootSession({ cwd, agentDir, config, model: { provider: "local", model: "local-model" } });
		try {
			const context = await session.runTurn({ text: "fix the parse bug", role: "specialist" });
			expect(context.contract?.task.execution_complexity).toBe("MEDIUM");
			expect(context.contract?.limits.isolation).toBe("worktree");

			// The isolated run is surfaced on the turn outcome with an explicit patch.
			expect(context.isolation?.runId).toBeDefined();
			expect(context.isolation?.removed).toBe(true);
			const patchPath = context.isolation?.patchPath;
			expect(patchPath).toBeDefined();
			expect(existsSync(patchPath!)).toBe(true);
			expect(JSON.parse(readFileSync(patchPath!, "utf8")).diff).toContain("+export const version = 2;");
			// The tracked diff is persisted in a form the operator can apply by hand,
			// and the turn outcome says so instead of auto-applying.
			expect(context.isolation?.diffPath).toBeDefined();
			expect(readFileSync(context.isolation!.diffPath!, "utf8")).toContain("+export const version = 2;");
			expect(renderTurnOutcome(context)).toContain("isolated");

			// The main checkout is exactly as the user left it.
			expect(readFileSync(join(cwd, "src", "app.ts"), "utf8")).toBe("export const version = 1;\n");
			expect(readFileSync(join(cwd, "tests", "parse.spec.ts"), "utf8")).toBe("it('parses', () => expect(1).toBe(1));\n");

			// No registered or physical worktree remains.
			const registered = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" })
				.split("\n")
				.filter((line) => line.startsWith("worktree "))
				.map((line) => line.slice("worktree ".length));
			expect(registered).toEqual([cwd]);
			const runRoot = join(cwd, ".worktrees");
			expect(existsSync(runRoot) ? readdirSync(runRoot) : []).toEqual([]);

			// The gate ran in the worktree and passed on the real verifier's evidence.
			expect(context.executor?.status).toBe("completed");
			expect(context.proof?.decision).toBe("PASS");
			expect(context.executor?.workspaceHash).toBeDefined();

			// One persisted telemetry row for the isolated run.
			const rows = readRuns(cwd);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.result.success).toBe(true);
			expect(rows[0]!.executor_backend).toBe("claude");
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});

	it("refuses under DENY before creating any worktree", async () => {
		const { cwd, agentDir } = isolationRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { files: { "src/app.ts": "export const version = 2;\n" }, summary: PASS_VERDICT });
		const config = sessionConfig(cwd, cli, native.baseUrl, "worktree", false);
		const session = await bootSession({ cwd, agentDir, config, model: { provider: "local", model: "local-model" } });
		try {
			await expect(session.runTurn({ text: "fix the parse bug", role: "specialist" })).rejects.toThrow(/git_destructive/);
			expect(existsSync(join(cwd, ".worktrees"))).toBe(false);
			expect(readFileSync(join(cwd, "src", "app.ts"), "utf8")).toBe("export const version = 1;\n");
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});
});

describe("PRD-040 D — the host confirm channel reaches an ask-posture worktree", () => {
	/** An `ask` posture: the engine must consult the host's confirm before creating anything. */
	function askConfig(cwd: string, cli: ReturnType<typeof installStubCli>, nativeBaseUrl: string) {
		const config = sessionConfig(cwd, cli, nativeBaseUrl, "worktree", false);
		config.permissions.defaults.git_destructive = "ask";
		return config;
	}

	it("creates the worktree only after the host approves", async () => {
		const { cwd, agentDir } = isolationRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { files: { "src/app.ts": "export const version = 2;\n" }, summary: PASS_VERDICT });
		const calls: unknown[] = [];
		const session = await bootSession({
			cwd,
			agentDir,
			config: askConfig(cwd, cli, native.baseUrl),
			model: { provider: "local", model: "local-model" },
			worktreeConfirm: (request) => {
				calls.push(request);
				return true;
			},
		});
		try {
			const context = await session.runTurn({ text: "fix the parse bug", role: "specialist" });
			expect(calls).toHaveLength(1);
			expect(context.isolation?.runId).toBeDefined();
			expect(context.isolation?.removed).toBe(true);
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});

	it("declines an ask posture and creates no directory", async () => {
		const { cwd, agentDir } = isolationRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { files: { "src/app.ts": "export const version = 2;\n" }, summary: PASS_VERDICT });
		const session = await bootSession({
			cwd,
			agentDir,
			config: askConfig(cwd, cli, native.baseUrl),
			model: { provider: "local", model: "local-model" },
			worktreeConfirm: () => false,
		});
		try {
			await expect(session.runTurn({ text: "fix the parse bug", role: "specialist" })).rejects.toThrow(/declined|confirmation|refused/i);
			expect(existsSync(join(cwd, ".worktrees"))).toBe(false);
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});

	it("never calls the host confirm under DENY", async () => {
		const { cwd, agentDir } = isolationRepo();
		const native = await startStubBackend([{ text: "ok" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { files: { "src/app.ts": "export const version = 2;\n" }, summary: PASS_VERDICT });
		const confirm = vi.fn(() => true);
		const session = await bootSession({
			cwd,
			agentDir,
			config: sessionConfig(cwd, cli, native.baseUrl, "worktree", false),
			model: { provider: "local", model: "local-model" },
			worktreeConfirm: confirm,
		});
		try {
			await expect(session.runTurn({ text: "fix the parse bug", role: "specialist" })).rejects.toThrow(/git_destructive/);
			expect(confirm).not.toHaveBeenCalled();
		} finally {
			restore();
			session.session.dispose();
			await native.close();
		}
	});
});
