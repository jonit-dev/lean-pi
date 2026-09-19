/**
 * Role binding (PRD-024 Phase 2): `capability.roles.<role>` → a ranked model.
 *
 * Roles are floors and ceilings over the ranking, never vendor names. A `pin` is
 * the only explicit override and always wins; when the pinned record cannot
 * satisfy the role, the pin is still returned and the shortfall is reported —
 * a user who pinned a model must not be silently swapped onto another one.
 *
 * The `capability:` block is read structurally: PRD-024 does not own
 * `src/core/types.ts`, so every key is optional here with a documented default
 * and unknown keys are ignored.
 */
import { MODEL_ROLES, type BackendRef, type LeanPiConfig, type ModelRole } from "../core/types.js";
import type { RankedModel, Ranking } from "./schema.js";
import { boundCandidates, candidateRef, compareCandidates, findRankedModel, type CapabilityGap } from "./select.js";

/** `capability.roles.<role>`: a coding floor, an optional price ceiling, an optional pin. */
export interface CapabilityRoleSetting {
	/** Minimum `coding_score`; the documented band anchors set the defaults below. */
	min_coding_index: number;
	/** USD per million blended tokens. Absent means no ceiling. */
	max_blended_price?: number;
	/** A `model_id` or alias; resolves the role unconditionally. */
	pin?: string;
}

export interface CapabilitySetting {
	/** A validated override for the bundled ranking. Absent means the bundled file. */
	rankingFile?: string | null;
	/** Days after which the oldest role-filling record is reported stale. */
	stalenessDays?: number;
	roles?: Partial<Record<ModelRole, CapabilityRoleSetting>>;
	/** Owner-gated live catalog (see `catalog.ts`); off unless its env flag is set. */
	liveCatalog?: boolean;
}

export interface ResolvedCapabilitySetting {
	rankingFile: string | null;
	stalenessDays: number;
	roles: Record<ModelRole, CapabilityRoleSetting>;
}

/**
 * The documented defaults. `capability.roles.<role>.min_coding_index` defaults
 * to the band anchor for that role (50/70/85 on the scoring scale), and no role
 * carries a price ceiling unless the user sets one.
 */
export const DEFAULT_STALENESS_DAYS = 90;

export const DEFAULT_ROLE_SETTINGS: Record<ModelRole, CapabilityRoleSetting> = {
	quick: { min_coding_index: 50 },
	balanced: { min_coding_index: 70 },
	strong: { min_coding_index: 85 },
	specialist: { min_coding_index: 70 },
	review_quick: { min_coding_index: 70 },
	review_strong: { min_coding_index: 85 },
};

/** Read the `capability:` block off the config, filling defaults and ignoring unknown keys. */
export function capabilityConfigOf(config: LeanPiConfig): ResolvedCapabilitySetting {
	const raw = (config as { capability?: unknown }).capability;
	const setting: CapabilitySetting = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as CapabilitySetting) : {};
	const roles = { ...DEFAULT_ROLE_SETTINGS };
	for (const role of MODEL_ROLES) {
		const entry = setting.roles?.[role];
		if (entry === undefined) continue;
		const floor = entry.min_coding_index;
		const ceiling = entry.max_blended_price;
		roles[role] = {
			min_coding_index: typeof floor === "number" && Number.isFinite(floor) ? floor : DEFAULT_ROLE_SETTINGS[role].min_coding_index,
			...(typeof ceiling === "number" && Number.isFinite(ceiling) ? { max_blended_price: ceiling } : {}),
			...(typeof entry.pin === "string" && entry.pin.length > 0 ? { pin: entry.pin } : {}),
		};
	}
	return {
		rankingFile: typeof setting.rankingFile === "string" && setting.rankingFile.length > 0 ? setting.rankingFile : null,
		stalenessDays: typeof setting.stalenessDays === "number" && Number.isFinite(setting.stalenessDays) && setting.stalenessDays >= 0 ? setting.stalenessDays : DEFAULT_STALENESS_DAYS,
		roles,
	};
}

/** A pin naming a model the ranking does not carry: a config error, not a routable state. */
export class UnknownPinError extends Error {
	constructor(
		readonly role: ModelRole,
		readonly pin: string,
	) {
		super(`capability.roles.${role}.pin names "${pin}", which is not a model_id or alias in the ranking.`);
		this.name = "UnknownPinError";
	}
}

/** The role's selection: the record that fills it, and why it falls short when it does. */
export interface RoleSelection {
	role: ModelRole;
	/** Null only when the ranking has no bound record at all and the role cannot be filled. */
	model_id: string | null;
	/** Null when the chosen record has no reachable backend; the call site falls back to the static map. */
	ref: BackendRef | null;
	pinned: boolean;
	capability_gap?: CapabilityGap;
}

function shortfallsOf(record: RankedModel, role: ModelRole, setting: CapabilityRoleSetting): string[] {
	const shortfalls: string[] = [];
	if (!record.backend_binding) shortfalls.push("has no reachable backend binding");
	if (record.coding_score === null) {
		shortfalls.push("has no known coding score");
	} else if (record.coding_score < setting.min_coding_index) {
		shortfalls.push(`scores ${record.coding_score} below the ${role} floor ${setting.min_coding_index}`);
	}
	const ceiling = setting.max_blended_price;
	const price = record.price_blended_per_mtok;
	if (ceiling !== undefined && price !== null && price > ceiling) shortfalls.push(`costs ${price}/Mtok above the ${role} ceiling ${ceiling}`);
	return shortfalls;
}

/**
 * The cheapest bound record clearing the role's floor and price ceiling,
 * tie-broken by higher `coding_score` then `model_id`. A pin wins unconditionally
 * and reports its shortfall instead of being swapped. When nothing clears, the
 * highest-scoring bound record is escalated into the role with a `capability_gap`.
 */
export function selectRoleModel(role: ModelRole, ranking: Ranking, config: LeanPiConfig): RoleSelection {
	const setting = capabilityConfigOf(config).roles[role];
	if (setting.pin !== undefined) {
		const record = findRankedModel(ranking, setting.pin);
		if (!record) throw new UnknownPinError(role, setting.pin);
		const shortfalls = shortfallsOf(record, role, setting);
		const selection: RoleSelection = { role, model_id: record.model_id, ref: record.backend_binding, pinned: true };
		if (shortfalls.length === 0) return selection;
		return {
			...selection,
			capability_gap: {
				requested: setting.min_coding_index,
				best_available: record.coding_score,
				reason: `pinned model "${record.model_id}" ${shortfalls.join("; ")}`,
			},
		};
	}

	const ceiling = setting.max_blended_price;
	const bound = boundCandidates(ranking, config);
	const clearing = bound
		.filter((candidate) => candidate.coding_score >= setting.min_coding_index)
		.filter((candidate) => ceiling === undefined || (candidate.price_blended_per_mtok !== null && candidate.price_blended_per_mtok <= ceiling))
		.sort(compareCandidates);
	const chosen = clearing[0];
	if (chosen) return { role, model_id: chosen.model_id, ref: candidateRef(chosen), pinned: false };

	const best = [...bound].sort((a, b) => b.coding_score - a.coding_score || (a.model_id < b.model_id ? -1 : 1))[0];
	if (!best) {
		return {
			role,
			model_id: null,
			ref: null,
			pinned: false,
			capability_gap: { requested: setting.min_coding_index, best_available: null, reason: `no ranked model has a reachable backend (${role} floor ${setting.min_coding_index})` },
		};
	}
	return {
		role,
		model_id: best.model_id,
		ref: candidateRef(best),
		pinned: false,
		capability_gap: {
			requested: setting.min_coding_index,
			best_available: best.coding_score,
			reason: `no bound model clears the ${role} floor ${setting.min_coding_index}${ceiling === undefined ? "" : ` within the price ceiling ${ceiling}`}; escalating to the highest-scoring bound model "${best.model_id}" (${best.coding_score})`,
		},
	};
}

/** All six roles resolved against one ranking and one config — the row set `/models` joins. */
export function roleResolutionsOf(ranking: Ranking, config: LeanPiConfig): RoleSelection[] {
	return MODEL_ROLES.map((role) => selectRoleModel(role, ranking, config));
}
