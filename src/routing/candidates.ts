/**
 * The clearing candidate source (PRD-020 Phase 1).
 *
 * The capability filter is PRD-024's, not a second one: this module only adapts
 * `selectCheapestClearing()`'s ranked records into the shape the cost scorer
 * reads, joining each candidate with its reachable backend's billing class,
 * quota class and priority (PRD-008's `parseBackendPool`, so billing is derived
 * once for the whole codebase) and with the prices PRD-024 supplies on the same
 * basis PRD-015 records.
 *
 * The required capability reaches PRD-024 as a **coding floor**. Its
 * `specialization` dimension is resolved by FR-047's `models.specialists`
 * preference in the router instead: PRD-024's specialization filter would
 * remove the generic role's model from the clearing set, which would make the
 * specialist preference a no-op and make "drop the specialist entry, get the
 * generic role" unreachable. The floor is still PRD-024's, so a below-bar model
 * is never scored — cheapness can never buy an inadequate model.
 */
import type { RegisteredBackend } from "../backends/registry.js";
import { parseBackendPool } from "../backends/registry.js";
import { loadRanking, type Ranking } from "../capability/index.js";
import type { CapabilityGap } from "../capability/select.js";
import { selectCheapestClearing } from "../capability/select.js";
import type { RequiredCapability } from "../compiler/contract.js";
import { isModelRole, type LeanPiConfig, type ModelRole } from "../core/types.js";
import type { RouteCandidate } from "./cost.js";

export interface InventoryEntry {
	/** The `model_id` a candidate id uses. */
	id: string;
	backend: string;
	/** Why this model is or is not in this turn's clearing set. */
	reason: string;
}

export interface ClearingResult {
	/** Every candidate that cleared the floor, ranked by `route_cost` by this PRD. */
	candidates: RouteCandidate[];
	/**
	 * Every model the ranking or the config knows, eligible or excluded, with the
	 * reason. Runtime JEV gets this as decision data; the eligible candidates above
	 * are the only enum it may choose from.
	 */
	inventory?: InventoryEntry[];
	/** Present when nothing cleared: an escalation, never a dispatch (PRD-024 AC-4). */
	capability_gap?: CapabilityGap;
}

/** The router's seam: the default reads PRD-024; a test may substitute its own set. */
export type ClearingSource = (input: { required: RequiredCapability; config: LeanPiConfig }) => ClearingResult;

/** The roles whose `models:` entry names this (backend, model). */
function rolesFor(config: LeanPiConfig, backend: string, model: string): ModelRole[] {
	// `models.specialists` (FR-047) keys are languages, not roles, so the role
	// guard keeps them out of a candidate's role list.
	return Object.entries(config.models)
		.filter(([role, entry]) => isModelRole(role) && entry && entry.backend === backend && entry.model === model)
		.map(([role]) => role as ModelRole);
}

/**
 * Build the default source once per session: the ranking is loaded once, and the
 * backend pool is parsed once, so scoring a candidate costs no I/O.
 */
export function defaultClearingSource(config: LeanPiConfig): ClearingSource {
	const ranking: Ranking = loadRanking(config);
	const backends: Record<string, RegisteredBackend> = Object.fromEntries(parseBackendPool(config).map((backend) => [backend.name, backend]));
	const records: Record<string, Ranking["models"][number]> = Object.fromEntries(ranking.models.map((record) => [record.model_id, record]));

	return ({ required }) => {
		const selection = selectCheapestClearing(ranking, { min_coding_index: required.min_coding_index }, config);
		const candidates: RouteCandidate[] = [];
		for (const candidate of selection.candidates) {
			const record = records[candidate.model_id];
			const backend = backends[candidate.backend];
			candidates.push({
				id: candidate.model_id,
				backend: candidate.backend,
				model: candidate.model,
				billing: backend?.billing ?? (candidate.type === "external_harness" ? "subscription" : "metered"),
				quota_class: candidate.quota_class,
				coding_score: candidate.coding_score,
				price_input_per_mtok: record?.price_input_per_mtok ?? null,
				price_output_per_mtok: record?.price_output_per_mtok ?? null,
				roles: rolesFor(config, candidate.backend, candidate.model),
				priority: backend?.priority ?? 0,
			});
		}
		return { candidates, inventory: inventoryOf(ranking, config, candidates), ...(selection.capability_gap ? { capability_gap: selection.capability_gap } : {}) };
	};
}

/**
 * Every model the runtime knows, with why it is or is not eligible this turn.
 * The ranking is the inventory; a configured model the ranking does not carry is
 * appended as unmeasured. JEV sees all of it, chooses only from the eligible set.
 */
function inventoryOf(ranking: Ranking, config: LeanPiConfig, eligible: readonly RouteCandidate[]): InventoryEntry[] {
	const eligibleKeys = new Set(eligible.map((candidate) => candidate.id));
	const rankedSpellings = new Set(ranking.models.flatMap((record) => [record.model_id, ...record.aliases]));
	const entries: InventoryEntry[] = [];
	const seen = new Set<string>();
	for (const record of ranking.models) {
		const binding = record.backend_binding;
		const key = binding ? `${binding.backend}/${record.model_id}` : record.model_id;
		if (seen.has(key)) continue;
		seen.add(key);
		const reason =
			binding === null
				? "no enabled backend binds it"
				: eligibleKeys.has(record.model_id)
					? "clears the floor this turn"
					: record.coding_score === null
						? "no known coding score"
						: `coding score ${record.coding_score} below the requested floor`;
		entries.push({ id: record.model_id, backend: binding?.backend ?? "", reason });
	}
	for (const [role, entry] of Object.entries(config.models)) {
		if (!isModelRole(role) || !entry) continue;
		// A config entry the ranking already carries (by id or alias) is listed
		// above; only a genuinely unmeasured spelling is appended here.
		if (rankedSpellings.has(entry.model)) continue;
		const key = `${entry.backend}/${entry.model}`;
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({ id: entry.model, backend: entry.backend, reason: "not in the ranking (unmeasured)" });
	}
	return entries;
}
