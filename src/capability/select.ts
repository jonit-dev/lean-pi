/**
 * Capability selection (PRD-024 Phase 2).
 *
 * Pure arithmetic over ranked records: a record is selectable when it is
 * *bound* (its `backend_hint` resolves to a configured, enabled backend) and its
 * `coding_score` is known. `required_capability.min_coding_index` is a floor, so
 * "cheapest clearing" is a minimum blended price subject to that floor — never a
 * vendor comparison, never a semantic judgement, and never a silent downgrade.
 *
 * A null price is *unknown*, which cannot be proven cheaper than a known price;
 * such a record sorts after every record with a known price when nothing else
 * separates them. `ponytail:` that is the whole ordering rule — a genuine local
 * backend publishes 0, so "free" is expressed by data, not by a null.
 */
import type { BackendRef, BackendType, LeanPiConfig } from "../core/types.js";
import type { RequiredCapability } from "../compiler/contract.js";
import type { RankedModel, Ranking } from "./schema.js";

/** One selectable record: the ranked metrics plus the binding to dispatch through. */
export interface CapabilityCandidate {
	model_id: string;
	/** The configured backend key. */
	backend: string;
	/** The model spelling that backend is configured with. */
	model: string;
	type: BackendType;
	/** Known by construction: a record with a null score is never a candidate. */
	coding_score: number;
	general_score: number | null;
	price_blended_per_mtok: number | null;
	specializations: string[];
	/** `backends.<id>.quota_class`, the single scarcity class PRD-015/PRD-020 price. Null when unset. */
	quota_class: string | null;
}

/** Why the requested bar was not met, and what was chosen instead. */
export interface CapabilityGap {
	requested: number;
	best_available: number | null;
	reason: string;
}

export interface ClearingSelection {
	/** The cheapest clearing candidate's binding; the escalated record when nothing cleared. */
	ref: BackendRef | null;
	/** Every clearing candidate, cheapest first. Empty when nothing cleared — the caller escalates. */
	candidates: CapabilityCandidate[];
	/** Present exactly when no candidate cleared the requested bar. */
	capability_gap?: CapabilityGap;
}

/** The dispatchable ref for a candidate. */
export function candidateRef(candidate: CapabilityCandidate): BackendRef {
	return { backend: candidate.backend, model: candidate.model, type: candidate.type };
}

/** The quota class the scarcity price is keyed by, read from the backend entry (PRD-008/PRD-015). */
function quotaClassOf(config: LeanPiConfig | undefined, backend: string): string | null {
	const entry = config?.backends[backend];
	const value = entry?.quota_class;
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** The documented order: known price ascending, unknown price last, then score, then id. */
export function compareCandidates(a: CapabilityCandidate, b: CapabilityCandidate): number {
	const pa = a.price_blended_per_mtok;
	const pb = b.price_blended_per_mtok;
	if (pa !== null && pb !== null && pa !== pb) return pa - pb;
	if (pa === null && pb !== null) return 1;
	if (pa !== null && pb === null) return -1;
	if (a.coding_score !== b.coding_score) return b.coding_score - a.coding_score;
	return a.model_id < b.model_id ? -1 : a.model_id > b.model_id ? 1 : 0;
}

/** Every bound record with a known coding score, in no particular order. */
export function boundCandidates(ranking: Ranking, config?: LeanPiConfig): CapabilityCandidate[] {
	const candidates: CapabilityCandidate[] = [];
	for (const record of ranking.models) {
		if (!record.backend_binding || record.coding_score === null) continue;
		candidates.push({
			model_id: record.model_id,
			backend: record.backend_binding.backend,
			model: record.backend_binding.model,
			type: record.backend_binding.type,
			coding_score: record.coding_score,
			general_score: record.general_score,
			price_blended_per_mtok: record.price_blended_per_mtok,
			specializations: [...record.specializations],
			quota_class: quotaClassOf(config, record.backend_binding.backend),
		});
	}
	return candidates;
}

/**
 * The clearing set for `required_capability`: every bound record at or above the
 * floor (and carrying the specialization, when one is asked for), cheapest
 * first. When nothing clears, no selection is returned as a candidate — the
 * highest-scoring bound record is escalated into `ref` for visibility and the
 * shortfall is recorded in `capability_gap`.
 */
export function selectCheapestClearing(ranking: Ranking, required: RequiredCapability, config?: LeanPiConfig): ClearingSelection {
	const requested = required.min_coding_index;
	const bound = boundCandidates(ranking, config);
	const clearing = bound
		.filter((candidate) => candidate.coding_score >= requested)
		.filter((candidate) => required.specialization === undefined || candidate.specializations.includes(required.specialization));
	if (clearing.length > 0) {
		const candidates = clearing.sort(compareCandidates);
		return { ref: candidateRef(candidates[0]!), candidates };
	}

	const best = [...bound].sort((a, b) => b.coding_score - a.coding_score || (a.model_id < b.model_id ? -1 : 1))[0];
	if (!best) {
		return {
			ref: null,
			candidates: [],
			capability_gap: { requested, best_available: null, reason: `no ranked model has a reachable backend (coding index ${requested} requested)` },
		};
	}
	const qualifier = required.specialization === undefined ? "" : ` with specialization "${required.specialization}"`;
	return {
		ref: candidateRef(best),
		candidates: [],
		capability_gap: {
			requested,
			best_available: best.coding_score,
			reason: `no bound model clears coding index ${requested}${qualifier}; escalating to the highest-scoring bound model "${best.model_id}" (${best.coding_score})`,
		},
	};
}

/** The record a `model_id` or alias names, or undefined — the one alias-resolution rule. */
export function findRankedModel(ranking: Ranking, name: string): RankedModel | undefined {
	return ranking.models.find((record) => record.model_id === name || record.aliases.includes(name));
}
