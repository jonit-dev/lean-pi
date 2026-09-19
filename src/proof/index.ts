/**
 * The proof gate's public surface (PRD-010). `src/index.ts` re-exports this
 * module, which is the turn path's only entry into proof sufficiency.
 */
export { GAP_ACTIONS, categoryForVerifierKind, type ProofAction, type ProofActionExecutor } from "./actions.js";
export {
	answersToResults,
	coverageFallback,
	coverageOfPacket,
	decideCriterion,
	detectContradiction,
	foldTaskDecision,
	gapCategoryFallback,
	type Contradiction,
	type CriterionDecision,
	type CriterionInputs,
	type CriterionResult,
	type CoverageResult,
	type ScopeRecord,
	type SufficiencyAnswers,
	type TaskDecision,
} from "./decide.js";
export {
	evaluateProofGate,
	registerProofSites,
	type ProofActionRecord,
	type ProofCriterionResult,
	type ProofDeps,
	type ProofGateResult,
	type ProofJev,
	type ProofOutcome,
} from "./gate.js";
// `buildPacket` is deliberately not re-exported: PRD-011's barrel owns that name
// (§30's review packet), and PRD-013 imports this module's packet builder from
// `src/proof/packet.js` directly. Re-exporting it would make the name ambiguous
// in `src/index.ts`, where both barrels land.
export { criteriaOf, normalizedKinds, type PacketContext, type ProofCriterion, type ProofEvidenceView, type ProofPacket } from "./packet.js";
export {
	GAP_QUESTION,
	GAP_QUESTION_ID,
	isGapCategory,
	MISSING_PROOF_SITE_ID,
	PROOF_GAP_CATEGORIES,
	SUFFICIENCY_QUESTION_IDS,
	SUFFICIENCY_QUESTIONS,
	SUFFICIENCY_SITE_ID,
	type Demonstrates,
	type ProofGapCategory,
	type SufficiencyKey,
	type YesNo,
} from "./questions.js";
export {
	escalateLadder,
	lastReviewAttempt,
	recover,
	reviewDecision,
	type ProofAttempt,
	type ProofReview,
	type ProofReviewFinding,
	type ProofReviewLevel,
	type ProofReviewVerdict,
	type RecoverDeps,
	type RecoverOutcome,
	type RecoverRequest,
} from "./recover.js";
