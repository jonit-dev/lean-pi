/**
 * Configuration loading and validation (PRD-001 Phase 2, ROADMAP §27).
 *
 * Validation is total and fails the session start rather than warning: a
 * half-applied config would make every downstream PRD debug the wrong layer.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CONFIG_FILENAME, configPathFor, userConfigPath } from "./config-path.js";
import { assertTrusted, isProjectLocal, mergePermissions, readUserState, type PermissionEnv, type RawPermissionsBlock } from "../permissions/trust.js";
import { parseRuntimePlan } from "../runtime/plan.js";
import {
	BACKEND_TYPES,
	isModelRole,
	isThinkingLevel,
	MODEL_ROLES,
	THINKING_LEVELS,
	type BackendConfig,
	type BackendType,
	type CapabilityRoleSetting,
	type CostBlockConfig,
	type JevMode,
	type JevProvider,
	type LayaConfig,
	type LeanPiConfig,
	type ModelRole,
	type ModelsConfig,
	type RoutingBlockConfig,
	type VerifyConfig,
} from "./types.js";

export { CONFIG_FILENAME, configPathFor, userConfigPath };

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


function asRecord(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ConfigError(`expected a mapping, got ${Array.isArray(value) ? "a list" : typeof value}`, path);
	}
	return value as Record<string, unknown>;
}

/**
 * Every recognized USD/Mtok rate key. A configured rate is an operator's
 * declaration, so a negative or non-finite value is a named error rather than a
 * silent clamp that makes a typo look free (COST-4). Unknown keys are ignored.
 */
const MONETARY_RATE_KEYS: ReadonlySet<string> = new Set(["input", "cachedInput", "cacheRead", "cacheWrite", "output"]);

function validateMonetaryBlock(raw: unknown, path: string): void {
	if (raw === undefined || raw === null) return;
	const record = asRecord(raw, path);
	for (const [key, value] of Object.entries(record)) {
		if (!MONETARY_RATE_KEYS.has(key)) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new ConfigError(`${key} must be a non-negative finite USD/Mtok rate`, `${path}.${key}`);
		}
	}
}

function parseBackends(raw: unknown): Record<string, BackendConfig> {
	if (raw === undefined) return {};
	const record = asRecord(raw, "backends");
	const backends: Record<string, BackendConfig> = {};
	for (const [name, value] of Object.entries(record)) {
		const path = `backends.${name}`;
		const entry = asRecord(value, path);
		validateMonetaryBlock(entry.cost, `${path}.cost`);
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

function parseLaya(raw: unknown): LayaConfig {
	if (raw === undefined) return {};
	const record = asRecord(raw, "jev.laya");
	if (record.device !== undefined && !["auto", "cuda", "cpu"].includes(record.device as string)) {
		throw new ConfigError(`device must be one of auto | cuda | cpu`, "jev.laya.device");
	}
	if (record.autoSetup !== undefined && typeof record.autoSetup !== "boolean") {
		throw new ConfigError(`autoSetup must be a boolean`, "jev.laya.autoSetup");
	}
	if (record.port !== undefined && (typeof record.port !== "number" || !Number.isInteger(record.port) || record.port < 0 || record.port > 65535)) {
		throw new ConfigError(`port must be an integer in 0..65535`, "jev.laya.port");
	}
	const text = (key: string): string | undefined => {
		const value = record[key];
		if (value === undefined) return undefined;
		if (typeof value !== "string" || value.length === 0) throw new ConfigError(`${key} must be a non-empty string`, `jev.laya.${key}`);
		return value;
	};
	return {
		endpoint: text("endpoint"),
		home: text("home"),
		device: record.device as LayaConfig["device"],
		checkpoint: text("checkpoint"),
		autoSetup: record.autoSetup as boolean | undefined,
		port: record.port as number | undefined,
	};
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
	// The provider is a separate axis from the mode: `provider` says who answers,
	// `mode` says whether anything is sent at all. A typo must fail at load rather
	// than silently keep the default and bill the wrong service.
	const provider = record.provider;
	if (provider !== undefined && provider !== "typesafe" && provider !== "laya") {
		throw new ConfigError(`provider must be one of typesafe | laya`, "jev.provider");
	}
	// `jev.enabled: false` is the shorthand several PRDs use for a fully local
	// project; it is the same switch as `mode: disabled`, not a second one.
	const resolvedMode: JevMode = record.enabled === false ? "disabled" : ((mode as JevMode | undefined) ?? "enabled");
	const usdPerMtok = record.usd_per_mtok;
	if (usdPerMtok !== undefined && (typeof usdPerMtok !== "number" || !Number.isFinite(usdPerMtok) || usdPerMtok < 0)) {
		throw new ConfigError(`usd_per_mtok must be a non-negative finite number`, "jev.usd_per_mtok");
	}
	return {
		apiKey: typeof record.apiKey === "string" ? record.apiKey : null,
		endpoint: typeof record.endpoint === "string" ? record.endpoint : "https://api.typesafe.ai/v1/systemone",
		model: typeof record.model === "string" ? record.model : "jev-latest",
		mode: resolvedMode,
		usd_per_mtok: (usdPerMtok as number | undefined) ?? 0,
		provider: (provider as JevProvider | undefined) ?? "typesafe",
		laya: parseLaya(record.laya),
	};
}

/**
 * The top-level `cost:` block: retained verbatim (with numeric validation) so
 * `resolveCostConfig` reads the declared policy. Per-backend rates keep their
 * home under `backends.<name>.cost`; this block is the run-level policy.
 */
function parseCost(raw: unknown): CostBlockConfig | undefined {
	if (raw === undefined) return undefined;
	const record = asRecord(raw, "cost");
	const finite = (key: string): number | undefined => {
		const value = record[key];
		if (value === undefined) return undefined;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new ConfigError(`must be a non-negative finite number`, `cost.${key}`);
		}
		return value;
	};
	const models = record.models === undefined ? undefined : (asRecord(record.models, "cost.models") as CostBlockConfig["models"]);
	if (models) for (const [model, rates] of Object.entries(models)) validateMonetaryBlock(rates, `cost.models.${model}`);
	const quotaShadow =
		record.quota_shadow_usd === undefined
			? undefined
			: (asRecord(record.quota_shadow_usd, "cost.quota_shadow_usd") as Record<string, number>);
	if (quotaShadow) {
		for (const [quotaClass, value] of Object.entries(quotaShadow)) {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
				throw new ConfigError(`must be a non-negative finite number`, `cost.quota_shadow_usd.${quotaClass}`);
			}
		}
	}
	const telemetryPath = record.telemetry_path;
	if (telemetryPath !== undefined && (typeof telemetryPath !== "string" || telemetryPath.length === 0)) {
		throw new ConfigError(`telemetry_path must be a non-empty string`, "cost.telemetry_path");
	}
	const local = finite("local_usd_per_gpu_sec");
	const latency = finite("latency_usd_per_sec");
	return {
		...(models === undefined ? {} : { models }),
		...(quotaShadow === undefined ? {} : { quota_shadow_usd: quotaShadow }),
		...(local === undefined ? {} : { local_usd_per_gpu_sec: local }),
		...(latency === undefined ? {} : { latency_usd_per_sec: latency }),
		...(telemetryPath === undefined ? {} : { telemetry_path: telemetryPath }),
	};
}

/**
 * The top-level `routing:` block (PRD-020). Retained so the router reads the
 * operator's declared calibration; the cached-input fraction is a share, so a
 * value outside `[0,1]` fails load rather than pricing predicted input negative.
 */
function parseRouting(raw: unknown): RoutingBlockConfig | undefined {
	if (raw === undefined) return undefined;
	const record = asRecord(raw, "routing");
	const fraction = record.predicted_cached_input_fraction;
	if (fraction !== undefined && (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1)) {
		throw new ConfigError(`must be a fraction between 0 and 1`, "routing.predicted_cached_input_fraction");
	}
	return record as RoutingBlockConfig;
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

/**
 * The `recap:` block (PRD-036): on by default, on the `quick` role. A role outside
 * the six is a config error rather than a value that silently resolves nowhere.
 */
function parseRecap(raw: unknown): LeanPiConfig["recap"] {
	const record = raw === undefined ? {} : asRecord(raw, "recap");
	const enabled = record.enabled;
	if (enabled !== undefined && typeof enabled !== "boolean") {
		throw new ConfigError(`enabled must be a boolean`, "recap.enabled");
	}
	const role = record.role;
	if (role !== undefined && (typeof role !== "string" || !isModelRole(role))) {
		throw new ConfigError(`role must name a model role (${MODEL_ROLES.join(" | ")})`, "recap.role");
	}
	return { enabled: (enabled as boolean | undefined) ?? true, role: (role as ModelRole | undefined) ?? "quick" };
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
	// PRD-022: the runtime declarations carry executable commands, so a malformed
	// block is a named error here rather than a field the verifier drops at run
	// time and reports `not_run` for a turn that already depends on it.
	let runtime: VerifyConfig["runtime"];
	if (record.runtime !== undefined) {
		const parsed = parseRuntimePlan(record.runtime, { commands });
		if (parsed.issues.length > 0) {
			const field = parsed.issues[0]!;
			throw new ConfigError(`invalid runtime declaration${field.length > 0 ? ` at ${field}` : ""}: expected the smoke/cli/browser/screenshot shape from runtime/plan.ts`, `verify.runtime${field.length > 0 ? `.${field}` : ""}`);
		}
		runtime = parsed.plan;
	}
	return { commands, ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }), ...(runtime === undefined ? {} : { runtime }) };
}

/**
 * The bounded-execution limits (PRD-007/PDR-009/PRD-022). Every budget that
 * reaches a loop is a non-negative integer here: a fractional or negative
 * `executionAttempts` would otherwise escape into `for (;;)` accounting, and a
 * non-finite one could disable the loop's only bound. `max_escalations` stays
 * absent when unconfigured so the compiler keeps its complexity-derived default.
 */
function parseLimits(raw: unknown): LeanPiConfig["limits"] {
	const record = raw === undefined ? {} : asRecord(raw, "limits");
	const budget = (key: "executionAttempts" | "semanticReviewRounds" | "max_escalations", fallback?: number): number | undefined => {
		const value = record[key];
		if (value === undefined) return fallback;
		if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
			throw new ConfigError(`must be a non-negative integer`, `limits.${key}`);
		}
		return value;
	};
	const isolation = record.isolation;
	if (isolation !== undefined && isolation !== "none" && isolation !== "worktree") {
		throw new ConfigError(`must be one of none | worktree`, "limits.isolation");
	}
	// Every ceiling stays absent when unconfigured: the compiler's complexity
	// default applies, and an explicit `0` is still the operator's own bound.
	return {
		...(record.executionAttempts === undefined ? {} : { executionAttempts: budget("executionAttempts")! }),
		...(record.semanticReviewRounds === undefined ? {} : { semanticReviewRounds: budget("semanticReviewRounds")! }),
		...(record.max_escalations === undefined ? {} : { max_escalations: budget("max_escalations")! }),
		isolation: (isolation as "none" | "worktree" | undefined) ?? "none",
	};
}

/** The `workspace:` block (PRD-022): where an isolated run's checkout is created. */
function parseWorkspace(raw: unknown): LeanPiConfig["workspace"] {
	if (raw === undefined) return undefined;
	const record = asRecord(raw, "workspace");
	const worktreeRoot = record.worktreeRoot;
	if (worktreeRoot !== undefined && (typeof worktreeRoot !== "string" || worktreeRoot.trim().length === 0)) {
		throw new ConfigError(`worktreeRoot must be a non-empty path`, "workspace.worktreeRoot");
	}
	return worktreeRoot === undefined ? {} : { worktreeRoot: worktreeRoot as string };
}

/**
 * A command the project itself supplies: a path that resolves inside the
 * checkout. A bare name (`claude`, `codex`) is a PATH lookup for an installed
 * binary and an absolute path outside the tree is not something a clone can
 * ship, so neither is a capability the repository granted itself.
 */
function projectSuppliedCommand(cwd: string, command: string): boolean {
	return (command.includes("/") || isAbsolute(command)) && isProjectLocal(cwd, command);
}

/**
 * T1: an untrusted project cannot contribute an executable. The backend entry
 * survives (a `models:` binding still resolves), but a `command` the checkout
 * ships is removed, so the registry cannot spawn it.
 */
function withoutProjectSuppliedCommands(cwd: string, backends: Record<string, BackendConfig>): Record<string, BackendConfig> {
	const safe: Record<string, BackendConfig> = {};
	for (const [name, entry] of Object.entries(backends)) {
		if (entry.type !== "external_harness" || typeof entry.command !== "string" || !projectSuppliedCommand(cwd, entry.command)) {
			safe[name] = entry;
			continue;
		}
		const { command: _dropped, ...rest } = entry;
		safe[name] = rest;
	}
	return safe;
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

	const backends = parseBackends(record.backends);
	// PRD-017: assertTrusted runs between load and use. An untrusted project keeps
	// nothing executable and nothing project-local on the capability surface.
	const capabilities = parseCapabilities(record.capabilities);
	const configPath = existsSync(path) ? path : null;
	const trust = assertTrusted(cwd, env, {
		skillRoots: capabilities.skillRoots,
		mcpConfigPaths: capabilities.mcpConfigPaths,
	});
	const skillRoots = trust.trusted ? capabilities.skillRoots : capabilities.skillRoots.filter((root) => !isProjectLocal(cwd, root));
	// T1: until the project is trusted, it contributes no executable backend
	// command and no shell verifier command; the parsed entries stay so a role
	// binding still resolves.
	const effectiveBackends = trust.trusted ? backends : withoutProjectSuppliedCommands(cwd, backends);
	const parsedVerify = parseVerify(record.verify);
	// T1: an untrusted project contributes no executable verifier command — and
	// PRD-022's `runtime` block is a command carrier too, so it is dropped with
	// the commands rather than left as a second execution path. The timeout is
	// not executable and is preserved.
	const effectiveVerify: VerifyConfig = trust.trusted
		? parsedVerify
		: { ...(parsedVerify.timeoutMs === undefined ? {} : { timeoutMs: parsedVerify.timeoutMs }), commands: {} };
	// SURF-3: a `servers` override names an executable, and it comes from the
	// untrusted YAML. An untrusted project keeps the `mode` (not executable) but
	// contributes no server command; the built-in table and PATH still apply.
	const parsedLsp = parseLsp(record.lsp);
	const effectiveLsp = trust.trusted ? parsedLsp : { ...parsedLsp, servers: {} };
	const permissions = mergePermissions({
		user: readUserState(env),
		project: parsePermissions(record.permissions),
		trust,
	});
	const config: LeanPiConfig = {
		configPath,
		backends: effectiveBackends,
		models: parseModels(record.models, backends),
		instructions: { ponytail: (instructionsRaw.ponytail as boolean | undefined) ?? true },
		jev: parseJev(record.jev),
		capabilities: { ...capabilities, skillRoots },
		skills: parseSkills(record.skills),
		bench: parseBench(record.bench),
		context: parseContext(record.context),
		lsp: effectiveLsp,
		mcp: parseMcp(record.mcp),
		capability: parseCapability(record.capability),
		cost: parseCost(record.cost),
		routing: parseRouting(record.routing),
		recap: parseRecap(record.recap),
		verify: effectiveVerify,
		permissions,
		thresholds: parseThresholds(record.thresholds),
		limits: parseLimits(record.limits),
		workspace: parseWorkspace(record.workspace),
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

/**
 * The `apiKey` field for a provider registration, or nothing.
 *
 * A bare name in LeanPi's config means "the variable of that name". If the
 * variable is absent, Pi reads the bare name as a *literal key* and the
 * provider answers `401 Invalid API key` — indistinguishable, to a user who just
 * configured the key, from a verdict on it. Registering nothing lets Pi fall
 * back to its own stored credential for the provider. Every registration path
 * (the interactive session and the native worker) goes through here, so a key
 * cannot be resolved one way in one path and literally in the other.
 */
export function apiKeyFor(declared: unknown, env: Record<string, string | undefined> = process.env): { apiKey: string } | undefined {
	if (typeof declared !== "string" || declared.length === 0) return undefined;
	const bareName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(declared);
	if (bareName && (env[declared] === undefined || env[declared] === "")) return undefined;
	return { apiKey: toPiConfigValue(declared, env) };
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

/**
 * Persist one `/model` binding: the role, the vendor backend entry when the
 * config has none — named after the vendor, which is how the registry infers
 * one — and the `capability.roles.<role>.pin` that makes the choice stick.
 * Without the pin the capability index re-picks the role's model every turn and
 * the operator's selection lasts one turn. Written key by key like
 * `writeSkillsState`, so an operator's comments and unrelated blocks survive
 * the edit.
 */
export function writeRoleBinding(cwd: string, role: ModelRole, backend: string, model: string): void {
	const path = configPathFor(cwd);
	const parsed = existsSync(path) ? (parseYaml(readFileSync(path, "utf8")) as unknown) : undefined;
	const root = parsed === undefined || parsed === null ? {} : (parsed as Record<string, unknown>);
	const backends = (root.backends ?? {}) as Record<string, unknown>;
	// A discovered CLI model is unusable until its backend is declared; the
	// vendor's own login stays in the vendor's CLI, so the entry is two keys.
	if (backends[backend] === undefined) backends[backend] = { type: "external_harness" };
	root.backends = backends;
	const models = (root.models ?? {}) as Record<string, unknown>;
	models[role] = { backend, model };
	root.models = models;
	const capability = (root.capability ?? {}) as Record<string, unknown>;
	const roles = (capability.roles ?? {}) as Record<string, unknown>;
	roles[role] = { ...((roles[role] ?? {}) as Record<string, unknown>), pin: model };
	capability.roles = roles;
	root.capability = capability;
	writeFileSync(path, stringifyYaml(root));
}
