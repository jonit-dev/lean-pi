/**
 * Derivation from the PRD (PRD-025 Phase 2, ROADMAP §43).
 *
 * With an active PRD the list is not hand-maintained: `syncFromPrd()` reads
 * PRD-012's remaining criteria and reconciles them into items keyed by
 * `criterion`, so a sync is idempotent and never duplicates an item, and a
 * criterion PRD-012 reopens re-enters the list at its original position rather
 * than at the end. Status then follows PRD-010's gate, not the author:
 *
 * - `PASS` → `done`;
 * - `MISSING_PROOF` / `FAILED` → `pending` (the active item stays `in_progress`);
 * - `BLOCKED` → `blocked` with the gate's reason;
 * - no verdict at all is not `PASS`, so a previously `done` item reopens.
 *
 * Nothing in this module writes `done` itself: the only writer is
 * `completeItem`, and it consults the same gate.
 */
import { deriveGoal } from "../prd/goal.js";
import type { PrdState } from "../prd/state.js";
import type { ProofGateResult } from "../proof/index.js";
import { addItem, itemsOf, promoteNext, type TodoCarrier, type TodoGate, type TodoGateVerdict, type TodoItem } from "./state.js";

/** PRD-010's gate result as the list's port. The verdict mapping is total and explicit. */
export function gateFromProofResult(result: ProofGateResult): TodoGate {
	const byId = new Map(result.criteria.map((criterion) => [criterion.id, criterion]));
	return {
		verdict(criterionId) {
			const criterion = byId.get(criterionId);
			if (!criterion) return undefined;
			return {
				decision: criterion.decision,
				missing: [...criterion.coverage.unsatisfied],
				reason: criterion.reasons.join("; "),
			};
		},
	};
}

function verdictOf(gate: TodoGate | undefined, criterionId: string): Promise<TodoGateVerdict | undefined> | undefined {
	if (!gate) return undefined;
	const verdict = gate.verdict(criterionId);
	return verdict instanceof Promise ? verdict : Promise.resolve(verdict);
}

/** The label a derived item carries for grouping; the unit that owns the criterion. */
function phaseOf(prd: PrdState, criterionId: string): string | undefined {
	return prd.units.find((unit) => unit.criterionIds.includes(criterionId))?.id;
}

/** One criterion's item, by gate verdict. `in_progress` survives a non-PASS verdict. */
function applyVerdict(item: TodoItem, verdict: TodoGateVerdict | undefined): void {
	if (verdict?.decision === "PASS") {
		item.status = "done";
		delete item.blockedReason;
		return;
	}
	if (verdict?.decision === "BLOCKED") {
		item.status = "blocked";
		item.blockedReason = verdict.reason || "the proof gate reported BLOCKED";
		return;
	}
	if (item.status !== "in_progress") item.status = "pending";
	delete item.blockedReason;
}

export interface SyncInput {
	prd: PrdState;
	gate?: TodoGate;
}

/**
 * Reconcile PRD-012's remaining criteria into the list, in unit then criterion
 * order. An item whose criterion has left the remaining set is left untouched:
 * PRD-012 owns that transition, and a `done` item that reached `done` through
 * the gate is not silently reopened by a sync.
 */
export async function syncFromPrd(state: TodoCarrier, input: SyncInput): Promise<TodoItem[]> {
	const items = itemsOf(state);
	const remaining = deriveGoal(input.prd);

	for (const criterion of remaining) {
		if (items.some((item) => item.criterion === criterion.criterionId)) continue;
		addItem(items, criterion.text, { criterion: criterion.criterionId, phase: phaseOf(input.prd, criterion.criterionId) });
	}

	const live = new Set(remaining.map((criterion) => criterion.criterionId));
	for (const item of items) {
		if (item.criterion === undefined || !live.has(item.criterion)) continue;
		applyVerdict(item, await verdictOf(input.gate, item.criterion));
	}
	promoteNext(items);
	return items;
}
