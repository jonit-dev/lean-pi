/**
 * PRD-007 Phase 1 and Phase 2 — AC-1..AC-4: packet isolation, the reachable
 * consumer, the §29 quick path, and the review decision being PRD-011's.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerTaskPacket, WorkerTurnOutcome } from "../../src/backends/worker.js";
import { EXECUTOR_TASK_KEYS, runExecutor, toExecutorTask } from "../../src/executor/index.js";
import type { ExecutorWorker } from "../../src/executor/lane.js";
import type { ExecutionContract } from "../../src/compiler/contract.js";
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
function editingWorker(cwd: string, seen: WorkerTaskPacket[], backend = "local"): ExecutorWorker {
	return async (packet) => {
		seen.push(packet);
		writeFileSync(join(cwd, "src", "target.ts"), `export const value = ${seen.length + 1};\n`);
		return { status: "completed", backend, result: { status: "ok", changedFiles: ["src/target.ts"], summary: "edited" }, attempts: [] } satisfies WorkerTurnOutcome;
	};
}

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

		expect(outcome.status).toBe("completed");
		expect(outcome.review.skipped).toBe(false);
		expect(outcome.review.level).not.toBe("NO_SEMANTIC_REVIEW");
		expect(reviewRunner).toHaveBeenCalledTimes(1);
	});
});
