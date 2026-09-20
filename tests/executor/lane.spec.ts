/**
 * PRD-007 Phase 1 and Phase 2 — AC-1..AC-4: packet isolation, the reachable
 * consumer, the §29 quick path, and the review decision being PRD-011's.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerTaskPacket, WorkerTurnOutcome } from "../../src/backends/worker.js";
import { EXECUTOR_TASK_KEYS, runExecutor, toExecutorTask } from "../../src/executor/index.js";
import type { ExecutorDeps, ExecutorOutcome, ExecutorWorker } from "../../src/executor/lane.js";
import type { ExecutionContract } from "../../src/compiler/contract.js";
import type { LeanPiConfig } from "../../src/core/types.js";
import { ESCALATION_QUESTION, ESCALATION_SITE_ID, type EscalationCategory } from "../../src/executor/escalation.js";
import { REVIEW_LEVEL_QUESTION_ID, REVIEW_LEVEL_SITE_ID } from "../../src/review/gate.js";
import * as reviewLane from "../../src/review/lane.js";
import { choice, fakeExec, harness, quickContract, scriptedJev, VERIFY_COMMANDS, type ExecHarness } from "./helpers.js";

const open: ExecHarness[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (open.length > 0) await open.pop()?.close();
});

async function fixture(): Promise<ExecHarness> {
	const h = await harness();
	open.push(h);
	return h;
}

/** A worker that edits a real file, so "workspace change" is observed, not claimed. */
function editingWorker(cwd: string, seen: WorkerTaskPacket[], backend = "local", file = "src/target.ts"): ExecutorWorker {
	return async (packet) => {
		seen.push(packet);
		writeFileSync(join(cwd, file), file.endsWith(".json") ? JSON.stringify({ name: "fixture", version: String(seen.length + 1) }) : `export const value = ${seen.length + 1};\n`);
		return { status: "completed", backend, result: { status: "ok", changedFiles: [file], summary: "edited" }, attempts: [] } satisfies WorkerTurnOutcome;
	};
}

/** The executor deps every case shares; each test adds its own worker and seams. */
function depsFor(h: ExecHarness, extra: Partial<ExecutorDeps> = {}): ExecutorDeps {
	return { registry: h.registry, cwd: h.cwd, config: h.config, store: h.store, artifacts: h.artifacts, ...extra };
}

/** A reviewer verdict in the shape §30's parser actually reads. */
function verdict(decision: "PASS" | "FIX_REQUIRED" | "ESCALATE", evidence = ""): string {
	const findings = evidence.length === 0 ? [] : [{ criterion: "AC-1", file: "src/auth.ts", location: "12", severity: "high", evidence }];
	return JSON.stringify({ decision, findings });
}

const ALWAYS_PASS: reviewLane.ReviewRunner = async () => ({ status: "ok", changedFiles: [], summary: verdict("PASS") });

describe("PRD-007 Phase 1 — packet isolation and the reachable consumer", () => {
	it("AC-1: the worker packet carries the six §28 fields and no routing metadata", async () => {
		const h = await fixture();
		const contract = await quickContract(h);
		// The contract really does carry the blocks that must not cross, so the
		// negative assertions below are not vacuous.
		expect(contract.routing.executor_class).toBeDefined();
		expect(contract.reasoning.effort).toBeDefined();
		expect(contract.verification.required.length).toBeGreaterThan(0);

		const task = toExecutorTask(contract, { files: ["src/target.ts"] });
		expect(Object.keys(task).sort()).toEqual([...EXECUTOR_TASK_KEYS].sort());

		const seen: WorkerTaskPacket[] = [];
		await runExecutor(contract, {
			registry: h.registry,
			cwd: h.cwd,
			config: h.config,
			store: h.store,
			artifacts: h.artifacts,
			worker: editingWorker(h.cwd, seen),
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
			// The packet is what this case inspects; a real reviewer would spawn a
			// backend and stall the suite without adding an assertion.
			reviewRunner: ALWAYS_PASS,
		});

		expect(seen).toHaveLength(1);
		const wire = JSON.stringify(seen[0]);
		for (const leaked of [
			"executor_class",
			"reviewer_class",
			"planning_decision",
			"execution_complexity",
			"review_risk",
			"required_capability",
			"fallback_used",
			"site_id",
			"isolation",
			"semantic_review_rounds",
			"execution_band",
		]) {
			expect(wire, leaked).not.toContain(leaked);
		}
		expect(seen[0]!.objective).toBe(contract.task.objective);
		expect(seen[0]!.budget).toBe(contract.context.budget_tokens);
	});

	it("AC-1: the projection produces exactly the six keys from a contract that carries more", async () => {
		const h = await fixture();
		const contract = await quickContract(h);
		expect(Object.keys(contract).length).toBeGreaterThan(EXECUTOR_TASK_KEYS.length);
		expect(Object.keys(toExecutorTask(contract))).toHaveLength(EXECUTOR_TASK_KEYS.length);
	});

	it("AC-2: a routed turn changes the workspace and reports evidence; a blocked backend reports blocked", async () => {
		const h = await fixture();
		const contract = await quickContract(h);
		const before = readFileSync(join(h.cwd, "src", "target.ts"), "utf8");

		const completed = await runExecutor(contract, {
			registry: h.registry,
			cwd: h.cwd,
			config: h.config,
			store: h.store,
			artifacts: h.artifacts,
			worker: editingWorker(h.cwd, []),
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
			// The reviewer is incidental to this case: a turn completes only on a
			// `PASS` verdict, so the stub answers one.
			reviewRunner: ALWAYS_PASS,
		});

		expect(completed.status).toBe("completed");
		expect(completed.changedFiles).toEqual(["src/target.ts"]);
		expect(readFileSync(join(h.cwd, "src", "target.ts"), "utf8")).not.toBe(before);
		expect(completed.evidence.length).toBeGreaterThan(0);
		expect(completed.evidence.some((record) => record.status === "pass")).toBe(true);

		const blocked = await runExecutor(contract, {
			registry: h.registry,
			cwd: h.cwd,
			config: h.config,
			store: h.store,
			worker: async () => ({ status: "blocked", attempts: [{ backend: "local", failure: "exit", reason: "vendor refused" }] }) as WorkerTurnOutcome,
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
		});
		expect(blocked.status).toBe("blocked");
		expect(blocked.blockedReason).toContain("vendor refused");
		expect(blocked.changedFiles).toEqual([]);
	});
});

describe("PRD-007 Phase 2 — the quick path and the review decision", () => {
	it("AC-3: a low-complexity contract runs one quick invocation with no PRD lane, reviewer or capability scan", async () => {
		const h = await fixture();
		const base = await quickContract(h, "rename parseFoo to parseBar in src/target.ts");
		const contract: ExecutionContract = {
			...base,
			task: { ...base.task, prd_required: false, execution_complexity: "LOW", review_risk: "R0" },
			routing: { ...base.routing, executor_class: "quick", reviewer_class: "none" },
			capabilities: { skills: [], mcps: [], lsp: false, rtk: "off" },
		};
		// PRD-011 answers "no review" only when its site answers; with JEV absent it
		// conservatively raises the level, which is its call to make, not this lane's.
		const jev = scriptedJev({ [REVIEW_LEVEL_SITE_ID]: () => choice(REVIEW_LEVEL_QUESTION_ID, "NO_SEMANTIC_REVIEW") });
		const onCapabilityScan = vi.fn();
		const onPrdLane = vi.fn();
		const reviewSpy = vi.spyOn(reviewLane, "review");

		const outcome = await runExecutor(contract, {
			registry: h.registry,
			cwd: h.cwd,
			config: h.config,
			store: h.store,
			jev,
			worker: editingWorker(h.cwd, []),
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
			onCapabilityScan,
			onPrdLane,
		});

		expect(outcome.status).toBe("completed");
		expect(outcome.invocations).toHaveLength(1);
		expect(outcome.invocations[0]!.role).toBe("quick");
		expect(onCapabilityScan).not.toHaveBeenCalled();
		expect(onPrdLane).not.toHaveBeenCalled();
		expect(reviewSpy).not.toHaveBeenCalled();
		expect(outcome.review).toMatchObject({ level: "NO_SEMANTIC_REVIEW", skipped: true, verdict: null });
	});

	it("AC-4: PRD-011's floor decides — a security-sensitive change with review_risk R0 still reaches the reviewer", async () => {
		const h = await fixture();
		const base = await quickContract(h, "update the auth token check");
		const contract: ExecutionContract = {
			...base,
			task: { ...base.task, prd_required: false, execution_complexity: "LOW", review_risk: "R0" },
			routing: { ...base.routing, executor_class: "quick", reviewer_class: "none" },
			verification: { required: ["typecheck", "affected_tests"] },
		};
		// The same JEV answer as AC-3 — "no review" — so the only thing that can
		// still route this change to a reviewer is PRD-011's deterministic floor.
		const jev = scriptedJev({ [REVIEW_LEVEL_SITE_ID]: () => choice(REVIEW_LEVEL_QUESTION_ID, "NO_SEMANTIC_REVIEW") });

		const sensitiveWorker: ExecutorWorker = async () => {
			writeFileSync(join(h.cwd, "src", "auth.ts"), "export const secret = 2;\n");
			return { status: "completed", backend: "local", result: { status: "ok", changedFiles: ["src/auth.ts"], summary: "edited" }, attempts: [] };
		};
		const reviewRunner = vi.fn(async () => ({
			status: "ok" as const,
			changedFiles: [],
			summary: JSON.stringify({ verdict: "PASS", findings: [], summary: "looks fine" }),
		}));

		const outcome = await runExecutor(contract, {
			registry: h.registry,
			cwd: h.cwd,
			config: h.config,
			store: h.store,
			jev,
			worker: sensitiveWorker,
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
			reviewRunner,
		});

		// The stub's summary names `verdict`, which §30's parser does not read, so
		// what the reviewer actually returned is an `ESCALATE`. The floor is still
		// what routed this change to a reviewer — and the lane no longer reports a
		// turn as completed on a verdict that did not pass.
		expect(reviewRunner).toHaveBeenCalledTimes(1);
		expect(outcome.status).toBe("blocked");
		expect(outcome.review.skipped).toBe(false);
		expect(outcome.review.level).not.toBe("NO_SEMANTIC_REVIEW");
		expect(outcome.review.verdict?.decision).toBe("ESCALATE");
		expect(outcome.blockedReason).toContain("ESCALATE");
	});
});

/**
 * Drive `execution_attempts: 3` with an always-failing verifier: attempts one and
 * two fail identically, so the third is the one the escalation gate granted. The
 * returned packets are what the worker actually received, in order.
 */
async function escalatedPackets(
	h: ExecHarness,
	category: EscalationCategory,
	extra: Partial<ExecutorDeps> = {},
): Promise<{ packets: WorkerTaskPacket[]; outcome: ExecutorOutcome }> {
	const base = await quickContract(h);
	const contract: ExecutionContract = {
		...base,
		verification: { required: ["typecheck"] },
		limits: { ...base.limits, execution_attempts: 3, max_escalations: 1, semantic_review_rounds: 0 },
	};
	const packets: WorkerTaskPacket[] = [];
	const jev = scriptedJev({ [ESCALATION_SITE_ID]: () => choice(ESCALATION_QUESTION.id, category) });
	const outcome = await runExecutor(
		contract,
		depsFor(h, {
			jev,
			worker: editingWorker(h.cwd, packets),
			exec: fakeExec({ pass: false }),
			verifyCommands: VERIFY_COMMANDS,
			...extra,
		}),
	);
	return { packets, outcome };
}

describe("PRD-007 — the reviewer's verdict and the escalation categories", () => {
	it("F2: a FIX_REQUIRED verdict over a passing verification blocks the turn and carries the review", async () => {
		const h = await fixture();
		const base = await quickContract(h, "update the auth token check");
		// reviewer_class `none` means the contract allows no review round, so the
		// verdict has nowhere left to go but `blocked`.
		const contract: ExecutionContract = {
			...base,
			task: { ...base.task, prd_required: false, execution_complexity: "LOW", review_risk: "R0" },
			routing: { ...base.routing, executor_class: "quick", reviewer_class: "none" },
			verification: { required: ["typecheck"] },
			limits: { ...base.limits, semantic_review_rounds: 0 },
		};
		const jev = scriptedJev({ [REVIEW_LEVEL_SITE_ID]: () => choice(REVIEW_LEVEL_QUESTION_ID, "NO_SEMANTIC_REVIEW") });
		const reviewRunner = vi.fn(async () => ({
			status: "ok" as const,
			changedFiles: [],
			summary: verdict("FIX_REQUIRED", "the token check still accepts an expired token"),
		}));

		const outcome = await runExecutor(
			contract,
			depsFor(h, {
				jev,
				worker: editingWorker(h.cwd, [], "local", "src/auth.ts"),
				exec: fakeExec({ pass: true }),
				verifyCommands: VERIFY_COMMANDS,
				reviewRunner,
			}),
		);

		expect(outcome.status).toBe("blocked");
		expect(outcome.review.verdict?.decision).toBe("FIX_REQUIRED");
		expect(outcome.review.skipped).toBe(false);
		expect(outcome.blockedReason).toContain("FIX_REQUIRED");
		expect(outcome.blockedReason).toContain("expired token");
	});

	it("F2: a round spent on FIX_REQUIRED feeds the next attempt, and a later PASS completes", async () => {
		const h = await fixture();
		const base = await quickContract(h, "update the auth token check");
		const contract: ExecutionContract = {
			...base,
			task: { ...base.task, prd_required: false, execution_complexity: "LOW", review_risk: "R0" },
			routing: { ...base.routing, executor_class: "quick", reviewer_class: "none" },
			verification: { required: ["typecheck"] },
			limits: { ...base.limits, execution_attempts: 2, semantic_review_rounds: 2 },
		};
		const jev = scriptedJev({ [REVIEW_LEVEL_SITE_ID]: () => choice(REVIEW_LEVEL_QUESTION_ID, "NO_SEMANTIC_REVIEW") });
		let rounds = 0;
		const reviewRunner = vi.fn(async () => {
			rounds += 1;
			return {
				status: "ok" as const,
				changedFiles: [],
				summary: rounds === 1 ? verdict("FIX_REQUIRED", "the token check still accepts an expired token") : verdict("PASS"),
			};
		});

		const outcome = await runExecutor(
			contract,
			depsFor(h, {
				jev,
				worker: editingWorker(h.cwd, [], "local", "src/auth.ts"),
				exec: fakeExec({ pass: true }),
				verifyCommands: VERIFY_COMMANDS,
				reviewRunner,
			}),
		);

		expect(outcome.status).toBe("completed");
		expect(reviewRunner).toHaveBeenCalledTimes(2);
		expect(outcome.review.verdict?.decision).toBe("PASS");
		// The spent round is on the retry history, which is what lets the second
		// review's floor escalate a security-sensitive change.
		expect(outcome.retryHistory).toHaveLength(1);
		expect(outcome.review.level).toBe("STRONG_REVIEW");
	});

	it("F7: GET_MORE_CONTEXT widens the next packet with the files the failed attempt changed", async () => {
		const h = await fixture();
		const { packets } = await escalatedPackets(h, "GET_MORE_CONTEXT");

		expect(packets).toHaveLength(3);
		// The compiler's per-turn reasoning budget has to be *on* the packet or a
		// vendor CLI never learns it: Codex takes it as `-c
		// model_reasoning_effort=` and otherwise runs at its own configured
		// effort (`xhigh` on the machine this was written on) on every turn.
		expect(packets[0]!.effort).toBe("low");
		expect(packets[2]).not.toEqual(packets[1]);
		expect(packets[2]!.files).toContain("src/target.ts");
		expect(packets[2]!.prompt).toContain("widened files");
		expect(packets[2]!.prompt).toContain("the previous failure was");
	});

	it("F7: INCREASE_REASONING raises the effort under the backend's own parameter name", async () => {
		const h = await fixture();
		const config: LeanPiConfig = { ...h.config, backends: { ...h.config.backends, local: { ...h.config.backends.local!, effort_param: "reasoning_effort" } } };
		const { packets } = await escalatedPackets(h, "INCREASE_REASONING", { config });

		expect(packets[2]).not.toEqual(packets[1]);
		expect(packets[2]).toMatchObject({ reasoning_effort: "high" });
		expect(packets[2]!.prompt).toContain("reason harder");
	});

	it("F7: ENABLE_CAPABILITY names the capability the failure needs and the tools the attempt may use", async () => {
		const h = await fixture();
		const { packets } = await escalatedPackets(h, "ENABLE_CAPABILITY");

		expect(packets[2]).not.toEqual(packets[1]);
		expect(packets[2]!.prompt).toContain("capability the previous attempt lacked");
		expect(packets[2]!.prompt).toContain("tools this attempt may use: read, search, edit, write, execute");
	});

	it("F7: STRONG_REVIEW runs a strong review and puts its findings in the next packet", async () => {
		const h = await fixture();
		const reviewRunner = vi.fn(async () => ({
			status: "ok" as const,
			changedFiles: [],
			summary: verdict("FIX_REQUIRED", "the strong review found an unhandled branch"),
		}));
		const { packets } = await escalatedPackets(h, "STRONG_REVIEW", { reviewRunner });

		expect(reviewRunner).toHaveBeenCalledTimes(1);
		expect(packets[2]).not.toEqual(packets[1]);
		expect(packets[2]!.prompt).toContain("strong review FIX_REQUIRED");
		expect(packets[2]!.prompt).toContain("unhandled branch");
	});

	it("F4: the reviewer is told the identity that actually ran", async () => {
		const h = await fixture();
		const base = await quickContract(h);
		const contract: ExecutionContract = { ...base, verification: { required: ["typecheck"] } };
		const jev = scriptedJev({ [REVIEW_LEVEL_SITE_ID]: () => choice(REVIEW_LEVEL_QUESTION_ID, "QUICK_REVIEW") });
		const seen: unknown[] = [];
		const reviewRunner: reviewLane.ReviewRunner = async (_packet, _backend, deps) => {
			seen.push(deps.executor);
			return { status: "ok", changedFiles: [], summary: verdict("PASS") };
		};

		const outcome = await runExecutor(
			contract,
			depsFor(h, {
				jev,
				worker: editingWorker(h.cwd, []),
				exec: fakeExec({ pass: true }),
				verifyCommands: VERIFY_COMMANDS,
				reviewRunner,
			}),
		);

		expect(outcome.status).toBe("completed");
		expect(seen).toEqual([{ backend: "local", model: "cheap" }]);
		expect(outcome.review.independence).not.toBeNull();
	});

	it("B4: a change touching package.json widens verification to the full suite", async () => {
		const h = await fixture();
		const base = await quickContract(h);
		const contract: ExecutionContract = { ...base, verification: { required: ["typecheck", "affected_tests"] } };

		const outcome = await runExecutor(
			contract,
			depsFor(h, {
				worker: editingWorker(h.cwd, [], "local", "package.json"),
				exec: fakeExec({ pass: true }),
				verifyCommands: VERIFY_COMMANDS,
				reviewRunner: ALWAYS_PASS,
			}),
		);

		expect(outcome.status).toBe("completed");
		expect(outcome.commands).toContain("npm test");
	});
});
