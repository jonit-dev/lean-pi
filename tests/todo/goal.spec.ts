/**
 * Phase 3 / AC-3 — the goal loop drains the list.
 *
 * PRD-013 owns every stop condition; this spec drives the three boundaries this
 * PRD supplies the input for. The three cases differ only in list contents,
 * which is itself the control that the list — not a model's self-report — decides
 * the outcome:
 *
 * - non-empty `actionable` → the engine continues with no user input;
 * - both empty → nothing left to do, so the engine's own evaluation runs and a
 *   drained list reaches `GOAL_MET` through its existing path;
 * - empty `actionable` with a non-empty `blocked` → the engine returns `BLOCKED`
 *   naming those reasons.
 */
import { describe, expect, it } from "vitest";
import { evaluateGoal, newGoalState } from "../../src/goal/index.js";
import type { EvidenceRecord } from "../../src/verify/evidence.js";
import { boundaryTodoInput, remainingWork } from "../../src/todo/goal.js";
import { createTodoList, type TodoCarrier, type TodoItem } from "../../src/todo/state.js";

function sessionList(): { state: TodoCarrier; list: ReturnType<typeof createTodoList>; items: () => readonly TodoItem[] } {
	const state: TodoCarrier = {};
	const list = createTodoList(state);
	return { state, list, items: () => state.todo ?? [] };
}

describe("the goal boundary reads the list (AC-3)", () => {
	it("continues over the boundary while two actionable items remain", () => {
		const live = sessionList();
		live.list.add("implement syncFromPrd");
		live.list.add("collapse completed items");
		live.list.start("a");

		const boundary = boundaryTodoInput(live.items());
		expect(boundary.usefulWorkRemains).toBe(true);
		expect(boundary.blockers).toEqual([]);
		expect(remainingWork(live.items()).actionable.map((item) => item.id)).toEqual(["a", "b"]);
	});

	it("runs three boundaries over one session list, and the list decides each outcome", async () => {
		const live = sessionList();
		live.list.add("implement syncFromPrd");
		live.list.add("collapse completed items");

		// Boundary 1: two actionable items → continue.
		expect(boundaryTodoInput(live.items())).toEqual({ usefulWorkRemains: true, blockers: [] });

		// Boundary 2: the work is done → the list has no signal, so the engine's
		// own evaluation decides (a drained list reaches GOAL_MET there).
		expect((await live.list.complete("a")).ok).toBe(true);
		expect((await live.list.complete("b")).ok).toBe(true);
		const drained = boundaryTodoInput(live.items());
		expect(drained).toEqual({ usefulWorkRemains: false, blockers: [] });

		// Boundary 3: everything left is blocked → the engine returns BLOCKED and
		// the reason names at least one item's blockedReason.
		live.list.add("wire boundary predicate");
		live.list.block("c", "PRD-013 boundary hook not landed");
		const blocked = boundaryTodoInput(live.items());
		expect(blocked.usefulWorkRemains).toBe(false);
		expect(blocked.blockers.join("\n")).toContain("PRD-013 boundary hook not landed");
		expect(remainingWork(live.items()).actionable).toEqual([]);
	});

	it("never lets a blocked item become actionable again without an explicit unblock", () => {
		const live = sessionList();
		live.list.add("a");
		live.list.add("b");
		live.list.start("a");
		live.list.block("a", "waiting on review");

		// Nothing is promoted: `blocked` is skipped by the promotion rule and only
		// `unblock` returns it to the order.
		expect(live.items().map((item) => `${item.id}:${item.status}`)).toEqual(["a:blocked", "b:pending"]);
		expect(boundaryTodoInput(live.items()).usefulWorkRemains).toBe(true);

		live.list.unblock("a");
		expect(remainingWork(live.items()).actionable.map((item) => item.id)).toEqual(["a", "b"]);
	});

	it("counts nothing toward remaining work once an item is dropped", () => {
		const live = sessionList();
		live.list.add("a");
		live.list.add("b");
		live.list.drop("a");

		const boundary = boundaryTodoInput(live.items());
		expect(remainingWork(live.items()).actionable.map((item) => item.id)).toEqual(["b"]);
		expect(boundary.usefulWorkRemains).toBe(true);

		live.list.drop("b");
		expect(boundaryTodoInput(live.items())).toEqual({ usefulWorkRemains: false, blockers: [] });
	});

	it("drives PRD-013's real boundary over three turns from the same list", async () => {
		const HASH = "workspace-hash-todo";
		const typecheckPass: EvidenceRecord = {
			kind: "typecheck",
			status: "pass",
			workspaceHash: HASH,
			startedAt: "2026-09-19T00:00:00.000Z",
			exitCode: 0,
			artifactRef: null,
			criterion: [],
			scope: "src",
		};
		const live = sessionList();
		live.list.add("implement syncFromPrd");
		live.list.add("collapse completed items");
		const boundary = (records: readonly EvidenceRecord[]) =>
			evaluateGoal(newGoalState("typecheck", { max_turns: 5, max_cost: 2 }, "2026-09-19T00:00:00.000Z"), {
				workspaceHash: HASH,
				records,
				producibleKinds: ["typecheck"],
				costSoFar: () => 0,
				todos: live.list,
			});

		// Boundary 1 — two actionable items and an outstanding clause: continue.
		const first = await boundary([]);
		expect(first.decision).toBe("continue");
		expect(first.stop).toBeNull();

		// Boundary 2 — every remaining item blocked: BLOCKED, naming a reason.
		live.list.block("a", "waiting on review");
		live.list.block("b", "PRD-013 boundary hook not landed");
		const second = await boundary([]);
		expect(second.decision).toBe("stop");
		expect(second.stop).toBe("BLOCKED");
		expect(second.reason).toContain("PRD-013 boundary hook not landed");

		// Boundary 3 — the list drained and the clause proved: GOAL_MET.
		live.list.drop("a");
		live.list.drop("b");
		expect(boundaryTodoInput(live.items())).toEqual({ usefulWorkRemains: false, blockers: [] });
		const third = await boundary([typecheckPass]);
		expect(third.decision).toBe("stop");
		expect(third.stop).toBe("GOAL_MET");
	});
});
