/**
 * The §52 run record (PRD-015, ROADMAP §52, FR-149).
 *
 * One record per run, in the literal §52 shape plus four declared additions:
 * `session_id`, `jev_decisions[]`, `capabilities{}` (this PRD) and PRD-020's
 * `route_cost{}`. Everything downstream derives from this type, so a field
 * cannot silently go missing — `record.cost.effective_cost` is the only value
 * named "effective cost" in LeanPi, and it is a measurement, never a
 * prediction (PRD-020's pre-dispatch score lives in `route_cost`).
 */
import type { Billing } from "../backends/worker.js";
import type { ExecutionComplexity, ExecutorClass, ReviewerClass } from "../compiler/contract.js";
import type { BackendType, ModelRole } from "../core/types.js";

/** The classified route a run was dispatched at, copied whole from the contract. */
export interface RouteDescriptor {
	complexity: ExecutionComplexity;
	executor_class: ExecutorClass;
	reviewer_class: ReviewerClass;
	reasoning: "low" | "medium" | "high";
}

/** §52's eight usage fields. Accumulated across every attempt of the run. */
export interface RunUsage {
	input_tokens: number;
	cached_input_tokens: number;
	output_tokens: number;
	reasoning_tokens: number;
	jev_tokens: number;
	local_gpu_seconds: number;
	external_harness_calls: number;
	subscription_usage: number;
}

/** §52's four cost fields, in USD, rounded to 6 decimals at write time. */
export interface RunCost {
	api_usd: number;
	jev_usd: number;
	estimated_quota_cost: number;
	effective_cost: number;
}

/** §52's seven execution counters. */
export interface RunExecution {
	wall_ms: number;
	tool_calls: number;
	file_reads: number;
	repeated_reads: number;
	retries: number;
	escalations: number;
	compactions: number;
}

/** Verdicts copied from PRD-009 (evidence) and PRD-010 (proof gate); never decided here. */
export interface RunResult {
	verification: string;
	proof_gate: string;
	reviewer: string;
	success: boolean;
}

/** A site-level answer: one value, a serialized list for a multi-question site, or null. */
export type JevAnswer = string | number | boolean | null | Array<string | number | null>;

/**
 * One row per site invocation — the per-run projection of PRD-002's decision
 * log (`src/jev/log.ts`), not a second durable store. Σ `tokens` equals
 * `usage.jev_tokens`, which is what makes §56's JEV metrics computable from the
 * store alone.
 */
export interface JevDecisionRow {
	site_id: string;
	answer: JevAnswer;
	confidence: number | null;
	fallback_used: boolean;
	tokens: number;
}

/** §56's disclosure surface: what the contract disclosed versus what the run touched. */
export interface RunCapabilities {
	skills_disclosed: string[];
	skills_used: string[];
	mcps_disclosed: string[];
	mcps_used: string[];
}

/** PRD-020's *predicted* pre-dispatch route score. Declared, never computed here. */
export interface RouteCostBlock {
	monetary: number;
	quota_shadow: number;
	local_compute: number;
	latency: number;
	predicted_retry: number;
}

/**
 * One row per model/backend call, kept inside the run record (the store stays
 * one line per run). `backend_type` is §25's discriminant and `billing` is
 * FR-055's class, so the subscription-pool versus metered-API separation is
 * readable per call rather than only in the totals.
 */
export interface CallRow {
	timestamp: string;
	backend: string;
	backend_type: BackendType;
	model: string;
	role: ModelRole;
	/** Non-cached input tokens; cached input is priced separately and stays in `usage`. */
	inputTokens: number;
	outputTokens: number;
	/** USD for this call, 6-decimal rounded; 0 for subscription and local calls. */
	costUsd: number;
	quotaClass?: string;
	/** The run this call belongs to: the record's `task_id`. */
	runId?: string;
	billing?: Billing;
}

/** Call totals for one bucket (backend type or billing class), as an aggregate reports them. */
export interface CallTotals {
	calls: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

/** The §52 record plus this PRD's declared additions. */
export interface RunTelemetry {
	task_id: string;
	session_id: string;
	route: RouteDescriptor;
	prd_used: string | null;
	executor_backend: string | null;
	executor_model: string | null;
	reviewer_backend: string | null;
	reviewer_model: string | null;
	usage: RunUsage;
	cost: RunCost;
	execution: RunExecution;
	result: RunResult;
	capabilities: RunCapabilities;
	jev_decisions: JevDecisionRow[];
	/** Per-call rows; the store still holds one line per run. */
	calls: CallRow[];
	/** PRD-020's prediction, present only when that PRD supplies it. */
	route_cost?: RouteCostBlock;
}
