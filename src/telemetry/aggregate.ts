/**
 * The store's aggregator (PRD-015).
 *
 * One fold over the persisted runs plus PRD-002's decision log, so §56's JEV
 * metrics (fallback rate, token share, per-site attribution) and §3's objective
 * — effective cost per verified success — are computable without re-running
 * anything. Reads degrade: a missing store, a missing decision log or a
 * partially-written line yields the rows that parse, never a throw.
 */
import { readDecisions, type DecisionRow } from "../jev/log.js";
import type { CallTotals, RunTelemetry } from "./record.js";
import type { CostConfig } from "./pricing.js";
import { readRuns, type RunFilter } from "./store.js";

/** Per-site JEV attribution; every §56 site metric is a function of these three numbers. */
export interface SiteJevTotals {
	decisions: number;
	fallbacks: number;
	tokens: number;
}

export interface JevTotals {
	decisions: number;
	answered: number;
	fallbacks: number;
	/** Share of resolved sites that fell back; 0 when no site resolved. */
	fallbackRate: number;
	tokens: number;
	/** JEV tokens as a share of every token the runs spent; 0 when nothing was spent. */
	tokenShare: number;
	sites: Record<string, SiteJevTotals>;
}

export interface TelemetryAggregate {
	runs: number;
	apiUsd: number;
	jevUsd: number;
	quotaUsd: number;
	effectiveCostUsd: number;
	verifiedSuccesses: number;
	/** §3's objective; `null` when no run succeeded, never `Infinity`/`NaN`. */
	costPerVerifiedSuccess: number | null;
	/** §25's split: what metered APIs billed versus what pooled harnesses ran. */
	byBackendType: Record<string, CallTotals>;
	/** FR-055's split, which is the one that explains a zero `api_usd`. */
	byBilling: Record<string, CallTotals>;
	jev: JevTotals;
}

function emptyCallTotals(): CallTotals {
	return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

export function aggregateRuns(
	runs: readonly RunTelemetry[],
	options: { decisions?: readonly DecisionRow[] } = {},
): TelemetryAggregate {
	const byBackendType: Record<string, CallTotals> = { native: emptyCallTotals(), external_harness: emptyCallTotals() };
	const byBilling: Record<string, CallTotals> = {
		subscription: emptyCallTotals(),
		metered: emptyCallTotals(),
		local: emptyCallTotals(),
	};
	let apiUsd = 0;
	let jevUsd = 0;
	let quotaUsd = 0;
	let effectiveCostUsd = 0;
	let verifiedSuccesses = 0;
	let totalTokens = 0;

	for (const run of runs) {
		apiUsd += run.cost?.api_usd ?? 0;
		jevUsd += run.cost?.jev_usd ?? 0;
		quotaUsd += run.cost?.estimated_quota_cost ?? 0;
		effectiveCostUsd += run.cost?.effective_cost ?? 0;
		if (run.result?.success === true) verifiedSuccesses += 1;
		totalTokens += (run.usage?.input_tokens ?? 0) + (run.usage?.output_tokens ?? 0);
		for (const call of run.calls ?? []) {
			for (const bucket of [byBackendType[call.backend_type], byBilling[call.billing ?? "metered"]]) {
				if (!bucket) continue;
				bucket.calls += 1;
				bucket.inputTokens += call.inputTokens ?? 0;
				bucket.outputTokens += call.outputTokens ?? 0;
				bucket.costUsd += call.costUsd ?? 0;
			}
		}
	}

	const sites: Record<string, SiteJevTotals> = {};
	let decisions = 0;
	let fallbacks = 0;
	let jevTokens = 0;
	for (const row of options.decisions ?? []) {
		const tokens = (row.tokens?.inputTokens ?? 0) + (row.tokens?.outputTokens ?? 0);
		decisions += 1;
		jevTokens += tokens;
		if (row.fallbackUsed) fallbacks += 1;
		const site = (sites[row.siteId] ??= { decisions: 0, fallbacks: 0, tokens: 0 });
		site.decisions += 1;
		site.tokens += tokens;
		if (row.fallbackUsed) site.fallbacks += 1;
	}

	return {
		runs: runs.length,
		apiUsd,
		jevUsd,
		quotaUsd,
		effectiveCostUsd,
		verifiedSuccesses,
		costPerVerifiedSuccess: verifiedSuccesses === 0 ? null : effectiveCostUsd / verifiedSuccesses,
		byBackendType,
		byBilling,
		jev: {
			decisions,
			answered: decisions - fallbacks,
			fallbacks,
			fallbackRate: decisions === 0 ? 0 : fallbacks / decisions,
			tokens: jevTokens,
			tokenShare: totalTokens + jevTokens === 0 ? 0 : jevTokens / (totalTokens + jevTokens),
			sites,
		},
	};
}

/** Read the store (and the decision log) for a project, then fold it. */
export function aggregateTelemetry(
	cwd: string,
	options: RunFilter & { cost?: CostConfig; decisions?: readonly DecisionRow[] } = {},
): TelemetryAggregate {
	const { cost, decisions, ...filter } = options;
	return aggregateRuns(readRuns(cwd, filter, cost), { decisions: decisions ?? readDecisions(cwd) });
}
