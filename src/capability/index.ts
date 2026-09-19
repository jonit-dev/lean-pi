/**
 * The model capability index (PRD-024): one bundled ranking, read from disk,
 * validated, bound to the configured backends.
 *
 * There is no network anywhere in this module. `models.json` is committed,
 * shipped in the package, and updated by a maintainer pull request; `revision`
 * and each record's `updated_at` are the freshness contract, and `loadRanking()`
 * reports them rather than trying to refresh anything. A stale ranking is
 * reported and still used — it is the only ranking there is.
 *
 * `resolveRoleViaRanking` is the hook PRD-001's `resolveRole` consults: it returns
 * null (never throws) when the ranking cannot be read or does not validate, and
 * the call site keeps using the static `models:` map instead.
 *
 * The owner-gated live catalog fetch lives in `catalog.ts`, deliberately *not*
 * re-exported here: nothing on this path can reach the network.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../core/package-info.js";
import { isModelRole, MODEL_ROLES, type BackendRef, type LeanPiConfig, type ModelRole } from "../core/types.js";
import { capabilityConfigOf, selectRoleModel, UnknownPinError, type RoleSelection } from "./roles.js";
import { RankingUnavailableError, RankingValidationError, parseRankingFile, type ModelCapability, type RankedModel, type Ranking } from "./schema.js";

/** The committed ranking, next to this module. */
export const BUNDLED_RANKING_PATH = join(PACKAGE_ROOT, "src", "capability", "models.json");

export interface LoadRankingOptions {
	/** Injected clock for the freshness report; defaults to now. */
	now?: Date;
}

function ageDaysOf(isoDate: string, now: Date): number {
	return Math.max(0, Math.floor((now.getTime() - Date.parse(`${isoDate}T00:00:00Z`)) / 86_400_000));
}

/**
 * The record's reachable backend, or null. Reachability is the config's own
 * declaration: `registerBackends` registers exactly the `models.<role>` spellings
 * on their backends, so anything else would dispatch a model id no provider
 * carries. `backend_hint` picks among declarations when the same model is
 * configured on several backends; it never invents one.
 */
function bindingOf(record: ModelCapability, config: LeanPiConfig): BackendRef | null {
	const bindings: BackendRef[] = [];
	for (const [role, entry] of Object.entries(config.models)) {
		// `models.specialists` (FR-047) is a language/task-type map, not a binding.
		if (!isModelRole(role) || !entry) continue;
		if (entry.model !== record.model_id && !record.aliases.includes(entry.model)) continue;
		const backend = config.backends[entry.backend];
		if (!backend || backend.enabled === false) continue;
		bindings.push({ backend: entry.backend, model: entry.model, type: backend.type });
	}
	return bindings.find((binding) => binding.backend === record.backend_hint) ?? bindings[0] ?? null;
}

function readRankingDocument(path: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new RankingUnavailableError(path, error instanceof Error ? error.message : String(error));
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new RankingValidationError(path, "<file>", "json", error instanceof Error ? error.message : String(error));
	}
}

/**
 * Load, validate and bind the ranking: the `capability.rankingFile` override when
 * configured, the bundled file otherwise. Validation failures throw, naming the
 * file, the record and the field — an unreadable or invalid ranking is a startup
 * error, never a silent fall back to another document.
 */
export function loadRanking(config: LeanPiConfig, options: LoadRankingOptions = {}): Ranking {
	const setting = capabilityConfigOf(config);
	const path = setting.rankingFile ?? BUNDLED_RANKING_PATH;
	const file = parseRankingFile(readRankingDocument(path), path);
	const models: RankedModel[] = file.models.map((record) => ({ ...record, backend_binding: bindingOf(record, config) }));
	const ranking: Ranking = {
		revision: file.revision,
		notes: file.notes,
		models,
		path,
		oldest_updated_at: "",
		age_days: 0,
		stale: false,
		staleness_days: setting.stalenessDays,
	};

	// Freshness is measured over the records that actually fill a role today:
	// an old record nobody selects is not a routing risk. A pin naming no record
	// contributes no fill here; it still fails loudly at the first selection.
	const filling = new Map<string, RankedModel>();
	for (const role of MODEL_ROLES) {
		let selection: RoleSelection;
		try {
			selection = selectRoleModel(role, ranking, config);
		} catch (error) {
			if (error instanceof UnknownPinError) continue;
			throw error;
		}
		const record = models.find((candidate) => candidate.model_id === selection.model_id);
		if (record) filling.set(record.model_id, record);
	}
	const pool = filling.size > 0 ? [...filling.values()] : models;
	const oldest = pool.reduce((acc, record) => (record.updated_at < acc ? record.updated_at : acc), pool[0]!.updated_at);
	const ageDays = ageDaysOf(oldest, options.now ?? new Date());
	return { ...ranking, oldest_updated_at: oldest, age_days: ageDays, stale: ageDays > setting.stalenessDays };
}

// ---------------------------------------------------------------------------
// The role-resolution hook (PRD-001's single call site reads this)
// ---------------------------------------------------------------------------

let cached: { key: string; ranking: Ranking } | null = null;
const reportedFallbacks = new Set<string>();

function rankingPathOf(config: LeanPiConfig): string {
	return capabilityConfigOf(config).rankingFile ?? BUNDLED_RANKING_PATH;
}

/** Identity of the document on disk, so a rewritten file is re-read and an unchanged one is not. */
function sourceKeyOf(path: string): string {
	try {
		const stats = statSync(path);
		return `${path}:${stats.mtimeMs}:${stats.size}`;
	} catch {
		return `${path}:missing`;
	}
}

function rankingFor(config: LeanPiConfig): Ranking {
	const key = sourceKeyOf(rankingPathOf(config));
	if (cached?.key === key) return cached.ranking;
	const ranking = loadRanking(config);
	cached = { key, ranking };
	return ranking;
}

/**
 * The role's backend through the ranking, or null when the ranking cannot be
 * read or does not validate (the reason is reported once per process). Never
 * throws for a ranking problem: PRD-001's static `models:` map remains the
 * fallback, and a stale ranking is still used.
 */
export function resolveRoleViaRanking(config: LeanPiConfig, role: ModelRole): BackendRef | null {
	let ranking: Ranking;
	try {
		ranking = rankingFor(config);
	} catch (error) {
		if (!(error instanceof RankingUnavailableError || error instanceof RankingValidationError)) throw error;
		const reason = `${error.message} — falling back to the static models: map`;
		if (!reportedFallbacks.has(reason)) {
			reportedFallbacks.add(reason);
			process.stderr.write(`leanpi: ${reason}\n`);
		}
		return null;
	}
	return selectRoleModel(role, ranking, config).ref;
}

export { capabilityConfigOf, DEFAULT_ROLE_SETTINGS, DEFAULT_STALENESS_DAYS, roleResolutionsOf, selectRoleModel, UnknownPinError } from "./roles.js";
export type { CapabilityRoleSetting, CapabilitySetting, ResolvedCapabilitySetting, RoleSelection } from "./roles.js";
export { boundCandidates, candidateRef, compareCandidates, findRankedModel, selectCheapestClearing } from "./select.js";
export type { CapabilityCandidate, CapabilityGap, ClearingSelection } from "./select.js";
export { EVIDENCE_VALUES, RankingUnavailableError, RankingValidationError, SPEED_TIERS, parseRankingFile } from "./schema.js";
export type { Evidence, ModelCapability, RankedModel, Ranking, RankingFile, SpeedTier } from "./schema.js";
export { capabilityRows } from "./feed.js";
export type { CapabilityRow } from "./feed.js";
