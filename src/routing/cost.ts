/**
 * `predictRouteCost()` — §26 as a **pre-dispatch prediction** (PRD-020 Phase 1).
 *
 * ```text
 * route_cost = monetary + quota_shadow + local_compute + latency + predicted_retry
 * ```
 *
 * This is an estimate used to rank candidates before anything runs. It is
 * deliberately not PRD-015's `effective_cost`: that name belongs to the measured
 * post-hoc value (`api_usd + jev_usd + estimated_quota_cost + local_compute +
 * latency`), which `/cost` renders and this module never recomputes. The five
 * terms here are persisted as the run record's `route_cost` block, so a
 * prediction and a measurement are never summed together.
 *
 * Every term comes from an existing source: the bundled ranking's price times
 * predicted tokens; the configured shadow price of the candidate's quota class
 * (the same `cost.quota_shadow_usd` key PRD-015 prices from); the calibrated p50
 * of measured local compute; the calibrated p50 latency times the configured
 * seconds-to-cost weight; and the bucket's calibrated retry rate times the cost
 * of one more attempt.
 */
import type { ExecutionComplexity } from "../compiler/contract.js";
import type { LeanPiConfig, ModelRole } from "../core/types.js";
import type { Billing } from "../backends/worker.js";
import type { RouteCostBlock, RunTelemetry } from "../telemetry/record.js";
import { ratesFor, resolveCostConfig, round6, type CostConfig } from "../telemetry/pricing.js";
import { bucketStats, type CalibrationState } from "./calibration.js";
import type { RoutingConfig } from "./config.js";
import type { EffortLevel } from "./defaults.js";

/** One model PRD-024 returned as clearing `required_capability`, joined with its reachable backend. */
export interface RouteCandidate {
	/** The ranking's model id; the id a `routing.quota_preference` answer names. */
	id: string;
	backend: string;
	model: string;
	billing: Billing;
	/** §25's quota pool this backend draws from; `null` when the backend declares none. */
	quota_class: string | null;
	coding_score: number;
	price_input_per_mtok: number | null;
	price_output_per_mtok: number | null;
	/** Roles whose `models:` binding names this (backend, model); empty when none does. */
	roles: ModelRole[];
	/** PRD-008's configured backend priority; the deterministic tie-break below `route_cost`. */
	priority: number;
}

export interface RouteCostPrediction extends RouteCostBlock {
	route_cost: number;
	calibration: CalibrationState;
}

export interface PredictRouteCostInput {
	candidate: RouteCandidate;
	/** The executor role the candidate was scored for; half of the calibration bucket key. */
	role: string;
	complexity: ExecutionComplexity;
	effort: EffortLevel;
	routing: RoutingConfig;
	/** PRD-015's cost surface; when absent the same block is read from `config`. */
	cost?: CostConfig;
	config?: LeanPiConfig | null;
	/** Completed runs of this project; the calibration source. */
	history: readonly RunTelemetry[];
}

/**
 * Score one candidate. Higher effort raises the predicted token counts *before*
 * pricing, so an expensive effort level has to justify itself in the same units
 * as everything else rather than being a free knob.
 */
export function predictRouteCost(input: PredictRouteCostInput): RouteCostPrediction {
	const { candidate, routing } = input;
	const cost = input.cost ?? resolveCostConfig(input.config);
	const multiplier = routing.effort_token_multiplier[input.effort] ?? 1;
	const bucket = bucketStats({
		history: input.history,
		key: { role: input.role, complexity: input.complexity, backend: candidate.backend },
		min_bucket_runs: routing.min_bucket_runs,
		matrix_retry_rate: routing.matrix_retry_rate,
		fallback: {
			latency_ms: routing.latency_ms,
			local_gpu_seconds: routing.local_gpu_seconds,
			input_tokens: routing.predicted_input_tokens,
			output_tokens: routing.predicted_output_tokens,
		},
	});

	// The ranking's price is authoritative for a ranked model; the configured
	// `cost:` rates are the fallback for a model the ranking prices as unknown.
	const configured = ratesFor(cost, candidate.backend, candidate.model);
	const inputRate = candidate.price_input_per_mtok ?? configured.input;
	const outputRate = candidate.price_output_per_mtok ?? configured.output;
	const totalInput = bucket.input_tokens * multiplier;
	const cachedInputTokens = totalInput * routing.predicted_cached_input_fraction;
	const inputTokens = totalInput - cachedInputTokens;
	const outputTokens = bucket.output_tokens * multiplier;

	const monetary =
		candidate.billing === "metered"
			? round6((inputTokens * inputRate + cachedInputTokens * configured.cachedInput + outputTokens * outputRate) / 1_000_000)
			: 0;
	const quota_shadow = round6(candidate.quota_class === null ? 0 : (routing.quota_shadow_usd[candidate.quota_class] ?? 0));
	const local_compute = round6(candidate.billing === "local" ? bucket.local_gpu_seconds * routing.local_usd_per_gpu_sec : 0);
	const latency = round6((bucket.latency_p50_ms / 1000) * routing.latency_usd_per_sec);
	// One more attempt re-spends the scarce resources, not the tokens already paid for.
	const predicted_retry = round6(bucket.retry_rate * (monetary + quota_shadow + local_compute));

	return {
		monetary,
		quota_shadow,
		local_compute,
		latency,
		predicted_retry,
		route_cost: round6(monetary + quota_shadow + local_compute + latency + predicted_retry),
		calibration: bucket.calibration,
	};
}

/** The record's block: the five terms only — PRD-015 owns the record shape, this PRD its block. */
export function routeCostBlock(prediction: RouteCostPrediction): RouteCostBlock {
	return {
		monetary: prediction.monetary,
		quota_shadow: prediction.quota_shadow,
		local_compute: prediction.local_compute,
		latency: prediction.latency,
		predicted_retry: prediction.predicted_retry,
	};
}
