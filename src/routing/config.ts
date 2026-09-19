/**
 * The routing configuration surface (PRD-020 Phase 1).
 *
 * Money and scarcity are read from PRD-015's `resolveCostConfig` — the same
 * loader `/cost` and the run record price from — so the shadow price a route
 * was scored with is the one telemetry records, and there is no per-backend
 * shadow field. The routing-specific knobs live in the `routing:` block with
 * the defaults declared in `defaults.ts`; a config that declares none of them
 * behaves exactly as the defaults describe.
 */
import type { ExecutionComplexity } from "../compiler/contract.js";
import { isModelRole, type LeanPiConfig, type ModelRole } from "../core/types.js";
import { resolveCostConfig } from "../telemetry/pricing.js";
import { ROUTING_DEFAULTS, ROUTING_SITE_IDS, type EffortLevel, type RoutingSiteId } from "./defaults.js";

export interface RoutingConfig {
	predicted_input_tokens: number;
	predicted_output_tokens: number;
	predicted_cached_input_fraction: number;
	effort_token_multiplier: Record<EffortLevel, number>;
	effort_by_complexity: Record<ExecutionComplexity, EffortLevel>;
	retry_effort_threshold: number;
	matrix_retry_rate: number;
	min_bucket_runs: number;
	tie_band_usd: number;
	delegation_slice_threshold: number;
	local_gpu_seconds: number;
	latency_ms: number;
	/** §25's scarcity price per quota class; PRD-015's single shadow-price key. */
	quota_shadow_usd: Record<string, number>;
	/** Seconds-to-cost weight applied to the observed p50 latency. */
	latency_usd_per_sec: number;
	/** GPU/CPU-seconds-to-cost weight applied to measured local compute. */
	local_usd_per_gpu_sec: number;
	/** Per-site switches; a site that is off always takes its deterministic fallback. */
	sites: Record<RoutingSiteId, boolean>;
	/** FR-047: the task's language / task type → the role that serves it. */
	specialists: Record<string, ModelRole>;
}

/** The `routing:` block as it may appear in `leanpi.config.yaml`. Every key is optional. */
interface RawRoutingConfig {
	predicted_input_tokens?: number;
	predicted_output_tokens?: number;
	predicted_cached_input_fraction?: number;
	effort_token_multiplier?: Partial<Record<EffortLevel, number>>;
	effort_by_complexity?: Partial<Record<ExecutionComplexity, EffortLevel>>;
	retry_effort_threshold?: number;
	matrix_retry_rate?: number;
	min_bucket_runs?: number;
	tie_band_usd?: number;
	delegation_slice_threshold?: number;
	local_gpu_seconds?: number;
	latency_ms?: number;
	sites?: Partial<Record<RoutingSiteId, boolean>>;
}

function positive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Resolve the routing surface. Rates come from `cost:` (PRD-015's block) so a
 * user sets the shadow price once and both the router and the record read it.
 */
export function resolveRoutingConfig(config?: LeanPiConfig | null): RoutingConfig {
	const raw = (config as { routing?: RawRoutingConfig } | null | undefined)?.routing ?? {};
	const cost = resolveCostConfig(config);
	const sites: Record<RoutingSiteId, boolean> = {
		[ROUTING_SITE_IDS.quota_preference]: true,
		[ROUTING_SITE_IDS.reasoning_effort]: true,
		[ROUTING_SITE_IDS.delegation_worth]: true,
	};
	for (const id of Object.values(ROUTING_SITE_IDS)) {
		const declared = raw.sites?.[id];
		if (typeof declared === "boolean") sites[id] = declared;
	}
	// FR-047's bindings live under `models:` (`models.specialists.<language|task_type>`),
	// read structurally because PRD-001's role parser rejects a non-role key there.
	const specialists: Record<string, ModelRole> = {};
	const declaredSpecialists = (config?.models as Record<string, unknown> | undefined)?.["specialists"];
	if (declaredSpecialists && typeof declaredSpecialists === "object" && !Array.isArray(declaredSpecialists)) {
		for (const [key, role] of Object.entries(declaredSpecialists as Record<string, unknown>)) {
			if (typeof role === "string" && isModelRole(role)) specialists[key] = role;
		}
	}
	return {
		predicted_input_tokens: positive(raw.predicted_input_tokens, ROUTING_DEFAULTS.predicted_input_tokens),
		predicted_output_tokens: positive(raw.predicted_output_tokens, ROUTING_DEFAULTS.predicted_output_tokens),
		predicted_cached_input_fraction: positive(raw.predicted_cached_input_fraction, ROUTING_DEFAULTS.predicted_cached_input_fraction),
		effort_token_multiplier: { ...ROUTING_DEFAULTS.effort_token_multiplier, ...(raw.effort_token_multiplier ?? {}) } as Record<EffortLevel, number>,
		effort_by_complexity: {
			LOW: raw.effort_by_complexity?.LOW ?? ROUTING_DEFAULTS.effort_by_complexity.LOW,
			MEDIUM: raw.effort_by_complexity?.MEDIUM ?? ROUTING_DEFAULTS.effort_by_complexity.MEDIUM,
			HIGH: raw.effort_by_complexity?.HIGH ?? ROUTING_DEFAULTS.effort_by_complexity.HIGH,
		},
		retry_effort_threshold: positive(raw.retry_effort_threshold, ROUTING_DEFAULTS.retry_effort_threshold),
		matrix_retry_rate: positive(raw.matrix_retry_rate, ROUTING_DEFAULTS.matrix_retry_rate),
		min_bucket_runs: positive(raw.min_bucket_runs, ROUTING_DEFAULTS.min_bucket_runs),
		tie_band_usd: positive(raw.tie_band_usd, ROUTING_DEFAULTS.tie_band_usd),
		delegation_slice_threshold: positive(raw.delegation_slice_threshold, ROUTING_DEFAULTS.delegation_slice_threshold),
		local_gpu_seconds: positive(raw.local_gpu_seconds, ROUTING_DEFAULTS.local_gpu_seconds),
		latency_ms: positive(raw.latency_ms, ROUTING_DEFAULTS.latency_ms),
		quota_shadow_usd: cost.quota_shadow_usd ?? {},
		latency_usd_per_sec: cost.latency_usd_per_sec ?? 0,
		local_usd_per_gpu_sec: cost.local_usd_per_gpu_sec ?? 0,
		sites,
		specialists,
	};
}
