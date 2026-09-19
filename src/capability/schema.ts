/**
 * The capability ranking's on-disk shape and its one validator (PRD-024 Phase 1).
 *
 * `models.json` and every `capability.rankingFile` override go through the same
 * code, so a user's file cannot carry a record the shipped file would have been
 * rejected for. Every failure names the source, the record and the field: the
 * ranking is a routing input, and a silently ignored override is worse than a
 * refused start.
 *
 * Everything a consumer needs about one model lives in `ModelCapability`; the
 * one field that is never persisted is `backend_binding`, added at load time by
 * resolving `backend_hint` against the configured backends (PRD-024 §Solution).
 */
import type { BackendRef } from "../core/types.js";

export const EVIDENCE_VALUES = ["measured", "estimated"] as const;
export type Evidence = (typeof EVIDENCE_VALUES)[number];

export const SPEED_TIERS = ["slow", "medium", "fast"] as const;
export type SpeedTier = (typeof SPEED_TIERS)[number];

/** One ranked model. Every numeric field is `number | null`: null is *unknown*, never zero. */
export interface ModelCapability {
	/** Canonical id, unique in the file; the id routing and telemetry use. */
	model_id: string;
	/** Other spellings a backend or config may use, so a config entry resolves to exactly one record. */
	aliases: string[];
	/** Who serves it. Display and config matching only — never a routing input. */
	provider: string;
	/** The `backends.<id>` key this model is normally reached through; null means "not bound by convention". */
	backend_hint: string | null;
	/** Our coding-capability score, 0–100. The field `required_capability.min_coding_index` is compared against. */
	coding_score: number | null;
	/** Our general-capability score, 0–100; display and tie-breaking only. */
	general_score: number | null;
	/** Maintainer tags matched against `required_capability.specialization`. Empty never matches a filter. */
	specializations: string[];
	price_input_per_mtok: number | null;
	price_output_per_mtok: number | null;
	/** 3:1 input:output blend — the single number "cheapest" is computed over. */
	price_blended_per_mtok: number | null;
	speed_tier: SpeedTier;
	context_window: number | null;
	/** ISO date this record was last reviewed; records age independently. */
	updated_at: string;
	/** `measured` only for a recorded PRD-021 benchmark run; anything else is `estimated`. */
	evidence: Evidence;
}

/** A ranked record plus the backend binding resolved from config at load time. */
export interface RankedModel extends ModelCapability {
	backend_binding: BackendRef | null;
}

/** The committed document: `src/capability/models.json` or the user's override. */
export interface RankingFile {
	/** Monotonically increasing; bumped by every maintainer change to the file. */
	revision: number;
	notes: string;
	models: ModelCapability[];
}

/** A validated ranking as consumers see it: the records, plus the freshness report. */
export interface Ranking {
	revision: number;
	notes: string;
	models: RankedModel[];
	/** The file this ranking was read from. */
	path: string;
	/** The oldest `updated_at` among records that currently fill a role. */
	oldest_updated_at: string;
	age_days: number;
	/** True when the oldest role-filling record is older than `staleness_days`. A stale ranking is still used. */
	stale: boolean;
	staleness_days: number;
}

/** A schema violation, naming the source file, the record and the field. */
export class RankingValidationError extends Error {
	constructor(
		readonly source: string,
		readonly record: string,
		readonly field: string,
		detail: string,
	) {
		super(`capability ranking ${source}: record ${JSON.stringify(record)} field "${field}": ${detail}`);
		this.name = "RankingValidationError";
	}
}

/** The ranking file itself could not be read (missing, unreadable, not JSON). */
export class RankingUnavailableError extends Error {
	constructor(
		readonly source: string,
		readonly reason: string,
	) {
		super(`capability ranking ${source} could not be read: ${reason}`);
		this.name = "RankingUnavailableError";
	}
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The boundary parser (mirrors `src/core/config.ts`): shape is proved once, here. */
function asRecord(value: unknown, source: string, record: string, field: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new RankingValidationError(source, record, field, `must be a mapping, got ${Array.isArray(value) ? "a list" : value === null ? "null" : typeof value}`);
	}
	return value as Record<string, unknown>;
}

function recordField(value: unknown, source: string, record: string, field: string): unknown {
	if (value === undefined) throw new RankingValidationError(source, record, field, "is required");
	return value;
}

function stringField(value: unknown, source: string, record: string, field: string): string {
	recordField(value, source, record, field);
	if (typeof value !== "string" || value.length === 0) throw new RankingValidationError(source, record, field, "must be a non-empty string");
	return value;
}

function nullableString(value: unknown, source: string, record: string, field: string): string | null {
	recordField(value, source, record, field);
	if (value === null) return null;
	if (typeof value !== "string" || value.length === 0) throw new RankingValidationError(source, record, field, "must be a non-empty string or null");
	return value;
}

function numberField(value: unknown, source: string, record: string, field: string, min: number, max: number): number | null {
	recordField(value, source, record, field);
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value)) throw new RankingValidationError(source, record, field, "must be a number or null");
	if (value < min || value > max) throw new RankingValidationError(source, record, field, `must be between ${min} and ${max}, got ${value}`);
	return value;
}

function positiveIntField(value: unknown, source: string, record: string, field: string): number | null {
	recordField(value, source, record, field);
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new RankingValidationError(source, record, field, "must be a positive integer or null");
	return value;
}

function stringListField(value: unknown, source: string, record: string, field: string): string[] {
	recordField(value, source, record, field);
	if (!Array.isArray(value)) throw new RankingValidationError(source, record, field, "must be a list of strings");
	for (const entry of value) {
		if (typeof entry !== "string" || entry.length === 0) throw new RankingValidationError(source, record, field, "must be a list of non-empty strings");
	}
	if (new Set(value).size !== value.length) throw new RankingValidationError(source, record, field, "must not repeat an entry");
	return value as string[];
}

function enumField<T extends string>(value: unknown, allowed: readonly T[], source: string, record: string, field: string): T {
	recordField(value, source, record, field);
	if (!(allowed as readonly unknown[]).includes(value)) throw new RankingValidationError(source, record, field, `must be one of ${allowed.join(" | ")}`);
	return value as T;
}

function parseRecord(value: unknown, source: string, index: number): ModelCapability {
	const fields = asRecord(value, source, String(index), "record");
	const model_id = stringField(fields.model_id, source, String(index), "model_id");
	const updated_at = stringField(fields.updated_at, source, model_id, "updated_at");
	if (!ISO_DATE.test(updated_at) || Number.isNaN(Date.parse(`${updated_at}T00:00:00Z`))) {
		throw new RankingValidationError(source, model_id, "updated_at", `must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(updated_at)}`);
	}
	return {
		model_id,
		aliases: stringListField(fields.aliases, source, model_id, "aliases").map((alias) => stringField(alias, source, model_id, "aliases")),
		provider: stringField(fields.provider, source, model_id, "provider"),
		backend_hint: nullableString(fields.backend_hint, source, model_id, "backend_hint"),
		coding_score: numberField(fields.coding_score, source, model_id, "coding_score", 0, 100),
		general_score: numberField(fields.general_score, source, model_id, "general_score", 0, 100),
		specializations: stringListField(fields.specializations, source, model_id, "specializations"),
		price_input_per_mtok: numberField(fields.price_input_per_mtok, source, model_id, "price_input_per_mtok", 0, Number.MAX_SAFE_INTEGER),
		price_output_per_mtok: numberField(fields.price_output_per_mtok, source, model_id, "price_output_per_mtok", 0, Number.MAX_SAFE_INTEGER),
		price_blended_per_mtok: numberField(fields.price_blended_per_mtok, source, model_id, "price_blended_per_mtok", 0, Number.MAX_SAFE_INTEGER),
		speed_tier: enumField(fields.speed_tier, SPEED_TIERS, source, model_id, "speed_tier"),
		context_window: positiveIntField(fields.context_window, source, model_id, "context_window"),
		updated_at,
		evidence: enumField(fields.evidence, EVIDENCE_VALUES, source, model_id, "evidence"),
	};
}

/**
 * Validate a parsed ranking document. `source` is the file path (or URL) the
 * document came from, so every message points at the file the user must edit.
 */
export function parseRankingFile(value: unknown, source: string): RankingFile {
	const document = asRecord(value, source, "<file>", "ranking");
	const revision = recordField(document.revision, source, "<file>", "revision");
	if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
		throw new RankingValidationError(source, "<file>", "revision", "must be a positive integer");
	}
	const notes = stringField(document.notes, source, "<file>", "notes");
	const rawModels = recordField(document.models, source, "<file>", "models");
	if (!Array.isArray(rawModels) || rawModels.length === 0) {
		throw new RankingValidationError(source, "<file>", "models", "must be a non-empty list of records");
	}
	const models = rawModels.map((entry, index) => parseRecord(entry, source, index));
	const ids = new Set<string>();
	const spellings = new Map<string, string>();
	for (const model of models) {
		if (ids.has(model.model_id)) throw new RankingValidationError(source, model.model_id, "model_id", "is declared by more than one record");
		ids.add(model.model_id);
		for (const name of [model.model_id, ...model.aliases]) {
			const owner = spellings.get(name);
			if (owner !== undefined) throw new RankingValidationError(source, model.model_id, "aliases", `"${name}" is already used by record "${owner}"`);
			spellings.set(name, model.model_id);
		}
	}
	return { revision, notes, models };
}
