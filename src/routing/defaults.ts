/**
 * The shipped routing defaults (PRD-020).
 *
 * §10 requires thresholds to be calibrated from real LeanPi runs, so nothing
 * here is a branch: each value is the *fallback* the calibration reader returns
 * when the telemetry store is too thin to answer, and every one of them is
 * overridable from the `routing:` configuration block. The only value that is
 * genuinely a shipped opinion — the §14 matrix's retry rate, which §14 never
 * states as a number — lives here in one place rather than being written into
 * the derivation.
 */

/** FR-048's effort levels; `minimal` is below the contract's static `reasoning.effort` floor. */
export type EffortLevel = "minimal" | "low" | "medium" | "high";

/** ROADMAP §34's escalation vocabulary. Application code performs the escalation. */
export type EscalationCategory =
	| "GET_MORE_CONTEXT"
	| "ENABLE_CAPABILITY"
	| "INCREASE_REASONING"
	| "SWITCH_MODEL"
	| "SWITCH_BACKEND"
	| "STRONG_REVIEW"
	| "USER_INPUT"
	| "STOP_BLOCKED";

/** The three decision sites this PRD registers with PRD-002's registry. */
export const ROUTING_SITE_IDS = {
	quota_preference: "routing.quota_preference",
	reasoning_effort: "routing.reasoning_effort",
	delegation_worth: "routing.delegation_worth",
} as const;

export type RoutingSiteId = (typeof ROUTING_SITE_IDS)[keyof typeof ROUTING_SITE_IDS];

export const ROUTING_DEFAULTS = {
	/** Predicted token counts for a candidate whose (role, complexity, backend) bucket has no telemetry. */
	predicted_input_tokens: 8_000,
	predicted_output_tokens: 1_500,
	/** Share of the predicted input billed at the cached rate. */
	predicted_cached_input_fraction: 0.5,
	/** Higher effort buys more output tokens, and more input to read them back. */
	effort_token_multiplier: { minimal: 0.5, low: 0.75, medium: 1, high: 1.75 } as Record<EffortLevel, number>,
	/** §14's static complexity → effort table, before the bucket's retry rate adjusts it. */
	effort_by_complexity: { LOW: "minimal", MEDIUM: "medium", HIGH: "high" } as Record<string, EffortLevel>,
	/** An observed bucket retry rate above this raises its effort one level. */
	retry_effort_threshold: 0.25,
	/** The §14 matrix's retry rate: the fallback a thin bucket returns, recorded as insufficient-history. */
	matrix_retry_rate: 0.2,
	/** Completed runs a (role, complexity, backend) bucket needs before its observed values are used. */
	min_bucket_runs: 5,
	/** Candidates within this many USD of the cheapest may be reordered by `routing.quota_preference`. */
	tie_band_usd: 0.002,
	/** Declared independent slices above which delegation is worth its extra dispatch. */
	delegation_slice_threshold: 2,
	/** Predicted local GPU/CPU seconds when telemetry has measured none for the bucket. */
	local_gpu_seconds: 30,
	/** Predicted wall time in ms when telemetry has measured none for the bucket. */
	latency_ms: 20_000,
} as const;

export type RoutingDefaults = typeof ROUTING_DEFAULTS;
