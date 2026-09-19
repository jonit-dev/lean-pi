/**
 * Reviewer lane barrel (PRD-011). `src/index.ts` re-exports this module.
 */
export { buildPacket, renderReviewPrompt, acceptanceCriteriaOf, workspaceChange, DEFAULT_INLINE_DIFF_BYTES, DIFF_ARTIFACT_KIND } from "./packet.js";
export type { PacketInputs, BuiltPacket, ReviewProfile } from "./packet.js";
export {
	REVIEW_DECISIONS,
	REVIEW_LEVELS,
	REVIEW_LEVEL_RANK,
	REVIEW_PACKET_KEYS,
	escalateVerdict,
	isReviewLevel,
	maxReviewLevel,
	parseVerdict,
	reviewerRoleOf,
} from "./schema.js";
export type {
	AcceptanceCriterion,
	ActiveReviewLevel,
	ReviewDecision,
	ReviewFinding,
	ReviewLevel,
	ReviewPacket,
	ReviewPacketKey,
	ReviewVerdict,
	ReviewerRole,
} from "./schema.js";
export { REVIEW_MODES, REVIEW_MODE_LEVELS, isReviewMode, review, reviewProfileOf } from "./lane.js";
export type { Independence, ReviewDeps, ReviewEscalation, ReviewMode, ReviewOutcome, ReviewRunner } from "./lane.js";
export { REVIEW_LEVEL_QUESTION_ID, REVIEW_LEVEL_SITE_ID, classifyReview, registerReviewLevelSite } from "./gate.js";
export type { ReviewGateInputs, ReviewGateResult } from "./gate.js";
export { registerReviewCommand, renderReview, runReview } from "./commands.js";
export type { ReviewCommandDeps } from "./commands.js";
