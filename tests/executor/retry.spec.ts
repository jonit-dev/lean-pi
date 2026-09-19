/**
 * PRD-007 Phase 3 and Phase 4 — AC-5..AC-9: the bounded retry state machine,
 * the hard attempt ceiling, the escalation gate and the two retry-loop sites.
 *
 * Every case here is driven through the public `runExecutor` entry, so the
 * counters asserted are the ones a real turn spends.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerTurnOutcome } from "../../src/backends/worker.js";
import {
	CLARIFICATION_SITE_ID,
	ESCALATION_SITE_ID,
	FAILURE_SITE_ID,
	failureSignature,
	nextAttempt,
	RETRY_SITE_ID,
	RETRY_USEFULNESS_THRESHOLD,
	runExecutor,
	type RetryBudget,
	type RetryRecord,
} from "../../src/executor/index.js";
import type { ExecutorWorker } from "../../src/executor/lane.js";
import type { ExecutionContract } from "../../src/compiler/contract.js";
import { REVIEW_LEVEL_QUESTION_ID, REVIEW_LEVEL_SITE_ID } from "../../src/review/gate.js";
import { choice, fakeExec, harness, multiBackendConfig, quickContract, score, scriptedJev, VERIFY_COMMANDS, type ExecHarness } from "./helpers.js";

const open: ExecHarness[] = [];

afterEach(async () => {
	while (open.length > 0) await open.pop()?.close();
});

async function fixture(configFactory?: (cwd: string) => ReturnType<typeof multiBackendConfig>): Promise<ExecHarness> {
	const h = configFactory ? await harness({ config: configFactory }) : await harness();
	open.push(h);
	return h;
}

/** A contract with explicit budgets, so each case states the ceiling it asserts. */
async function contractWith(h: ExecHarness, limits: { attempts: number; escalations: number }, request = "fix the failing check"): Promise<ExecutionContract> {
	const base = await quickContract(h, request);
	return {
		...base,
		task: { ...base.task, prd_required: false, execution_complexity: "LOW", review_risk: "R0" },
		routing: { ...base.routing, executor_class: "quick", reviewer_class: "none" },
		verification: { required: ["typecheck", "affected_tests"] },
		limits: { ...base.limits, execution_attempts: limits.attempts, max_escalations: limits.escalations },
	};
}

/** A worker that always edits, so every attempt reaches the verifiers. */
function editingWorker(cwd: string, backends: readonly string[] = ["local"]): { worker: ExecutorWorker; backendsUsed: string[] } {
	const backendsUsed: string[] = [];
	return {
		backendsUsed,
		worker: async (_packet, options) => {
			const excluded = new Set(options.exclude ?? []);
			const backend = backends.find((name) => !excluded.has(name));
			if (!backend) return { status: "blocked", attempts: [{ backend: "none", failure: "exit", reason: "every backend is excluded" }] } satisfies WorkerTurnOutcome;
			backendsUsed.push(backend);
			writeFileSync(join(cwd, "src", "target.ts"), `export const value = ${backendsUsed.length + 1};\n`);
			return { status: "completed", backend, result: { status: "ok", changedFiles: ["src/target.ts"], summary: "edited" }, attempts: [] };
		},
	};
}

describe("PRD-007 Phase 3 — the failure signature", () => {
	it("AC-5: same cause with different paths and line numbers collides; a different cause does not", () => {
		const a = failureSignature({ kind: "typecheck", detail: "/tmp/leanpi-a1/src/target.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'." });
		const b = failureSignature({ kind: "typecheck", detail: "/home/joao/work/src/target.ts:88:19 - error TS2322: Type 'string' is not assignable to type 'number'." });
		const c = failureSignature({ kind: "typecheck", detail: "/tmp/leanpi-a1/src/target.ts:12:5 - error TS2551: Property 'parseFoo' does not exist." });
		const d = failureSignature({ kind: "targeted_test", detail: "/tmp/leanpi-a1/src/target.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'." });
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).not.toBe(d);
	});

	it("AC-5: the policy rejects a bare repeat, retries on new evidence and reassesses on a new failure", () => {
		const budget: RetryBudget = { attemptsUsed: 1, executionAttempts: 4, escalationsUsed: 0, maxEscalations: 0 };
		const failure = { kind: "typecheck", detail: "error TS2322 at src/target.ts:1:1" };
		const history: RetryRecord[] = [{ attempt: 1, strategy: "same", failureSignature: failureSignature(failure), newEvidence: false, model: "quick", backend: "local" }];

		// No escalation budget: the repeat has nowhere to go but `reject`.
		expect(nextAttempt(history, failure, budget)).toBe("reject");
		expect(nextAttempt(history, { ...failure, newEvidence: true }, budget)).toBe("retry");
		expect(nextAttempt(history, { kind: "targeted_test", detail: "expected 3 to be 4" }, budget)).toBe("retry");
		// With escalation budget, the repeat goes to the gate rather than looping.
		expect(nextAttempt(history, failure, { ...budget, maxEscalations: 1 })).toBe("escalate");
		// The ceiling outranks everything.
		expect(nextAttempt(history, { ...failure, newEvidence: true }, { ...budget, attemptsUsed: 4, maxEscalations: 4 })).toBe("reject");
	});
});

describe("PRD-007 Phase 3 — the hard attempt ceiling", () => {
	it("AC-6: an adversarial SWITCH_BACKEND stub spends the budget exactly and ends blocked", async () => {
		const h = await fixture(multiBackendConfig);
		// Five enabled backends would be available; the budget is three.
		const contract = await contractWith(h, { attempts: 3, escalations: 9 });
		const jev = scriptedJev({
			[ESCALATION_SITE_ID]: () => choice("escalation_category", "SWITCH_BACKEND"),
			[FAILURE_SITE_ID]: () => choice("failure_category", "likely_logic_bug"),
			[RETRY_SITE_ID]: () => score("retry_useful", RETRY_USEFULNESS_THRESHOLD + 1),
		});
		const { worker, backendsUsed } = editingWorker(h.cwd, ["first", "second", "third"]);

		const outcome = await runExecutor(contract, {
			registry: h.registry,
			cwd: h.cwd,
			config: h.config,
			store: h.store,
			artifacts: h.artifacts,
			jev,
			worker,
			exec: fakeExec({ pass: false }),
			verifyCommands: VERIFY_COMMANDS,
		});

		expect(outcome.status).toBe("blocked");
		expect(outcome.invocations).toHaveLength(3);
		expect(backendsUsed).toHaveLength(3);
		// Every attempt was spent, and no escalation bought a fourth.
		expect(outcome.escalations.length).toBeGreaterThan(0);
		expect(outcome.escalations.every((category) => category === "SWITCH_BACKEND")).toBe(true);
		expect(new Set(backendsUsed).size).toBeGreaterThan(1);
	});

	it("AC-6: with max_escalations below the attempt budget the escalation cap binds first", async () => {
		const h = await fixture(multiBackendConfig);
		const contract = await contractWith(h, { attempts: 6, escalations: 1 });
		const jev = scriptedJev({
			[ESCALATION_SITE_ID]: () => choice("escalation_category", "SWITCH_BACKEND"),
			[FAILURE_SITE_ID]: () => choice("failure_category", "likely_logic_bug"),
			[RETRY_SITE_ID]: () => score("retry_useful", RETRY_USEFULNESS_THRESHOLD + 1),
		});
		const { worker } = editingWorker(h.cwd, ["first", "second", "third"]);

		const outcome = await runExecutor(contract, {
			registry: h.registry,
			cwd: h.cwd,
			config: h.config,
			store: h.store,
			artifacts: h.artifacts,
			jev,
			worker,
			exec: fakeExec({ pass: false }),
			verifyCommands: VERIFY_COMMANDS,
		});

		expect(outcome.status).toBe("blocked");
		expect(outcome.escalations).toHaveLength(1);
		// The binding bound is visible: fewer invocations than the attempt budget.
		expect(outcome.invocations.length).toBeLessThan(6);
		expect(outcome.retryHistory.some((row) => row.strategy === "escalate")).toBe(true);
	});
});

describe("PRD-007 Phase 4 — the escalation gate", () => {
	it("AC-7: a classified SWITCH_BACKEND runs the next backend; STOP_BLOCKED ends the turn", async () => {
		const h = await fixture(multiBackendConfig);
		const contract = await contractWith(h, { attempts: 4, escalations: 3 });
		const jev = scriptedJev({
			[ESCALATION_SITE_ID]: (index) => choice("escalation_category", index === 0 ? "SWITCH_BACKEND" : "STOP_BLOCKED"),
			[FAILURE_SITE_ID]: () => choice("failure_category", "likely_logic_bug"),
			[RETRY_SITE_ID]: () => score("retry_useful", RETRY_USEFULNESS_THRESHOLD + 1),
		});
		const { worker, backendsUsed } = editingWorker(h.cwd, ["first", "second", "third"]);

		const outcome = await runExecutor(contract, {
			registry: h.registry,
			cwd: h.cwd,
			config: h.config,
			store: h.store,
			artifacts: h.artifacts,
			jev,
			worker,
			exec: fakeExec({ pass: false }),
			verifyCommands: VERIFY_COMMANDS,
		});

		// The first failure retries (§33 reassesses before it escalates); the repeat
		// goes to the gate, whose SWITCH_BACKEND moves the next attempt off `first`.
		expect(outcome.escalations).toEqual(["SWITCH_BACKEND", "STOP_BLOCKED"]);
		expect(backendsUsed).toEqual(["first", "first", "second"]);
		expect(outcome.status).toBe("blocked");
		expect(outcome.blockedReason).toContain("no further attempt is justified");
		// A blocked turn keeps the evidence it did collect.
		expect(outcome.evidence.length).toBeGreaterThan(0);
	});

	it("AC-7: a JEV client that throws still terminates through the deterministic ladder", async () => {
		const h = await fixture(multiBackendConfig);
		const contract = await contractWith(h, { attempts: 4, escalations: 3 });
		const jev = scriptedJev({}, { throwOn: [ESCALATION_SITE_ID, FAILURE_SITE_ID, RETRY_SITE_ID, CLARIFICATION_SITE_ID, REVIEW_LEVEL_SITE_ID] });
		const { worker } = editingWorker(h.cwd, ["first", "second", "third"]);

		const outcome = await runExecutor(contract, {
			registry: h.registry,
			cwd: h.cwd,
			config: h.config,
			store: h.store,
			artifacts: h.artifacts,
			jev,
			worker,
			exec: fakeExec({ pass: false }),
			verifyCommands: VERIFY_COMMANDS,
		});

		expect(outcome.status).toBe("blocked");
		// The ladder: one SWITCH_MODEL, then STOP_BLOCKED.
		expect(outcome.escalations).toEqual(["SWITCH_MODEL", "STOP_BLOCKED"]);
		expect(outcome.sites.filter((row) => row.site === ESCALATION_SITE_ID).every((row) => row.fallbackUsed)).toBe(true);
	});

	it("AC-8: SWITCH_MODEL advances quick → balanced → strong out of the same attempt total", async () => {
		const h = await fixture(multiBackendConfig);
		const contract = await contractWith(h, { attempts: 4, escalations: 3 });
		const jev = scriptedJev({
			[ESCALATION_SITE_ID]: () => choice("escalation_category", "SWITCH_MODEL"),
			[FAILURE_SITE_ID]: () => choice("failure_category", "likely_logic_bug"),
			[RETRY_SITE_ID]: () => score("retry_useful", RETRY_USEFULNESS_THRESHOLD + 1),
		});
		const { worker } = editingWorker(h.cwd, ["first", "second", "third"]);

		const outcome = await runExecutor(contract, {
			registry: h.registry,
			cwd: h.cwd,
			config: h.config,
			store: h.store,
			artifacts: h.artifacts,
			jev,
			worker,
			exec: fakeExec({ pass: false }),
			verifyCommands: VERIFY_COMMANDS,
		});

		expect(outcome.invocations.map((row) => row.role)).toEqual(["quick", "quick", "balanced", "strong"]);
		// AC-6's counter and AC-8's ladder read one total, not two.
		expect(outcome.invocations).toHaveLength(contract.limits.execution_attempts);
		// The gate appends no row of its own: the escalated attempts carry it.
		expect(outcome.retryHistory.filter((row) => row.strategy === "escalate").map((row) => row.model)).toEqual(["balanced", "strong"]);
	});
});

describe("PRD-007 Phase 3 — the retry-loop decision sites", () => {
	it("AC-9: an `environment` classification takes a different strategy than `likely_logic_bug`", async () => {
		const build = async (category: string) => {
			const h = await fixture(multiBackendConfig);
			const contract = await contractWith(h, { attempts: 2, escalations: 0 });
			const jev = scriptedJev({
				[FAILURE_SITE_ID]: () => choice("failure_category", category),
				[RETRY_SITE_ID]: () => score("retry_useful", RETRY_USEFULNESS_THRESHOLD + 1),
				[REVIEW_LEVEL_SITE_ID]: () => choice(REVIEW_LEVEL_QUESTION_ID, "NO_SEMANTIC_REVIEW"),
			});
			const { worker, backendsUsed } = editingWorker(h.cwd, ["first", "second", "third"]);
			const outcome = await runExecutor(contract, {
				registry: h.registry,
				cwd: h.cwd,
				config: h.config,
				store: h.store,
				artifacts: h.artifacts,
				jev,
				worker,
				// A new failure each attempt, so the policy stays on `retry`.
				exec: async (command) => ({
					command,
					exitCode: command.includes("git") ? 0 : 1,
					stdout: "",
					stderr: command.includes("git") ? "" : `failure ${backendsUsed.length}`,
					timedOut: false,
					spawnError: null,
				}),
				verifyCommands: VERIFY_COMMANDS,
			});
			return { outcome, backendsUsed };
		};

		const environment = await build("environment");
		const logic = await build("likely_logic_bug");

		expect(environment.outcome.invocations.map((row) => row.strategy)).not.toEqual(logic.outcome.invocations.map((row) => row.strategy));
		// `environment` blames the host it ran on, so the next attempt leaves it.
		expect(new Set(environment.backendsUsed).size).toBe(2);
		expect(new Set(logic.backendsUsed).size).toBe(1);
	});

	it("AC-9: a retry_usefulness score below threshold ends the turn before the ceiling", async () => {
		const h = await fixture(multiBackendConfig);
		const contract = await contractWith(h, { attempts: 5, escalations: 0 });
		const jev = scriptedJev({
			[FAILURE_SITE_ID]: () => choice("failure_category", "assertion"),
			[RETRY_SITE_ID]: () => score("retry_useful", RETRY_USEFULNESS_THRESHOLD - 1),
		});
		let attempts = 0;
		const worker: ExecutorWorker = async () => {
			attempts += 1;
			writeFileSync(join(h.cwd, "src", "target.ts"), `export const value = ${attempts + 1};\n`);
			return { status: "completed", backend: "first", result: { status: "ok", changedFiles: ["src/target.ts"], summary: "edited" }, attempts: [] };
		};

		const outcome = await runExecutor(contract, {
			registry: h.registry,
			cwd: h.cwd,
			config: h.config,
			store: h.store,
			artifacts: h.artifacts,
			jev,
			worker,
			exec: async (command) => ({ command, exitCode: command.includes("git") ? 0 : 1, stdout: "", stderr: `failure ${attempts}`, timedOut: false, spawnError: null }),
			verifyCommands: VERIFY_COMMANDS,
		});

		expect(outcome.status).toBe("blocked");
		expect(outcome.blockedReason).toContain("unlikely to change the outcome");
		expect(attempts).toBe(1);
		expect(attempts).toBeLessThan(contract.limits.execution_attempts);
	});

	it("AC-9: with JEV absent the same turns terminate and every site row reports fallbackUsed", async () => {
		const h = await fixture(multiBackendConfig);
		const contract = await contractWith(h, { attempts: 3, escalations: 1 });
		let attempts = 0;
		const worker: ExecutorWorker = async () => {
			attempts += 1;
			writeFileSync(join(h.cwd, "src", "target.ts"), `export const value = ${attempts + 1};\n`);
			return { status: "completed", backend: "first", result: { status: "ok", changedFiles: ["src/target.ts"], summary: "edited" }, attempts: [] };
		};

		const outcome = await runExecutor(contract, {
			registry: h.registry,
			cwd: h.cwd,
			config: h.config,
			store: h.store,
			artifacts: h.artifacts,
			worker,
			exec: async (command) => ({ command, exitCode: command.includes("git") ? 0 : 1, stdout: "", stderr: `failure ${attempts}`, timedOut: false, spawnError: null }),
			verifyCommands: VERIFY_COMMANDS,
		});

		expect(outcome.status).toBe("blocked");
		expect(outcome.sites.length).toBeGreaterThan(0);
		expect(outcome.sites.every((row) => row.fallbackUsed)).toBe(true);
		expect(attempts).toBeLessThanOrEqual(contract.limits.execution_attempts);
	});
});
