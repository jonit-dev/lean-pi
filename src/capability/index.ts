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
 * Nothing on this path can reach the network: the ranking is the committed file.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../core/package-info.js";
import { isModelRole, MODEL_ROLES, type BackendRef, type LeanPiConfig, type ModelRole } from "../core/types.js";
import { matchModel } from "./match.js";
import type { CapabilityGap } from "./select.js";
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
function bindingOf(record: ModelCapability, config: LeanPiConfig, matched: ReadonlyMap<string, string>): BackendRef | null {
	const bindings: BackendRef[] = [];
	for (const [role, entry] of Object.entries(config.models)) {
		// `models.specialists` (FR-047) is a language/task-type map, not a binding.
		if (!isModelRole(role) || !entry) continue;
		// Spelling is the CLI's, not the leaderboard's: `opencode-go/deepseek-v4.1-flash`
		// and `deepseek-v4-1-flash` are the same model written by two parties. The
		// join is resolved once against the whole file — matching a config entry
		// against one record at a time would strip `matchModel`'s ambiguity checks,
		// which are the only thing keeping a loose spelling off a neighbour.
		if (matched.get(entry.model) !== record.model_id) continue;
		const backend = config.backends[entry.backend];
		if (!backend || backend.enabled === false) continue;
		bindings.push({ backend: entry.backend, model: entry.model, type: backend.type });
	}
	return bindings.find((binding) => binding.backend === record.backend_hint) ?? bindings[0] ?? null;
}

/** Each configured model id, resolved to the one record it names. */
function matchedRecords(file: { models: readonly ModelCapability[] }, config: LeanPiConfig): Map<string, string> {
	const matched = new Map<string, string>();
	for (const [role, entry] of Object.entries(config.models)) {
		if (!isModelRole(role) || !entry || matched.has(entry.model)) continue;
		const record = matchModel(file.models, entry.model);
		if (record) matched.set(entry.model, record.model_id);
	}
	return matched;
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
	const matched = matchedRecords(file, config);
	const models: RankedModel[] = file.models.map((record) => ({ ...record, backend_binding: bindingOf(record, config, matched) }));
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
const reportedGaps = new Set<string>();

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

/**
 * The config facts `loadRanking` bakes into each record's `backend_binding`. Two
 * configs can share the bundled file and still resolve different bindings, so the
 * role map and backend enablement are part of the cache identity, not just the
 * file's mtime.
 */
function bindingKeyOf(config: LeanPiConfig): string {
	return JSON.stringify([
		config.models,
		Object.entries(config.backends).map(([name, entry]) => [name, entry.type, entry.enabled !== false]),
	]);
}

function rankingFor(config: LeanPiConfig): Ranking {
	const key = `${sourceKeyOf(rankingPathOf(config))}:${bindingKeyOf(config)}`;
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
/**
 * What the statusline says about a role: who chose the model, and whether the
 * chosen one actually clears the role's floor. Both answers come off the cached
 * ranking, so it is a per-turn call and not a per-turn file read. A ranking that
 * cannot be read is already reported by the path that routed the turn; the
 * footer just says less rather than failing.
 */
export function roleStatus(config: LeanPiConfig, role: ModelRole): { pinned: boolean; gap?: CapabilityGap } {
	const pinned = capabilityConfigOf(config).roles[role].pin !== undefined;
	try {
		const { capability_gap } = selectRoleModel(role, rankingFor(config), config);
		return capability_gap ? { pinned, gap: capability_gap } : { pinned };
	} catch {
		return { pinned };
	}
}

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
	const selection = selectRoleModel(role, ranking, config);
	// A gap is not a silent fallback: the resolved binding is returned either way,
	// and the shortfall is named once per role so a machine running an unmeasured
	// CLI model says so instead of looking like a clean selection. A config whose
	// models the ranking does not carry at all (model_id null) is the ordinary
	// static path, not a gap worth reporting.
	if (selection.capability_gap && selection.model_id !== null && !reportedGaps.has(role)) {
		reportedGaps.add(role);
		process.stderr.write(`leanpi: capability gap (${role}): ${selection.capability_gap.reason}\n`);
	}
	return selection.ref;
}

export { capabilityConfigOf, DEFAULT_ROLE_SETTINGS, DEFAULT_STALENESS_DAYS, roleResolutionsOf, selectRoleModel, UnknownPinError } from "./roles.js";
export type { CapabilityRoleSetting, CapabilitySetting, ResolvedCapabilitySetting, RoleSelection } from "./roles.js";
export { boundCandidates, boundRecords, candidateRef, compareCandidates, findRankedModel, selectCheapestClearing } from "./select.js";
export type { CapabilityCandidate, CapabilityGap, ClearingSelection } from "./select.js";
export { EVIDENCE_VALUES, RankingUnavailableError, RankingValidationError, SPEED_TIERS, parseRankingFile } from "./schema.js";
export type { Evidence, ModelCapability, RankedModel, Ranking, RankingFile, SpeedTier } from "./schema.js";
export { capabilityRows } from "./feed.js";
export type { CapabilityRow } from "./feed.js";
export { idCandidates, matchModel } from "./match.js";
