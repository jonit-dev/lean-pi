/**
 * Adaptive routing and quota pricing (PRD-020). `src/index.ts` re-exports this
 * module; nothing here imports the package entry, so the entry stays a leaf.
 */
export {
	bucketStats,
	classifyFailure as classifyRouteFailure,
	failureSignature as routeFailureSignature,
	historicalSignatures,
	type AttemptFailure,
	type BucketKey,
	type BucketStats,
	type CalibrationInput,
	type CalibrationState,
	type FailureClass,
	type FailureVerdict,
} from "./calibration.js";
export { defaultClearingSource, type ClearingResult, type ClearingSource } from "./candidates.js";
export { resolveRoutingConfig, type RoutingConfig } from "./config.js";
export { predictRouteCost, routeCostBlock, type PredictRouteCostInput, type RouteCandidate, type RouteCostPrediction } from "./cost.js";
export { ROUTING_DEFAULTS, ROUTING_SITE_IDS, type EffortLevel, type EscalationCategory, type RoutingSiteId } from "./defaults.js";
export {
	adjustedEffort,
	dispatchRequest,
	effortParameterOf,
	routeDescriptorOf,
	selectRoute,
	withRouteCost,
	type RouteDecision,
	type RouteRequest,
	type RoutingJevClient,
	type ScoredCandidate,
} from "./router.js";
export {
	DELEGATION_WORTH_SITE_ID,
	EFFORT_LEVELS,
	QUOTA_PREFERENCE_SITE_ID,
	REASONING_EFFORT_SITE_ID,
	registerRoutingSites,
	type DelegationState,
	type EffortState,
	type QuotaPreferenceState,
} from "./sites.js";
