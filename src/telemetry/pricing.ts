/**
 * Usage → money (PRD-015 Phase 1, ROADMAP §26).
 *
 * The one place a rate is read. Rates live in `LeanPiConfig`: per-backend token
 * rates in the Pi-convention `backends.<name>.cost` block (with `cost.models[model]`
 * as the per-model override), the single scarcity setting PRD-020 also reads
 * (`cost.quota_shadow_usd[quota_class]`), and the run-level GPU, latency and JEV
 * rates. A rate that is absent is 0, never an error: cost telemetry must not be
 * able to fail a run, and a pure-local session must record a truthful
 * `effective_cost` of 0 rather than a guess. A rate that is absent for a model
 * that *did* spend metered tokens is a different thing — that 0 is missing
 * accounting, not free work — so no rate is ever invented and `unpricedCalls`
 * names those rows, which is what lets a report say "known spend plus N
 * unpriced calls" instead of presenting a short total as the whole bill. JEV is
 * the one exception to "absent is 0": it is a single endpoint at a published
 * rate, so an unconfigured JEV rate is that price, not free.
 *
 * `api_usd` is metered spend only. A subscription call draws from a pool and a
 * local call burns compute, so both price at 0 here — the subscription/local
 * classes are measured by `usage.subscription_usage` and `usage.local_gpu_seconds`,
 * which is the FR-055 separation this record exists to carry.
 */
import type { LeanPiConfig } from "../core/types.js";
import { JEV_INPUT_COST_PER_MILLION } from "../jev/client.js";
import { billingOf, type BackendCall } from "./collect.js";
import type { CallRow, RunCost, RunUsage } from "./record.js";

/** USD per million tokens. */
export interface ModelRate {
	input: number;
	cachedInput: number;
	/** Writing the cache is billed above the input rate on every vendor's card. */
	cacheWrite: number;
	output: number;
}

/** The `cost:` block as declared in `leanpi.config.yaml`; every key is optional and defaults to 0. */
export interface CostConfig {
	/** Per-model override, keyed by model id. */
	models?: Record<string, Partial<ModelRate>>;
	/**
	 * Per-backend rates, keyed by backend name (also read from `backends.<name>.cost`,
	 * where Pi's own `ModelCostRates` names the two cache rates `cacheRead`/`cacheWrite`).
	 */
	backends?: Record<string, Partial<ModelRate> & { cacheRead?: number }>;
	/** The single scarcity setting: USD charged per call of a quota class. PRD-020 reads this same key. */
	quota_shadow_usd?: Record<string, number>;
	local_usd_per_gpu_sec?: number;
	latency_usd_per_sec?: number;
	jev_usd_per_mtok?: number;
	/** Store location override; `.leanpi/telemetry.jsonl` when absent. */
	telemetry_path?: string;
}

export const TELEMETRY_PATH_DEFAULT = ".leanpi/telemetry.jsonl";

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Read the cost surface out of a loaded config; a config with no `cost:` block prices everything at 0. */
export function resolveCostConfig(config?: LeanPiConfig | null): CostConfig {
	const raw = (config as { cost?: CostConfig } | null | undefined)?.cost ?? {};
	const backends: CostConfig["backends"] = {};
	for (const [name, entry] of Object.entries(config?.backends ?? {})) {
		const rates = (entry as { cost?: CostConfig["backends"] extends Record<string, infer R> ? R : never }).cost;
		if (rates && typeof rates === "object") backends[name] = rates;
	}
	return {
		models: raw.models ?? {},
		backends,
		quota_shadow_usd: raw.quota_shadow_usd ?? {},
		local_usd_per_gpu_sec: numberOf(raw.local_usd_per_gpu_sec),
		latency_usd_per_sec: numberOf(raw.latency_usd_per_sec),
		jev_usd_per_mtok: jevRate(config),
		...(typeof raw.telemetry_path === "string" && raw.telemetry_path.length > 0 ? { telemetry_path: raw.telemetry_path } : {}),
	};
}

/**
 * The JEV rate: the operator's `jev.usd_per_mtok` when they set one, else the
 * published price.
 *
 * Everything else here prices at 0 when unconfigured, which is right for a
 * backend LeanPi knows nothing about. JEV is not that: it is one endpoint at one
 * published rate, and defaulting it to 0 reported the control plane as free on
 * every machine that had never written the key — the audited session's whole
 * ledger, 292k tokens of it, costed at nothing. A deliberate `0` is still
 * honoured; only an absent value falls back.
 */
function jevRate(config?: LeanPiConfig | null): number {
	const declared = (config?.jev as { usd_per_mtok?: unknown } | undefined)?.usd_per_mtok;
	return typeof declared === "number" && Number.isFinite(declared) ? declared : JEV_INPUT_COST_PER_MILLION;
}

/** The rate a call is billed at: the per-model override, else the backend's Pi `cost` block, else 0. */
export function ratesFor(cost: CostConfig, backend: string, model: string): ModelRate {
	const override = cost.models?.[model];
	const declared = cost.backends?.[backend];
	return {
		input: numberOf(override?.input ?? declared?.input),
		cachedInput: numberOf(override?.cachedInput ?? declared?.cacheRead),
		cacheWrite: numberOf(override?.cacheWrite ?? declared?.cacheWrite),
		output: numberOf(override?.output ?? declared?.output),
	};
}

/** USD to 6 decimals; stored sums stay stable across runs. */
export function round6(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

/** The metered API cost of one call; 0 for a subscription or local call. */
export function priceCall(call: BackendCall, cost: CostConfig): number {
	if (billingOf(call) !== "metered") return 0;
	const rates = ratesFor(cost, call.backend, call.model);
	const usage = call.usage;
	const input = usage.inputTokens ?? usage.tokens ?? 0;
	return round6(
		(input * rates.input +
			(usage.cachedInputTokens ?? 0) * rates.cachedInput +
			(usage.cacheWriteTokens ?? 0) * rates.cacheWrite +
			(usage.outputTokens ?? 0) * rates.output +
			(usage.reasoningTokens ?? 0) * rates.output) /
			1_000_000,
	);
}

/** The quota shadow price of one call: the price of the class it declared, 0 when the class is unlisted. */
export function priceQuota(call: BackendCall, cost: CostConfig): number {
	if (!call.quotaClass) return 0;
	return numberOf(cost.quota_shadow_usd?.[call.quotaClass]);
}

/**
 * The metered calls this store cannot value: they carry tokens and were recorded
 * at $0 because nothing on the rate card matched their model. Read off the
 * stored rows rather than re-priced — the row is what the total was computed
 * from, and a reader holding a record has no access to the config that priced
 * it. A subscription or local call is legitimately $0 and is not in here.
 */
export function unpricedCalls(calls: readonly CallRow[]): CallRow[] {
	return calls.filter(
		(call) => (call.billing ?? "metered") === "metered" && call.inputTokens + call.outputTokens > 0 && call.costUsd === 0,
	);
}

/**
 * §26's six-term measure of what a run cost.
 *
 * `effective_cost = api_usd + jev_usd + quota_shadow_cost + local_compute_cost + latency_penalty`,
 * where `quota_shadow_cost` is §52's `estimated_quota_cost`. There is no
 * predicted-retry term: a prediction has no place in a measurement.
 */
export function priceRun(input: { calls: readonly BackendCall[]; usage: RunUsage; wallMs: number }, cost: CostConfig): RunCost {
	let api = 0;
	let quota = 0;
	for (const call of input.calls) {
		api += priceCall(call, cost);
		quota += priceQuota(call, cost);
	}
	const jev = (input.usage.jev_tokens * numberOf(cost.jev_usd_per_mtok)) / 1_000_000;
	const local = input.usage.local_gpu_seconds * numberOf(cost.local_usd_per_gpu_sec);
	const latency = (input.wallMs / 1000) * numberOf(cost.latency_usd_per_sec);
	return {
		api_usd: round6(api),
		jev_usd: round6(jev),
		estimated_quota_cost: round6(quota),
		effective_cost: round6(api + jev + quota + local + latency),
	};
}
