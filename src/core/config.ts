/**
 * Configuration loading and validation (PRD-001 Phase 2, ROADMAP §27).
 *
 * Validation is total and fails the session start rather than warning: a
 * half-applied config would make every downstream PRD debug the wrong layer.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { assertTrusted, isProjectLocal, mergePermissions, readUserState, type PermissionEnv, type RawPermissionsBlock } from "../permissions/trust.js";
import {
	BACKEND_TYPES,
	isModelRole,
	isThinkingLevel,
	MODEL_ROLES,
	THINKING_LEVELS,
	type BackendConfig,
	type BackendType,
	type CapabilityRoleSetting,
	type JevMode,
	type LeanPiConfig,
	type ModelRole,
	type ModelsConfig,
	type VerifyConfig,
} from "./types.js";

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

/**
 * Where a session's configuration comes from.
 *
 * `leanpi` is a command a user runs from wherever they happen to be, so the
 * file is looked up the way every other project tool looks one up: the working
 * directory, then its ancestors (a monorepo package inherits the repository's
 * config), then the machine's own `$XDG_CONFIG_HOME/leanpi/`. Without the walk,
 * running the command one directory deeper than the config is a hard failure
 * with no obvious cause; without the user-level fallback, it cannot run outside
 * a configured project at all. The returned path is the project-level one when
 * nothing exists, so a caller that writes config writes it where it looked.
 */
export function configPathFor(cwd: string, env: { XDG_CONFIG_HOME?: string; HOME?: string } = process.env): string {
	const project = join(cwd, CONFIG_FILENAME);
	let directory = cwd;
	for (;;) {
		const candidate = join(directory, CONFIG_FILENAME);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	const base = env.XDG_CONFIG_HOME ?? (env.HOME === undefined ? undefined : join(env.HOME, ".config"));
	const user = base === undefined ? undefined : join(base, "leanpi", CONFIG_FILENAME);
	return user !== undefined && existsSync(user) ? user : project;
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
		// A level Pi does not know is clamped to something else rather than
		// rejected, so a typo here would quietly change what a turn spends.
		if (entry.thinkingLevel !== undefined && !isThinkingLevel(entry.thinkingLevel)) {
			throw new ConfigError(`thinkingLevel must be one of ${THINKING_LEVELS.join(" | ")}, got ${JSON.stringify(entry.thinkingLevel)}`, `${path}.thinkingLevel`);
		}
		backends[name] = { ...(entry as BackendConfig), type: type as BackendType };
	}
	return backends;
}

/**
 * FR-047's `models.specialists` block: a language or task-type key bound to the
 * role that serves it. It is a second map under `models:`, not a seventh role,
 * so its keys are validated as keys and its values as roles — storing it as a
 * role entry would mistype the map every consumer walks.
 */
function parseSpecialists(raw: unknown): Record<string, ModelRole> {
	const record = asRecord(raw, "models.specialists");
	const specialists: Record<string, ModelRole> = {};
	for (const [key, role] of Object.entries(record)) {
		if (typeof role !== "string" || !isModelRole(role)) {
			throw new ConfigError(`must name a model role (${MODEL_ROLES.join(" | ")}), got ${JSON.stringify(role)}`, `models.specialists.${key}`);
		}
		specialists[key] = role;
	}
	return specialists;
}

function parseModels(raw: unknown, backends: Record<string, BackendConfig>): ModelsConfig {
	if (raw === undefined) return {};
	const record = asRecord(raw, "models");
	const models: ModelsConfig = {};
	for (const [role, value] of Object.entries(record)) {
		if (role === "specialists") {
			models.specialists = parseSpecialists(value);
			continue;
		}
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
		endpoint: typeof record.endpoint === "string" ? record.endpoint : "https://api.typesafe.ai/v1/systemone",
		model: typeof record.model === "string" ? record.model : "jev-latest",
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

function parseThresholds(raw: unknown): LeanPiConfig["thresholds"] {
	const record = raw === undefined ? {} : asRecord(raw, "thresholds");
	const value = (key: keyof LeanPiConfig["thresholds"], fallback: number): number => {
		const entry = record[key];
		if (entry === undefined) return fallback;
		if (typeof entry !== "number" || entry < 0 || entry > 1) {
			throw new ConfigError(`must be a number between 0 and 1`, `thresholds.${key}`);
		}
		return entry;
	};
	return {
		gate_prd_required: value("gate_prd_required", 0.5),
		complexity: value("complexity", 0.5),
		review_risk: value("review_risk", 0.5),
	};
}

const LSP_MODES = ["off", "diagnostics", "navigation", "full", "auto"] as const;

function parseLsp(raw: unknown): LeanPiConfig["lsp"] {
	const record = raw === undefined ? {} : asRecord(raw, "lsp");
	const mode = record.mode;
	if (mode !== undefined && !(LSP_MODES as readonly unknown[]).includes(mode)) {
		throw new ConfigError(`mode must be one of ${LSP_MODES.join(" | ")}`, "lsp.mode");
	}
	const servers = record.servers === undefined ? {} : (asRecord(record.servers, "lsp.servers") as Record<string, string>);
	return { mode: (mode as LeanPiConfig["lsp"]["mode"]) ?? "auto", servers };
}

function parseCapability(raw: unknown): LeanPiConfig["capability"] {
	const record = raw === undefined ? {} : asRecord(raw, "capability");
	const stalenessDays = record.stalenessDays;
	if (stalenessDays !== undefined && (typeof stalenessDays !== "number" || stalenessDays <= 0)) {
		throw new ConfigError(`stalenessDays must be a positive number`, "capability.stalenessDays");
	}
	if (record.rankingFile !== undefined && record.rankingFile !== null && typeof record.rankingFile !== "string") {
		throw new ConfigError(`rankingFile must be a path or null`, "capability.rankingFile");
	}
	const rolesRaw = record.roles === undefined ? {} : asRecord(record.roles, "capability.roles");
	const roles: LeanPiConfig["capability"]["roles"] = {};
	for (const [role, value] of Object.entries(rolesRaw)) {
		if (!isModelRole(role)) throw new ConfigError(`unknown model role ${JSON.stringify(role)}`, `capability.roles.${role}`);
		const entry = asRecord(value, `capability.roles.${role}`);
		for (const key of ["min_coding_index", "max_blended_price"] as const) {
			const number = entry[key];
			if (number !== undefined && typeof number !== "number") {
				throw new ConfigError(`${key} must be a number`, `capability.roles.${role}.${key}`);
			}
		}
		roles[role] = entry as CapabilityRoleSetting;
	}
	return {
		rankingFile: (record.rankingFile as string | null | undefined) ?? null,
		stalenessDays: (stalenessDays as number | undefined) ?? 90,
		roles,
	};
}

function parseMcp(raw: unknown): LeanPiConfig["mcp"] {
	const record = raw === undefined ? {} : asRecord(raw, "mcp");
	const maxTools = record.maxTools;
	if (maxTools !== undefined && (typeof maxTools !== "number" || !Number.isInteger(maxTools) || maxTools < 0)) {
		throw new ConfigError(`maxTools must be a non-negative integer`, "mcp.maxTools");
	}
	const state = record.state === undefined ? {} : (asRecord(record.state, "mcp.state") as LeanPiConfig["mcp"]["state"]);
	return { maxTools: (maxTools as number | undefined) ?? 6, state };
}

function parseContext(raw: unknown): LeanPiConfig["context"] {
	const record = raw === undefined ? {} : asRecord(raw, "context");
	const number = (key: keyof LeanPiConfig["context"], fallback: number): number => {
		const value = record[key];
		if (value === undefined) return fallback;
		if (typeof value !== "number" || value <= 0) throw new ConfigError(`must be a positive number`, `context.${key}`);
		return value;
	};
	return {
		artifact_threshold_bytes: number("artifact_threshold_bytes", 32_768),
		compaction_threshold_bytes: number("compaction_threshold_bytes", 48_000),
		working_state_max_bytes: number("working_state_max_bytes", 3000),
	};
}

function parseCapabilities(raw: unknown): LeanPiConfig["capabilities"] {
	const record = raw === undefined ? {} : asRecord(raw, "capabilities");
	const skillRoots = record.skillRoots;
	if (skillRoots !== undefined && !Array.isArray(skillRoots)) {
		throw new ConfigError(`skillRoots must be a list of paths`, "capabilities.skillRoots");
	}
	const mcpConfigPaths = record.mcpConfigPaths;
	if (mcpConfigPaths !== undefined && !Array.isArray(mcpConfigPaths)) {
		throw new ConfigError(`mcpConfigPaths must be a list of paths`, "capabilities.mcpConfigPaths");
	}
	return {
		skillRoots: (skillRoots as string[] | undefined) ?? [],
		mcpConfigPaths: (mcpConfigPaths as string[] | undefined) ?? [],
	};
}

/**
 * The `verify:` block (PRD-009 §Solution, PRD-018 AC-4): the host project's own
 * verifier commands, keyed by verifier kind. A command that is not a command —
 * a number, an empty string — is rejected here rather than resolved to `""` and
 * recorded as `not_run` once a turn already depends on it.
 */
function parseVerify(raw: unknown): VerifyConfig {
	const record = raw === undefined ? {} : asRecord(raw, "verify");
	const commands: Record<string, string> = {};
	if (record.commands !== undefined) {
		for (const [kind, command] of Object.entries(asRecord(record.commands, "verify.commands"))) {
			if (kind.length === 0) {
				throw new ConfigError(`verifier kind must be a non-empty key`, "verify.commands");
			}
			if (typeof command !== "string" || command.length === 0) {
				throw new ConfigError(`command must be a non-empty string`, `verify.commands.${kind}`);
			}
			commands[kind] = command;
		}
	}
	const timeoutMs = record.timeoutMs;
	if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
		throw new ConfigError(`timeoutMs must be a positive number`, "verify.timeoutMs");
	}
	return { commands, ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }) };
}

/** The project-scope `permissions:` block; PRD-017 merges it asymmetrically. */
function parsePermissions(raw: unknown): RawPermissionsBlock {
	if (raw === undefined) return {};
	const record = asRecord(raw, "permissions");
	if (record.trust !== undefined && typeof record.trust !== "boolean") {
		throw new ConfigError(`trust must be a boolean`, "permissions.trust");
	}
	return {
		defaults: record.defaults === undefined ? {} : asRecord(record.defaults, "permissions.defaults"),
		rules: record.rules === undefined ? [] : (() => {
			if (!Array.isArray(record.rules)) throw new ConfigError(`rules must be a list`, "permissions.rules");
			return record.rules;
		})(),
		...(record.trust === true ? { trust: true } : {}),
		...(record.secrets === undefined ? {} : { secrets: asRecord(record.secrets, "permissions.secrets") as RawPermissionsBlock["secrets"] }),
	};
}

export function loadConfig(cwd: string, overrides: Partial<LeanPiConfig> = {}, env: PermissionEnv = process.env): LeanPiConfig {
	const path = configPathFor(cwd, env);
	const raw = existsSync(path) ? (parseYaml(readFileSync(path, "utf8")) as unknown) : undefined;
	const record = raw === undefined || raw === null ? {} : asRecord(raw, CONFIG_FILENAME);

	const instructionsRaw = record.instructions === undefined ? {} : asRecord(record.instructions, "instructions");
	if (instructionsRaw.ponytail !== undefined && typeof instructionsRaw.ponytail !== "boolean") {
		throw new ConfigError(`ponytail must be a boolean`, "instructions.ponytail");
	}
	const limitsRaw = record.limits === undefined ? {} : asRecord(record.limits, "limits");

	const backends = parseBackends(record.backends);
	// PRD-017: assertTrusted runs between load and use. An untrusted project keeps
	// nothing executable and nothing project-local on the capability surface.
	const capabilities = parseCapabilities(record.capabilities);
	const trust = assertTrusted(cwd, env, {
		skillRoots: capabilities.skillRoots,
		mcpConfigPaths: capabilities.mcpConfigPaths,
	});
	const skillRoots = trust.trusted ? capabilities.skillRoots : capabilities.skillRoots.filter((root) => !isProjectLocal(cwd, root));
	const permissions = mergePermissions({
		user: readUserState(env),
		project: parsePermissions(record.permissions),
		trust,
	});
	const config: LeanPiConfig = {
		configPath: existsSync(path) ? path : null,
		backends,
		models: parseModels(record.models, backends),
		instructions: { ponytail: (instructionsRaw.ponytail as boolean | undefined) ?? true },
		jev: parseJev(record.jev),
		capabilities: { ...capabilities, skillRoots },
		skills: parseSkills(record.skills),
		bench: parseBench(record.bench),
		context: parseContext(record.context),
		lsp: parseLsp(record.lsp),
		mcp: parseMcp(record.mcp),
		capability: parseCapability(record.capability),
		verify: parseVerify(record.verify),
		permissions,
		thresholds: parseThresholds(record.thresholds),
		limits: {
			executionAttempts: (limitsRaw.executionAttempts as number | undefined) ?? 2,
			semanticReviewRounds: (limitsRaw.semanticReviewRounds as number | undefined) ?? 1,
		},
		...overrides,
	};

	// `models.specialists` is a map, not a role: a file declaring only specialists
	// has configured no role and must fail the same way an empty block does.
	if (!MODEL_ROLES.some((role) => config.models[role] !== undefined) && overrides.models === undefined) {
		throw new ConfigError(
			"no model roles configured — at least one of quick/balanced/strong is required",
			existsSync(path) ? "models" : CONFIG_FILENAME,
		);
	}
	return config;
}

/**
 * A credential slot in LeanPi's own config syntax, translated into the syntax
 * Pi's provider registration expects.
 *
 * LeanPi documents `apiKey: SOME_ENV_VAR` as "the name of the environment
 * variable holding it". Pi 0.85 changed its own rule: a bare name is now a
 * *literal*, and interpolation requires `$SOME_ENV_VAR` (or `${SOME_ENV_VAR}`),
 * with `!command` still executing a command. This is the one place that
 * difference is reconciled, so a config written for either reading keeps
 * working and a real key is never mistaken for a variable name.
 *
 * `env` is a parameter rather than a `process.env` read so the translation is
 * testable without mutating the environment.
 */
export function toPiConfigValue(value: string, env: Record<string, string | undefined> = process.env): string {
	// Already Pi's own syntax: a command, or a template carrying its own `$`.
	if (value.startsWith("!") || value.includes("$")) return value;
	if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && env[value] !== undefined) return `$${value}`;
	return value;
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
