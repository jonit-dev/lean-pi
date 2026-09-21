/**
 * PRD-008 Phase 4 — E4: AC-8 (vendor limits cooldown, fallback, honest blocked
 * outcome) plus AC-9, the owner-gated real-subscription smoke run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackendRegistry, runWorkerTurn, type BackendInvocation } from "../../src/backends/index.js";
import { clearLanes, loadConfig, registerTurnLanes, runTurn } from "../../src/index.js";
import { setCompilerContext } from "../../src/compiler/index.js";
import { REVIEW_LEVEL_QUESTION_ID, REVIEW_LEVEL_SITE_ID } from "../../src/review/gate.js";
import { fixtureRepo, writeConfig } from "../helpers/fixtures.js";
import { choice, fakeExec, scriptedJev, VERIFY_COMMANDS } from "../executor/helpers.js";
import { installStubCli, setStubScript, type StubCli } from "./helpers.js";

function chainConfig(cli: StubCli) {
	return {
		backends: {
			codex: { type: "external_harness", command: cli.bin.codex, roles: ["strong"], priority: 20, quota_class: "premium" },
			opencode: { type: "external_harness", command: cli.bin.opencode, roles: ["strong"], priority: 10, quota_class: "low-cost" },
		},
		models: { strong: { backend: "codex", model: "strong" } },
	};
}

describe("PRD-008 Phase 4 — vendor limits, fallback and the cost hook", () => {
	it("AC-8: a rate-limited backend is not re-invoked, and the turn finishes on the next backend", async () => {
		const cli = installStubCli();
		const { cwd } = fixtureRepo();
		writeConfig(cwd, chainConfig(cli));
		const records: BackendInvocation[] = [];
		const registry = new BackendRegistry(loadConfig(cwd), { onInvocation: (record) => records.push(record) });

		const restore = setStubScript(cli.recordPath, {
			modes: { codex: "rate-limit" },
			files: { "task.txt": "opencode did it\n" },
			summary: "opencode finished",
		});
		const first = await runWorkerTurn({ objective: "create task.txt", role: "strong", files: ["task.txt"] }, { registry, cwd });
		restore();
		// A second turn during the cooldown must not probe the limited backend again.
		const restoreSecond = setStubScript(cli.recordPath, {
			modes: { codex: "rate-limit" },
			files: { "task-2.txt": "opencode did it again\n" },
			summary: "opencode finished again",
		});
		const second = await runWorkerTurn({ objective: "create task-2.txt", role: "strong", files: ["task-2.txt"] }, { registry, cwd });
		restoreSecond();

		expect(first.status).toBe("completed");
		expect(first.backend).toBe("opencode");
		expect(readFileSync(join(cwd, "task.txt"), "utf8")).toBe("opencode did it\n");
		expect(first.attempts).toHaveLength(1);
		expect(first.attempts[0]).toMatchObject({ backend: "codex", failure: "limit" });
		expect(first.attempts[0]!.reason).toMatch(/usage limit/i);

		// Exactly one invocation of the limited backend across both turns.
		expect(cli.records().filter((record) => record.vendor === "codex")).toHaveLength(1);
		expect(cli.records().filter((record) => record.vendor === "opencode")).toHaveLength(2);
		expect(second.status).toBe("completed");
		expect(second.backend).toBe("opencode");

		// The limit is visible in the pool state and in the emitted records.
		expect(registry.isCooling("codex")).toBe(true);
		expect(registry.cooldownOf("codex")!.reason).toMatch(/usage limit/i);
		expect(records.map((record) => [record.backend, record.billing, record.quotaClass])).toEqual([
			["codex", "subscription", "premium"],
			["opencode", "subscription", "low-cost"],
			["opencode", "subscription", "low-cost"],
		]);
		expect(records[0]!.exitCode).not.toBe(0);
	});

	it("AC-8: a cooldown expires instead of disabling the backend forever", async () => {
		const cli = installStubCli();
		const { cwd } = fixtureRepo();
		writeConfig(cwd, chainConfig(cli));
		let clock = 0;
		const registry = new BackendRegistry(loadConfig(cwd), { cooldownMs: 1_000, now: () => clock });
		const restore = setStubScript(cli.recordPath, { modes: { codex: "rate-limit" }, files: { "task.txt": "first\n" } });
		const first = await runWorkerTurn({ objective: "create task.txt", role: "strong", files: ["task.txt"] }, { registry, cwd, now: () => clock });
		restore();
		const limited = registry.cooldownOf("codex");
		expect(first.backend).toBe("opencode");
		expect(limited).not.toBeNull();

		clock = limited!.until;
		expect(registry.isCooling("codex")).toBe(false);
		expect(registry.selectBackend("strong")[0]!.name).toBe("codex");
	});

	// Drives the real turn lane end to end, which on a bare `$HOME` — a clean CI
	// runner — reaches no vendor at all and records nothing to assert on.
	// Skipped unless asked for; `pnpm test` on a developer machine runs it.
	const realHome = process.env.LEANPI_REAL_HOME === "1" ? it : it.skip;
	realHome("AC-8: the executor lane keeps one pool across turns, so a limited vendor is asked once per session", async () => {
		// The cooldown lives in the `BackendRegistry` the lane holds. The lane used
		// to build one per turn, which emptied the cooldown map between turns and
		// made every later turn pay the limited vendor's failure again — the cost
		// the cooldown exists to remove. This drives the real lane, not a
		// hand-held registry, because that is where the lifetime is decided.
		const cli = installStubCli();
		const { cwd } = fixtureRepo();
		// Every role on the same two-backend chain: the compiler picks the class,
		// and a class with no backend would block before any vendor is spawned.
		const roles = ["quick", "balanced", "strong"];
		writeConfig(cwd, {
			backends: {
				codex: { type: "external_harness", command: cli.bin.codex, roles, priority: 20, quota_class: "premium" },
				opencode: { type: "external_harness", command: cli.bin.opencode, roles, priority: 10, quota_class: "low-cost" },
			},
			models: Object.fromEntries(roles.map((role) => [role, { backend: "codex", model: "strong" }])),
		});
		const config = loadConfig(cwd);
		clearLanes();
		setCompilerContext({ config, cwd });
		registerTurnLanes({
			cwd,
			config,
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
			jev: scriptedJev({ [REVIEW_LEVEL_SITE_ID]: () => choice(REVIEW_LEVEL_QUESTION_ID, "NO_SEMANTIC_REVIEW") }),
		});

		const restore = setStubScript(cli.recordPath, { modes: { codex: "rate-limit" }, files: { "one.txt": "opencode did it\n" } });
		await runTurn({ text: "create one.txt with a line of text" }, { config, cwd });
		const restoreSecond = setStubScript(cli.recordPath, { modes: { codex: "rate-limit" }, files: { "two.txt": "opencode did it again\n" } });
		await runTurn({ text: "create two.txt with a line of text" }, { config, cwd });
		restore();
		restoreSecond();
		clearLanes();

		// Two turns, one probe of the limited vendor.
		expect(cli.records().filter((record) => record.vendor === "codex")).toHaveLength(1);
		expect(cli.records().filter((record) => record.vendor === "opencode").length).toBeGreaterThanOrEqual(2);
	});

	it("AC-8: a backend that hangs is cooled down too, so the wait is paid once", async () => {
		// The turn ceiling is there to bound one attempt, not to be paid on every
		// turn of a session: with an exhausted plan quota `opencode run` accepts
		// the request and never answers, and before this the next turn queued up
		// behind the same ceiling again.
		const cli = installStubCli();
		const { cwd } = fixtureRepo();
		writeConfig(cwd, chainConfig(cli));
		const registry = new BackendRegistry(loadConfig(cwd));

		const restore = setStubScript(cli.recordPath, { modes: { codex: "hang" }, files: { "task.txt": "opencode did it\n" }, summary: "opencode finished" });
		const first = await runWorkerTurn({ objective: "create task.txt", role: "strong", files: ["task.txt"] }, { registry, cwd, timeoutMs: 250 });
		restore();
		const restoreSecond = setStubScript(cli.recordPath, {
			modes: { codex: "hang" },
			files: { "task-2.txt": "opencode did it again\n" },
			summary: "opencode finished again",
		});
		const second = await runWorkerTurn({ objective: "create task-2.txt", role: "strong", files: ["task-2.txt"] }, { registry, cwd, timeoutMs: 250 });
		restoreSecond();

		expect(first.attempts[0]).toMatchObject({ backend: "codex", failure: "timeout" });
		expect(first.status).toBe("completed");
		expect(second.status).toBe("completed");
		expect(registry.isCooling("codex")).toBe(true);
		// One hang for the session, not one per turn.
		expect(cli.records().filter((record) => record.vendor === "codex")).toHaveLength(1);
	});

	it("AC-8: exhausting the chain ends blocked with every backend's reason, never a fabricated success", async () => {
		const cli = installStubCli();
		const { cwd } = fixtureRepo();
		writeConfig(cwd, chainConfig(cli));
		const records: BackendInvocation[] = [];
		const registry = new BackendRegistry(loadConfig(cwd), { onInvocation: (record) => records.push(record) });

		const restore = setStubScript(cli.recordPath, {
			modes: { codex: "rate-limit", opencode: "error" },
			files: { "task.txt": "should never be written\n" },
		});
		const outcome = await runWorkerTurn(
			{ objective: "create task.txt", role: "strong", files: ["task.txt"], outputSchema: { type: "object" } },
			{ registry, cwd },
		);
		restore();

		expect(outcome.status).toBe("blocked");
		expect(outcome.result).toBeUndefined();
		expect(outcome.backend).toBeUndefined();
		expect(outcome.attempts.map((attempt) => [attempt.backend, attempt.failure])).toEqual([
			["codex", "limit"],
			["opencode", "exit"],
		]);
		for (const attempt of outcome.attempts) expect(attempt.reason.length).toBeGreaterThan(0);
		// No workspace change was claimed or produced.
		expect(existsSync(join(cwd, "task.txt"))).toBe(false);
		// Both invocations were still recorded — failures are facts too.
		expect(records.map((record) => record.backend)).toEqual(["codex", "opencode"]);
	});

	it("F11: a vendor that answers without touching a file succeeds, and its answer survives", async () => {
		const cli = installStubCli();
		const { cwd } = fixtureRepo();
		writeConfig(cwd, chainConfig(cli));
		const records: BackendInvocation[] = [];
		const registry = new BackendRegistry(loadConfig(cwd), { onInvocation: (record) => records.push(record) });

		const restore = setStubScript(cli.recordPath, {
			modes: {},
			files: {},
			summary: "the function memoizes its argument",
		});
		// A question, not a patch: nothing in the workspace should move, and the
		// answer is the whole deliverable.
		const outcome = await runWorkerTurn({ objective: "explain task.txt", role: "strong", files: ["task.txt"] }, { registry, cwd });
		restore();

		expect(outcome.status).toBe("completed");
		expect(outcome.attempts).toEqual([]);
		expect(outcome.result?.changedFiles).toEqual([]);
		expect(outcome.result?.summary).toContain("the function memoizes its argument");
		// One provider answered it; the chain never paid a second one.
		expect(records).toHaveLength(1);
	});
});

/**
 * AC-9 is the one criterion a stub cannot establish: that the argv LeanPi
 * composes is accepted by the real vendor binary. It is implemented here and
 * skipped unless joao opts in, e.g.
 *   LEANPI_SUBSCRIPTION_SMOKE=claude npx vitest run tests/backends/fallback.spec.ts
 */
const SMOKE_VENDOR = process.env.LEANPI_SUBSCRIPTION_SMOKE;

describe.skipIf(!SMOKE_VENDOR)("PRD-008 AC-9 — owner-gated real subscription smoke run", () => {
	it("runs one single-file edit through the real vendor CLI", async () => {
		const vendor = SMOKE_VENDOR as "claude" | "codex" | "opencode";
		const { cwd } = fixtureRepo();
		writeConfig(cwd, {
			backends: { [vendor]: { type: "external_harness", command: vendor, roles: ["strong"] } },
			models: { strong: { backend: vendor, model: process.env.LEANPI_SMOKE_MODEL ?? "default" } },
		});
		const registry = new BackendRegistry(loadConfig(cwd));
		const outcome = await runWorkerTurn(
			{
				objective: "Create the file smoke.txt whose only content is the line: leanpi smoke ok",
				role: "strong",
				files: ["smoke.txt"],
				budget: 4,
			},
			{ registry, cwd, timeoutMs: 600_000 },
		);

		expect(outcome.status).toBe("completed");
		expect(outcome.result?.changedFiles).toEqual(["smoke.txt"]);
		expect(readFileSync(join(cwd, "smoke.txt"), "utf8")).toContain("leanpi smoke ok");
	}, 900_000);
});
