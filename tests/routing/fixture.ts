/**
 * Fixtures for the PRD-020 routing suite.
 *
 * Real modules throughout: a real ranking file through PRD-024's validator, a
 * real `LeanPiConfig` through PRD-001's loader, real run records in PRD-015's
 * shape. Only the model calls and the telemetry store are fixtures, which is
 * exactly what "works offline" means for a router.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type LeanPiConfig } from "../../src/index.js";
import type { CapabilitySetting } from "../../src/capability/roles.js";
import type { ModelCapability, RankingFile } from "../../src/capability/schema.js";
import type { ExecutionContract, ExecutionComplexity, ExecutorClass, RequiredCapability } from "../../src/compiler/contract.js";
import type { RunTelemetry } from "../../src/telemetry/record.js";
import type { CostConfig } from "../../src/telemetry/pricing.js";
import { tempDir } from "../helpers/fixtures.js";

export interface RankingRecordSpec {
	model_id: string;
	backend_hint: string | null;
	coding_score: number | null;
	input: number | null;
	output: number | null;
	specializations?: string[];
	aliases?: string[];
}

export function rankingRecord(spec: RankingRecordSpec): ModelCapability {
	return {
		model_id: spec.model_id,
		aliases: spec.aliases ?? [],
		provider: "fixture",
		backend_hint: spec.backend_hint,
		coding_score: spec.coding_score,
		general_score: spec.coding_score === null ? null : spec.coding_score - 5,
		specializations: spec.specializations ?? [],
		price_input_per_mtok: spec.input,
		price_output_per_mtok: spec.output,
		price_blended_per_mtok: spec.input === null || spec.output === null ? null : (3 * spec.input + spec.output) / 4,
		speed_tier: "medium",
		context_window: 200_000,
		updated_at: "2026-09-01",
		evidence: "estimated",
	};
}

/** Write a ranking the production validator accepts, and return its path. */
export function writeRanking(records: ModelCapability[], dir = tempDir("leanpi-ranking-")): string {
	const file: RankingFile = { revision: 1, notes: "routing fixture", models: records };
	const path = join(dir, "ranking.json");
	writeFileSync(path, JSON.stringify(file));
	return path;
}

export interface ConfigSpec {
	ranking: ModelCapability[];
	quota_shadow_usd?: Record<string, number>;
	latency_usd_per_sec?: number;
	local_usd_per_gpu_sec?: number;
	routing?: Record<string, unknown>;
	capability?: Partial<CapabilitySetting>;
	models?: Record<string, unknown>;
	backends?: Record<string, unknown>;
	cwd?: string;
}

/**
 * The three-backend pool the routing fixtures route over. PRD-024 binds a
 * ranked record through the spelling the config actually uses, so each entry
 * names the model id its backend serves.
 */
const BACKENDS: Record<string, unknown> = {
	claude: { type: "external_harness", command: "claude", model: "premium-fast", quota_class: "scarce-premium", priority: 20 },
	opencode: { type: "external_harness", command: "opencode", model: "budget-code", quota_class: "low-cost", priority: 10 },
	local: { type: "native", provider: "llama.cpp", model: "local-code", marginal_cost: 0 },
};

export function routingConfig(spec: ConfigSpec): { config: LeanPiConfig; cwd: string; rankingPath: string } {
	const cwd = spec.cwd ?? tempDir("leanpi-routing-");
	const rankingPath = writeRanking(spec.ranking, cwd);
	const cost: CostConfig = {
		quota_shadow_usd: spec.quota_shadow_usd ?? {},
		latency_usd_per_sec: spec.latency_usd_per_sec ?? 0,
		local_usd_per_gpu_sec: spec.local_usd_per_gpu_sec ?? 0,
	};
	const overrides = {
		backends: spec.backends ?? { ...BACKENDS },
		models: spec.models ?? { quick: { backend: "local", model: "local-code" } },
		capability: { stalenessDays: 90, ...(spec.capability ?? {}), rankingFile: rankingPath },
		cost,
		routing: { min_bucket_runs: 5, tie_band_usd: 0.001, ...(spec.routing ?? {}) },
		jev: { mode: "disabled", apiKey: "test-key", endpoint: "http://127.0.0.1:1/v1/systemone", model: "jev-latest" },
	} as unknown as Partial<LeanPiConfig>;
	return { config: loadConfig(cwd, overrides), cwd, rankingPath };
}

export interface ContractSpec {
	complexity: ExecutionComplexity;
	executor_class: ExecutorClass;
	required?: RequiredCapability;
	type?: string;
}

export function fixtureContract(spec: ContractSpec): ExecutionContract {
	return {
		task: {
			type: spec.type ?? "feature",
			prd_required: false,
			planning_decision: "DIRECT_EXECUTION",
			execution_complexity: spec.complexity,
			review_risk: "R1",
			required_capability: spec.required ?? { min_coding_index: 70 },
			user_request: "route this task",
		},
		routing: { executor_class: spec.executor_class, executor_backend: "unresolved", reviewer_class: "review_quick" },
		reasoning: { effort: "medium" },
		capabilities: { skills: [], mcps: [], lsp: false, rtk: "off" },
		context: { strategy: "targeted", budget_tokens: 12_000 },
		verification: { required: ["typecheck"] },
		limits: { execution_attempts: 3, semantic_review_rounds: 1 },
	};
}

export interface RunSpec {
	backend: string;
	model: string;
	complexity?: ExecutionComplexity;
	executor_class?: ExecutorClass;
	/** 1 counts as "needed more than one attempt". */
	retries?: number;
	wall_ms?: number;
	local_gpu_seconds?: number;
	input_tokens?: number;
	output_tokens?: number;
	success?: boolean;
}

export function runRecord(spec: RunSpec, index: number): RunTelemetry {
	return {
		task_id: `t${index}`,
		session_id: "s1",
		route: {
			complexity: spec.complexity ?? "MEDIUM",
			executor_class: spec.executor_class ?? "balanced",
			reviewer_class: "review_quick",
			reasoning: "medium",
		},
		prd_used: null,
		executor_backend: spec.backend,
		executor_model: spec.model,
		reviewer_backend: null,
		reviewer_model: null,
		usage: {
			input_tokens: spec.input_tokens ?? 1_000,
			cached_input_tokens: 0,
			output_tokens: spec.output_tokens ?? 200,
			reasoning_tokens: 0,
			jev_tokens: 0,
			local_gpu_seconds: spec.local_gpu_seconds ?? 0,
			external_harness_calls: 1,
			subscription_usage: 1,
		},
		cost: { api_usd: 0, jev_usd: 0, estimated_quota_cost: 0, effective_cost: 0 },
		execution: {
			wall_ms: spec.wall_ms ?? 5_000,
			tool_calls: 0,
			file_reads: 0,
			repeated_reads: 0,
			retries: spec.retries ?? 0,
			escalations: 0,
			compactions: 0,
		},
		result: { verification: "pass", proof_gate: "pass", reviewer: "pass", success: spec.success ?? true },
		capabilities: { skills_disclosed: [], skills_used: [], mcps_disclosed: [], mcps_used: [] },
		jev_decisions: [],
		calls: [],
	};
}

/** `count` runs on one backend, so a calibration bucket is over or under its sample floor. */
export function bucket(count: number, spec: RunSpec): RunTelemetry[] {
	return Array.from({ length: count }, (_, index) => runRecord(spec, index));
}
