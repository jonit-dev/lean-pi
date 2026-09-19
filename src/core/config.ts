/**
 * Configuration loading and validation (PRD-001 Phase 2, ROADMAP §27).
 *
 * Validation is total and fails the session start rather than warning: a
 * half-applied config would make every downstream PRD debug the wrong layer.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { BACKEND_TYPES, isModelRole, type BackendConfig, type BackendType, type JevMode, type LeanPiConfig, type ModelRole } from "./types.js";

export const CONFIG_FILENAME = "leanpi.config.yaml";

export class ConfigError extends Error {
	constructor(
		message: string,
		readonly path: string,
	) {
		super(`${path}: ${message}`);
		this.name = "ConfigError";
	}
}

const JEV_MODES: readonly JevMode[] = ["enabled", "disabled", "metadata-only", "redacted"];

export function configPathFor(cwd: string): string {
	return join(cwd, CONFIG_FILENAME);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ConfigError(`expected a mapping, got ${Array.isArray(value) ? "a list" : typeof value}`, path);
	}
	return value as Record<string, unknown>;
}

function parseBackends(raw: unknown): Record<string, BackendConfig> {
	if (raw === undefined) return {};
	const record = asRecord(raw, "backends");
	const backends: Record<string, BackendConfig> = {};
	for (const [name, value] of Object.entries(record)) {
		const path = `backends.${name}`;
		const entry = asRecord(value, path);
		const type = entry.type;
		// ROADMAP §25's discriminant, parsed verbatim by PRD-008. A block still
		// carrying the pre-§25 `kind:` key fails here with its dotted path.
		if (type === undefined) {
			const hint = "kind" in entry ? ` (found "kind"; the discriminant is "type")` : "";
			throw new ConfigError(`type must be one of ${BACKEND_TYPES.join(" | ")}${hint}`, `${path}.type`);
		}
		if (!(BACKEND_TYPES as readonly unknown[]).includes(type)) {
			throw new ConfigError(`type must be one of ${BACKEND_TYPES.join(" | ")}, got ${JSON.stringify(type)}`, `${path}.type`);
		}
		backends[name] = { ...(entry as BackendConfig), type: type as BackendType };
	}
	return backends;
}

function parseModels(
	raw: unknown,
	backends: Record<string, BackendConfig>,
): Partial<Record<ModelRole, { backend: string; model: string }>> {
	if (raw === undefined) return {};
	const record = asRecord(raw, "models");
	const models: Partial<Record<ModelRole, { backend: string; model: string }>> = {};
	for (const [role, value] of Object.entries(record)) {
		if (!isModelRole(role)) {
			throw new ConfigError(`unknown model role ${JSON.stringify(role)}`, `models.${role}`);
		}
		const entry = asRecord(value, `models.${role}`);
		const backend = entry.backend;
		const model = entry.model;
		if (typeof backend !== "string" || backend.length === 0) {
			throw new ConfigError(`backend must be a non-empty string`, `models.${role}.backend`);
		}
		if (!(backend in backends)) {
			throw new ConfigError(`backend ${JSON.stringify(backend)} is not defined under "backends"`, `models.${role}.backend`);
		}
		if (typeof model !== "string" || model.length === 0) {
			throw new ConfigError(`model must be a non-empty string`, `models.${role}.model`);
		}
		models[role] = { backend, model };
	}
	return models;
}

function parseJev(raw: unknown): LeanPiConfig["jev"] {
	const record = raw === undefined ? {} : asRecord(raw, "jev");
	const mode = record.mode;
	if (mode !== undefined && !JEV_MODES.includes(mode as JevMode)) {
		throw new ConfigError(`mode must be one of ${JEV_MODES.join(" | ")}`, "jev.mode");
	}
	if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
		throw new ConfigError(`enabled must be a boolean`, "jev.enabled");
	}
	// `jev.enabled: false` is the shorthand several PRDs use for a fully local
	// project; it is the same switch as `mode: disabled`, not a second one.
	const resolvedMode: JevMode = record.enabled === false ? "disabled" : ((mode as JevMode | undefined) ?? "enabled");
	return {
		apiKey: typeof record.apiKey === "string" ? record.apiKey : null,
		endpoint: typeof record.endpoint === "string" ? record.endpoint : "https://api.typesafe.ai/v1",
		model: typeof record.model === "string" ? record.model : "jev-1.13",
		mode: resolvedMode,
	};
}

function parseSkills(raw: unknown): LeanPiConfig["skills"] {
	const record = raw === undefined ? {} : asRecord(raw, "skills");
	const maxLoaded = record.maxLoaded;
	if (maxLoaded !== undefined && (typeof maxLoaded !== "number" || !Number.isInteger(maxLoaded) || maxLoaded < 0)) {
		throw new ConfigError(`maxLoaded must be a non-negative integer`, "skills.maxLoaded");
	}
	const state = record.state === undefined ? {} : (asRecord(record.state, "skills.state") as LeanPiConfig["skills"]["state"]);
	return { maxLoaded: (maxLoaded as number | undefined) ?? 3, state };
}

function parseBench(raw: unknown): LeanPiConfig["bench"] {
	const record = raw === undefined ? {} : asRecord(raw, "bench");
	const skills = record.skills === undefined ? {} : asRecord(record.skills, "bench.skills");
	const ceiling = skills.maxUnnecessaryLoadRate;
	if (ceiling !== undefined && (typeof ceiling !== "number" || ceiling < 0 || ceiling > 1)) {
		throw new ConfigError(`maxUnnecessaryLoadRate must be a fraction between 0 and 1`, "bench.skills.maxUnnecessaryLoadRate");
	}
	return { skills: { maxUnnecessaryLoadRate: (ceiling as number | undefined) ?? 0.04 } };
}

function parseCapabilities(raw: unknown): LeanPiConfig["capabilities"] {
	const record = raw === undefined ? {} : asRecord(raw, "capabilities");
	const skillRoots = record.skillRoots;
	if (skillRoots !== undefined && !Array.isArray(skillRoots)) {
		throw new ConfigError(`skillRoots must be a list of paths`, "capabilities.skillRoots");
	}
	return { skillRoots: (skillRoots as string[] | undefined) ?? [] };
}

export function loadConfig(cwd: string, overrides: Partial<LeanPiConfig> = {}): LeanPiConfig {
	const path = configPathFor(cwd);
	const raw = existsSync(path) ? (parseYaml(readFileSync(path, "utf8")) as unknown) : undefined;
	const record = raw === undefined || raw === null ? {} : asRecord(raw, CONFIG_FILENAME);

	const instructionsRaw = record.instructions === undefined ? {} : asRecord(record.instructions, "instructions");
	if (instructionsRaw.ponytail !== undefined && typeof instructionsRaw.ponytail !== "boolean") {
		throw new ConfigError(`ponytail must be a boolean`, "instructions.ponytail");
	}
	const limitsRaw = record.limits === undefined ? {} : asRecord(record.limits, "limits");

	const backends = parseBackends(record.backends);
	const config: LeanPiConfig = {
		configPath: existsSync(path) ? path : null,
		backends,
		models: parseModels(record.models, backends),
		instructions: { ponytail: (instructionsRaw.ponytail as boolean | undefined) ?? true },
		jev: parseJev(record.jev),
		capabilities: parseCapabilities(record.capabilities),
		skills: parseSkills(record.skills),
		bench: parseBench(record.bench),
		limits: {
			executionAttempts: (limitsRaw.executionAttempts as number | undefined) ?? 2,
			semanticReviewRounds: (limitsRaw.semanticReviewRounds as number | undefined) ?? 1,
		},
		...overrides,
	};

	if (Object.keys(config.models).length === 0 && overrides.models === undefined) {
		throw new ConfigError(
			"no model roles configured — at least one of quick/balanced/strong is required",
			existsSync(path) ? "models" : CONFIG_FILENAME,
		);
	}
	return config;
}

/** Persist `/skills` enable/disable/pin state without disturbing unrelated config keys. */
export function writeSkillsState(cwd: string, state: LeanPiConfig["skills"]["state"]): void {
	const path = configPathFor(cwd);
	const parsed = existsSync(path) ? (parseYaml(readFileSync(path, "utf8")) as unknown) : undefined;
	const root = parsed === undefined || parsed === null ? {} : (parsed as Record<string, unknown>);
	const skills = (root.skills ?? {}) as Record<string, unknown>;
	skills.state = state;
	root.skills = skills;
	writeFileSync(path, stringifyYaml(root));
}
