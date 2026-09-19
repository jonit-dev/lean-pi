/**
 * PRD-derived goals and criterion resolution (PRD-013 Phase 4, FR-130/FR-143, ROADMAP §43).
 *
 * PRD-012's `deriveGoal()` is the entire handoff: one returned entry becomes
 * exactly one machine clause keyed by `criterionId`, and this module parses no
 * PRD file, reads no skill path and reaches no prd-manager skill. The list is
 * re-read at every boundary, so a criterion PRD-012 reopens re-enters the goal
 * instead of staying met from a snapshot taken at `/goal` time.
 *
 * A criterion clause resolves through PRD-010's decision table (sufficient *and*
 * fresh), not through a raw evidence lookup: a criterion with contradictory
 * evidence — a fresh pass over a scope that also measured a fail — keeps the
 * goal running instead of passing because one record said `pass`. The gate's
 * recovery loop is deliberately not run here; recovery is the executor's, and a
 * boundary that shelled commands would be spending a turn's work at a checkpoint.
 */
import { deriveGoal as derivePrdGoal, type GoalCriterion } from "../prd/goal.js";
import type { PrdState } from "../prd/state.js";
import { coverageFallback, decideCriterion } from "../proof/decide.js";
import { buildPacket, type ProofCriterion, type ProofEvidenceView } from "../proof/packet.js";
import type { GoalClause } from "./clauses.js";

/** PRD-012's remaining-required-criteria descriptor, read structurally so a manager satisfies it too. */
export interface PrdGoalSource {
	deriveGoal(): GoalCriterion[];
}

/**
 * The live source: every call re-reads the PRD state, which is what keeps a
 * reopened criterion from being silently dropped.
 */
export function prdGoalSource(read: () => PrdState | null): PrdGoalSource {
	return {
		deriveGoal() {
			const state = read();
			return state === null ? [] : derivePrdGoal(state);
		},
	};
}

/** One machine clause per remaining criterion, keyed by `criterionId`. */
export function derivedCriterionClauses(source: PrdGoalSource): GoalClause[] {
	return source.deriveGoal().map((entry) => ({
		id: entry.criterionId,
		text: entry.text,
		kind: "machine" as const,
		kinds: [],
		criterion: entry.criterionId,
	}));
}

export const DERIVED_GOAL_SENTENCE = "all required acceptance criteria have sufficient fresh evidence";

/** The text a bare `/goal` persists: the sentence, with the criteria it quantifies over. */
export function derivedGoalText(clauses: readonly GoalClause[]): string {
	return `${DERIVED_GOAL_SENTENCE} (${clauses.map((clause) => clause.criterion).join(", ")})`;
}

export interface CriterionResolution {
	satisfied: boolean;
	detail: string;
}

/**
 * One criterion through PRD-010's decision table. `required` defaults to the
 * kinds PRD-009 has measured for the criterion: the contract's verification
 * block is a task-scoped view, and a PRD-derived goal outlives the task that
 * created it.
 */
export function resolveCriterionText(
	criterion: { criterionId: string; text: string; required?: readonly string[] },
	view: ProofEvidenceView,
): CriterionResolution {
	const attributed = view.records.filter((record) => record.criterion.includes(criterion.criterionId));
	const stale = view.staleRecords.filter((record) => record.criterion.includes(criterion.criterionId));
	const required =
		criterion.required ?? [...new Set(attributed.map((record) => record.kind))];
	const proofCriterion: ProofCriterion = {
		id: criterion.criterionId,
		text: criterion.text,
		required: [...required],
		...(attributed[0] ? { scope: attributed[0].scope } : {}),
	};
	const packet = buildPacket(proofCriterion, view);
	const result = decideCriterion({
		criterion: proofCriterion,
		packet,
		mandatory: attributed.filter((record) => required.includes(record.kind)),
		records: attributed,
		stale,
		answers: coverageFallback(packet),
		// No reviewer class is wired at a goal boundary: the gate awaits a review
		// only when the contract demands one, and a resolved criterion here carries
		// no contract.
		reviewPassed: true,
		gapCategory: "NONE",
	});
	return {
		satisfied: result.decision === "PASS",
		detail: `${criterion.criterionId}: ${result.decision} (${result.reasons.join("; ")})`,
	};
}
