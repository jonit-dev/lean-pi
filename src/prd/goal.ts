/**
 * The PRD → goal handoff (PRD-012 Phase 3, FR-035, ROADMAP §43).
 *
 * This function is the whole handoff: PRD-013's `src/goal/from-prd.ts` maps one
 * returned entry to one machine clause keyed by `criterionId` and parses no PRD
 * file itself. The list is recomputed from the criterion store on every read, so
 * a criterion that is verified, or reopened, cannot drift from what `/goal`
 * quantifies over.
 */
import { noteLaneModuleLoad } from "./dispatch.js";
import type { PrdState } from "./state.js";

noteLaneModuleLoad("goal");

export interface GoalCriterion {
	criterionId: string;
	text: string;
	verifyCommand: string;
}

/** Every criterion that is not `VERIFIED`, with the command that would resolve it. */
export function deriveGoal(state: PrdState): GoalCriterion[] {
	return state.criteria
		.filter((criterion) => criterion.status !== "VERIFIED")
		.map((criterion) => ({
			criterionId: criterion.id,
			text: criterion.text,
			verifyCommand: criterion.verifyCommand,
		}));
}
