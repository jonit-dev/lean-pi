/**
 * The `/models` projection (PRD-024 Phase 3).
 *
 * A pure join of the ranking with the current role resolutions: one row per
 * ranked record, carrying the record's metrics, the roles it fills, and the
 * ranking's revision plus staleness. This module renders nothing and parses no
 * arguments — `/models` (PRD-016, `src/commands/model.ts`) owns the surface, and
 * there is no second list of models anywhere: adding a record to the ranking
 * adds exactly one row here.
 */
import { MODEL_ROLES, type BackendRef, type ModelRole } from "../core/types.js";
import type { RoleSelection } from "./roles.js";
import type { Evidence, Ranking } from "./schema.js";

export interface CapabilityRow {
	model_id: string;
	/** Display only; never a routing input. */
	provider: string;
	coding_score: number | null;
	general_score: number | null;
	price_blended_per_mtok: number | null;
	evidence: Evidence;
	/** The roles this record currently fills, in `MODEL_ROLES` order. Empty means unselected. */
	roles: ModelRole[];
	backend_binding: BackendRef | null;
	/** The ranking these values came from, repeated per row so a row is self-describing. */
	revision: number;
	oldest_updated_at: string;
	age_days: number;
	stale: boolean;
}

/**
 * One row per ranked record, role-filled first, then `coding_score` descending
 * (null scores last), then `model_id`. `roleResolutions` is the current set —
 * changing a role pin changes the role-fill column with the ranking untouched.
 */
export function capabilityRows(ranking: Ranking, roleResolutions: readonly RoleSelection[]): CapabilityRow[] {
	const filledBy = new Map<string, ModelRole[]>();
	for (const selection of roleResolutions) {
		if (selection.model_id === null) continue;
		const roles = filledBy.get(selection.model_id) ?? [];
		if (!roles.includes(selection.role)) roles.push(selection.role);
		filledBy.set(selection.model_id, roles);
	}
	return ranking.models
		.map((record): CapabilityRow => {
			const roles = filledBy.get(record.model_id) ?? [];
			return {
				model_id: record.model_id,
				provider: record.provider,
				coding_score: record.coding_score,
				general_score: record.general_score,
				price_blended_per_mtok: record.price_blended_per_mtok,
				evidence: record.evidence,
				roles: [...roles].sort((a, b) => MODEL_ROLES.indexOf(a) - MODEL_ROLES.indexOf(b)),
				backend_binding: record.backend_binding,
				revision: ranking.revision,
				oldest_updated_at: ranking.oldest_updated_at,
				age_days: ranking.age_days,
				stale: ranking.stale,
			};
		})
		.sort((a, b) => Number(b.roles.length > 0) - Number(a.roles.length > 0) || (b.coding_score ?? -1) - (a.coding_score ?? -1) || (a.model_id < b.model_id ? -1 : 1));
}
