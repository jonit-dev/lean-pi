/**
 * The goal pairing (PRD-025 Phase 3, ROADMAP §42/§43).
 *
 * `remainingWork()` is a pure function over the list — no evidence reads, no gate
 * calls, no session access — because everything it needs was decided by the
 * transitions. PRD-013 owns every stop condition; this module hands it a
 * predicate and a blocker list and nothing else:
 *
 * - non-empty `actionable` → useful work remains, the engine continues;
 * - empty `actionable` with a non-empty `blocked` → the engine returns `BLOCKED`
 *   naming those `blockedReason`s;
 * - both empty → no signal from the list, so the engine's own evaluation runs
 *   and a drained list reaches `GOAL_MET` through its existing path.
 *
 * PRD-025 Phase 4's `todo.needed` decision site lived here too. It asked JEV
 * whether the turn warranted a list, fed only the raw user turn as `request`,
 * and its answer overruled the deterministic fallback that `todo_add` admission
 * used — see `tool.ts` for why that gate is gone.
 */
import { remainingWork, type RemainingWork, type TodoItem } from "./state.js";

export { remainingWork } from "./state.js";
export type { RemainingWork } from "./state.js";

/** What PRD-013's boundary needs: whether to continue, and who is blocking. */
export interface BoundaryTodoInput {
	usefulWorkRemains: boolean;
	blockers: string[];
}

export function boundaryTodoInput(list: readonly TodoItem[]): BoundaryTodoInput {
	const { actionable, blocked } = remainingWork(list);
	return {
		usefulWorkRemains: actionable.length > 0,
		blockers: blocked.map((item) => `${item.id}: ${item.blockedReason ?? "unspecified"}`),
	};
}
