/**
 * The project trust gate and the asymmetric permission merge (PRD-017 Phase 2).
 *
 * Project-local configuration is untrusted input: until a trust record exists
 * for the project, its executable extensions, its MCP server declarations and
 * its project-local skill roots are *dropped* from the loaded configuration —
 * not loaded and then blocked — so no code path exists in which they run.
 *
 * Trust is keyed to the SHA-256 of the project's executable/MCP surface, so
 * editing a trusted config revokes trust until it is re-granted. Project scope
 * can also only *tighten* permissions: a repository cannot grant itself the
 * reach it wants.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	BUILTIN_DEFAULTS,
	builtinPermissions,
	DECISION_RANK,
	SCOPES,
	isPermissionDecision,
	isScope,
	resolve as resolveCapability,
	type IgnoredProjectGrant,
	type PermissionDecision,
	type PermissionRule,
	type PermissionsConfig,
	type Resolution,
	type Scope,
} from "./rules.js";
import { BUILTIN_SECRETS_POLICY, type SecretsPolicy } from "./secrets.js";
import { configPathFor } from "../core/config-path.js";

export interface PermissionEnv {
	XDG_CONFIG_HOME?: string;
	HOME?: string;
	/** `--safety <level>`, forwarded by the launcher; unset means "no level". */
	LEANPI_SAFETY?: string;
}

/** User-scope state file, outside the repository, next to the credential store. */
export function permissionsPath(env: PermissionEnv = process.env): string {
	const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config");
	return join(base, "leanpi", "permissions.json");
}

export interface TrustRecord {
	root: string;
	surfaceHash: string;
	/** Per-file hashes at grant time; a mismatch names the file that changed. */
	files: Record<string, string>;
	grantedAt: string;
}

export interface UserPermissionState {
	defaults: Partial<Record<Scope, PermissionDecision>>;
	rules: PermissionRule[];
	trust: Record<string, TrustRecord>;
	secrets: SecretsPolicy;
}

/** A fresh empty state: the returned object is mutated by writers, so it is never shared. */
function emptyUserState(): UserPermissionState {
	return { defaults: {}, rules: [], trust: {}, secrets: { ...BUILTIN_SECRETS_POLICY } };
}

/** Tolerant read: a corrupt or absent store is an empty store, never a crash. */
export function readUserState(env: PermissionEnv = process.env): UserPermissionState {
	const path = permissionsPath(env);
	if (!existsSync(path)) return emptyUserState();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const defaults: Partial<Record<Scope, PermissionDecision>> = {};
		const rawDefaults = (parsed.defaults ?? {}) as Record<string, unknown>;
		for (const [scope, decision] of Object.entries(rawDefaults)) {
			if (isScope(scope) && typeof decision === "string" && isPermissionDecision(decision)) defaults[scope] = decision;
		}
		const rules: PermissionRule[] = [];
		for (const entry of Array.isArray(parsed.rules) ? parsed.rules : []) {
			const rule = entry as Record<string, unknown>;
			if (typeof rule.capability !== "string" || typeof rule.decision !== "string" || !isPermissionDecision(rule.decision)) continue;
			rules.push({ capability: rule.capability, decision: rule.decision, source: "user" });
		}
		const secretsRaw = (parsed.secrets ?? {}) as Record<string, unknown>;
		return {
			defaults,
			rules,
			trust: (parsed.trust ?? {}) as Record<string, TrustRecord>,
			secrets: {
				passthrough: Array.isArray(secretsRaw.passthrough) ? (secretsRaw.passthrough as string[]) : [],
				secretNames: Array.isArray(secretsRaw.secretNames) ? (secretsRaw.secretNames as string[]) : [],
				minLength: typeof secretsRaw.minLength === "number" ? secretsRaw.minLength : BUILTIN_SECRETS_POLICY.minLength,
			},
		};
	} catch {
		return emptyUserState();
	}
}

function writeUserState(state: UserPermissionState, env: PermissionEnv): string {
	const path = permissionsPath(env);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				defaults: state.defaults,
				rules: state.rules.map(({ capability, decision }) => ({ capability, decision })),
				trust: state.trust,
				secrets: state.secrets,
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
	chmodSync(path, 0o600);
	return path;
}

/** `/permissions set <scope> <decision>`: a user-scope scope default. */
export function writeUserDefault(scope: Scope, decision: PermissionDecision, env: PermissionEnv = process.env): string {
	const state = readUserState(env);
	state.defaults[scope] = decision;
	return writeUserState(state, env);
}

/** User-scope secret-containment policy: passthrough names and extra secret names. */
export function writeUserSecretsPolicy(policy: Partial<SecretsPolicy>, env: PermissionEnv = process.env): string {
	const state = readUserState(env);
	state.secrets = {
		passthrough: policy.passthrough ?? state.secrets.passthrough,
		secretNames: policy.secretNames ?? state.secrets.secretNames,
		minLength: policy.minLength ?? state.secrets.minLength,
	};
	return writeUserState(state, env);
}

/** `/permissions set <capability> <decision>`: a user-scope capability rule. */
export function writeUserRule(capability: string, decision: PermissionDecision, env: PermissionEnv = process.env): string {
	const state = readUserState(env);
	state.rules = [...state.rules.filter((rule) => rule.capability !== capability), { capability, decision, source: "user" }];
	return writeUserState(state, env);
}

// ---------------------------------------------------------------------------
// The project surface and its hash
// ---------------------------------------------------------------------------

export interface SurfaceDeclaration {
	skillRoots?: string[];
	mcpConfigPaths?: string[];
	/** The project config file that was loaded, when one exists; part of the trusted surface. */
	configPath?: string;
}

export interface ProjectSurface {
	root: string;
	extensionsDir: string;
	/** Project-scope MCP config files, resolved; `.leanpi/mcp.json` when none declared. */
	mcpConfigPaths: string[];
	/** Project-local skill roots only: a root the user installed is user scope. */
	skillRoots: string[];
	/** The project's own `leanpi.config.yaml`, when it exists and is project-local. */
	configPath?: string;
}

function contained(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export function isProjectLocal(root: string, candidate: string): boolean {
	if (candidate.length === 0) return false;
	const base = resolve(root);
	const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate);
	if (contained(base, absolute)) return true;
	// A path that only *appears* outside is still local when a symlink leads back in.
	try {
		return contained(resolve(realpathSync(absolute)), resolve(realpathSync(base)));
	} catch {
		return false;
	}
}

function hashTarget(root: string, target: string, into: Map<string, string>): void {
	let stats;
	try {
		stats = statSync(target, { throwIfNoEntry: false });
	} catch {
		return;
	}
	if (!stats) return;
	if (stats.isDirectory()) {
		for (const entry of readdirSync(target)) hashTarget(root, join(target, entry), into);
		return;
	}
	const content = stats.isSymbolicLink() ? `link:${realpathSync(target)}` : readFileSync(target).toString("base64");
	into.set(relative(root, target), createHash("sha256").update(content).digest("hex"));
}

/** Every file of the executable/MCP surface, keyed by path relative to the project root. */
export function surfaceFiles(surface: ProjectSurface): Map<string, string> {
	const files = new Map<string, string>();
	hashTarget(surface.root, surface.extensionsDir, files);
	for (const configPath of surface.mcpConfigPaths) hashTarget(surface.root, configPath, files);
	for (const skillRoot of surface.skillRoots) hashTarget(surface.root, skillRoot, files);
	if (surface.configPath !== undefined) hashTarget(surface.root, surface.configPath, files);
	return files;
}

export function projectSurfaceHash(surface: ProjectSurface): string {
	const lines = [...surfaceFiles(surface).entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, hash]) => `${path}\0${hash}`);
	return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** Resolved from config, never from a literal absolute path. */
export function projectSurface(root: string, declared: SurfaceDeclaration = {}): ProjectSurface {
	const absolute = resolve(root);
	const declaredSkills = declared.skillRoots ?? [];
	const skillRoots = declaredSkills.filter((entry) => isProjectLocal(absolute, entry));
	for (const fallback of [".claude/skills", ".codex/skills"]) {
		const candidate = join(absolute, fallback);
		if (!skillRoots.includes(candidate) && existsSync(candidate)) skillRoots.push(candidate);
	}
	const declaredMcp = (declared.mcpConfigPaths ?? []).filter((entry) => entry.length > 0);
	// The config file is part of the executable surface: editing it revokes trust,
	// so a trusted project cannot later add a `backends[].command` unchecked.
	const configPath =
		declared.configPath !== undefined && existsSync(declared.configPath) && isProjectLocal(absolute, declared.configPath)
			? resolve(declared.configPath)
			: undefined;
	return {
		root: absolute,
		extensionsDir: join(absolute, ".leanpi", "extensions"),
		mcpConfigPaths: (declaredMcp.length > 0 ? declaredMcp : [".leanpi/mcp.json"]).map((entry) => (isAbsolute(entry) ? resolve(entry) : resolve(absolute, entry))),
		skillRoots,
		...(configPath === undefined ? {} : { configPath }),
	};
}

// ---------------------------------------------------------------------------
// Trust records
// ---------------------------------------------------------------------------

export interface McpServerDeclaration {
	name: string;
	command?: string;
	args?: string[];
	configPath: string;
}

export interface TrustedProjectSubset {
	extensions: string[];
	mcpConfigPaths: string[];
	mcpServers: McpServerDeclaration[];
	skillRoots: string[];
}

export interface ProjectTrustStatus {
	root: string;
	trusted: boolean;
	status: "trusted" | "untrusted" | "changed";
	reason: string;
	/** The exact surface the hash was computed over; trust is re-checked against it. */
	surface: ProjectSurface;
	surfaceHash: string;
	grantedAt?: string;
	changedFile?: string;
	/** Surface entries that were dropped because the project is not trusted. */
	dropped: string[];
	/** What the rest of LeanPi is allowed to see of the project configuration. */
	subset: TrustedProjectSubset;
}

function firstDifference(recorded: Record<string, string>, current: Map<string, string>): string | undefined {
	const paths = [...new Set([...Object.keys(recorded), ...current.keys()])].sort();
	return paths.find((path) => recorded[path] !== current.get(path));
}

/** Everything the project would contribute when trusted, for the "dropped" report. */
function droppedSurface(surface: ProjectSurface): string[] {
	return [...surface.mcpConfigPaths, surface.extensionsDir, ...surface.skillRoots, ...(surface.configPath === undefined ? [] : [surface.configPath])];
}

function extensionModules(directory: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return [];
	}
	return entries
		.filter((entry) => /\.(m?js|cjs|ts)$/.test(entry))
		.map((entry) => join(directory, entry))
		.sort();
}

function mcpServers(configPath: string): McpServerDeclaration[] {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	} catch {
		return [];
	}
	const servers = (parsed.mcpServers ?? parsed.servers ?? {}) as Record<string, Record<string, unknown>>;
	return Object.entries(servers).map(([name, entry]) => ({
		name,
		...(typeof entry.command === "string" ? { command: entry.command } : {}),
		...(Array.isArray(entry.args) ? { args: entry.args as string[] } : {}),
		configPath,
	}));
}

/** The check the config path runs before anything project-supplied is registered. */
export function assertTrusted(root: string, env: PermissionEnv = process.env, declared: SurfaceDeclaration = {}): ProjectTrustStatus {
	const surface = projectSurface(root, { ...declared, configPath: declared.configPath ?? configPathFor(root, env) });
	const files = surfaceFiles(surface);
	const surfaceHash = projectSurfaceHash(surface);
	const record = readUserState(env).trust[surface.root];
	const untrustedSubset: TrustedProjectSubset = { extensions: [], mcpConfigPaths: [], mcpServers: [], skillRoots: [] };

	if (!record) {
		return {
			root: surface.root,
			trusted: false,
			status: "untrusted",
			reason: "no trust record for this project",
			surface,
			surfaceHash,
			dropped: droppedSurface(surface),
			subset: untrustedSubset,
		};
	}
	if (record.surfaceHash !== surfaceHash) {
		const changedFile = firstDifference(record.files ?? {}, files);
		return {
			root: surface.root,
			trusted: false,
			status: "changed",
			reason: changedFile ? `trusted surface changed: ${changedFile}` : "trusted surface changed",
			surface,
			surfaceHash,
			grantedAt: record.grantedAt,
			...(changedFile ? { changedFile } : {}),
			dropped: droppedSurface(surface),
			subset: untrustedSubset,
		};
	}
	return {
		root: surface.root,
		trusted: true,
		status: "trusted",
		reason: "trust record matches the project surface",
		surface,
		surfaceHash,
		grantedAt: record.grantedAt,
		dropped: [],
		subset: {
			extensions: extensionModules(surface.extensionsDir),
			mcpConfigPaths: surface.mcpConfigPaths.filter((configPath) => existsSync(configPath)),
			mcpServers: surface.mcpConfigPaths.flatMap((configPath) => mcpServers(configPath)),
			skillRoots: surface.skillRoots,
		},
	};
}

/** `/permissions trust project`: record the surface hash that trust is bound to. */
export function grantTrust(root: string, env: PermissionEnv = process.env, declared: SurfaceDeclaration = {}): ProjectTrustStatus {
	const surface = projectSurface(root, { ...declared, configPath: declared.configPath ?? configPathFor(root, env) });
	const state = readUserState(env);
	state.trust[surface.root] = {
		root: surface.root,
		surfaceHash: projectSurfaceHash(surface),
		files: Object.fromEntries(surfaceFiles(surface)),
		grantedAt: new Date().toISOString(),
	};
	writeUserState(state, env);
	return assertTrusted(surface.root, env, declared);
}

/**
 * Built-in permissions with no user or project scope applied — the stand-in for
 * a config that has no project on disk (`fallbackConfig` in the compiler).
 */
export function resolvedDefaults(): ResolvedPermissions {
	const root = "";
	return {
		...builtinPermissions(),
		secrets: { ...BUILTIN_SECRETS_POLICY },
		trust: {
			root,
			trusted: false,
			status: "untrusted",
			reason: "no project on disk",
			surface: { root, extensionsDir: "", mcpConfigPaths: [], skillRoots: [] },
			surfaceHash: "",
			dropped: [],
			subset: { extensions: [], mcpConfigPaths: [], mcpServers: [], skillRoots: [] },
		},
	};
}

/** The same check, under the name the Integration Ledger uses. */
export const trustState = assertTrusted;

// ---------------------------------------------------------------------------
// The asymmetric merge
// ---------------------------------------------------------------------------

export interface RawPermissionsBlock {
	defaults?: Record<string, unknown>;
	rules?: unknown[];
	trust?: boolean;
	secrets?: { passthrough?: string[]; secretNames?: string[]; minLength?: number };
}

export interface ResolvedPermissions extends PermissionsConfig {
	secrets: SecretsPolicy;
	/** Project trust as measured when this config was loaded. */
	trust: ProjectTrustStatus;
}

const LOOSENING_REASON = "project scope may only tighten permissions";

/**
 * The secrets fields tighten in different directions, so each has its own
 * reason rather than `LOOSENING_REASON`: a lower `minLength` redacts more, an
 * extra `secretNames` entry matches more, and an extra `passthrough` entry
 * forwards more to spawned children.
 */
const MIN_LENGTH_RAISE_REASON = "raising minLength would stop redacting shorter values; a project may only lower it";
const PASSTHROUGH_REASON = "passthrough stays user scope: project-named env vars would otherwise reach spawned children";

/**
 * Effective permissions = built-in defaults ← user scope ← project scope, where
 * a project entry is applied only when it is strictly stricter than what user
 * scope already resolves to. Everything rejected is recorded for `/permissions`.
 */
export function mergePermissions(input: {
	user: UserPermissionState;
	project: RawPermissionsBlock;
	trust: ProjectTrustStatus;
}): ResolvedPermissions {
	const { user, project, trust } = input;
	const defaults: Record<Scope, PermissionDecision> = { ...BUILTIN_DEFAULTS };
	const defaultSources = Object.fromEntries(SCOPES.map((scope) => [scope, "builtin"])) as Record<Scope, "user" | "project" | "builtin">;
	const ignoredProjectGrants: IgnoredProjectGrant[] = [];

	for (const scope of SCOPES) {
		const userDefault = user.defaults[scope];
		if (!userDefault) continue;
		defaults[scope] = userDefault;
		defaultSources[scope] = "user";
	}

	for (const [scope, decision] of Object.entries(project.defaults ?? {})) {
		if (!isScope(scope) || typeof decision !== "string" || !isPermissionDecision(decision)) continue;
		if (DECISION_RANK[decision] <= DECISION_RANK[defaults[scope]]) {
			ignoredProjectGrants.push({ capability: scope, decision, reason: LOOSENING_REASON });
			continue;
		}
		defaults[scope] = decision;
		defaultSources[scope] = "project";
	}

	const rules: PermissionRule[] = [...user.rules];
	for (const entry of project.rules ?? []) {
		const rule = entry as Record<string, unknown>;
		if (typeof rule.capability !== "string" || typeof rule.decision !== "string" || !isPermissionDecision(rule.decision)) continue;
		const baseline: Resolution = resolveCapability(rule.capability, { defaults, defaultSources, rules, ignoredProjectGrants: [] });
		if (DECISION_RANK[rule.decision] <= DECISION_RANK[baseline.decision]) {
			ignoredProjectGrants.push({ capability: rule.capability, decision: rule.decision, reason: LOOSENING_REASON });
			continue;
		}
		rules.push({ capability: rule.capability, decision: rule.decision, source: "project" });
	}

	if (project.trust === true) {
		ignoredProjectGrants.push({
			capability: "trust",
			decision: "deny",
			reason: "a project config cannot grant itself trust; use /permissions trust project",
		});
	}

	const secrets: SecretsPolicy = {
		passthrough: [...new Set([...user.secrets.passthrough, ...BUILTIN_SECRETS_POLICY.passthrough])],
		secretNames: [...new Set([...user.secrets.secretNames, ...BUILTIN_SECRETS_POLICY.secretNames])],
		minLength: user.secrets.minLength || BUILTIN_SECRETS_POLICY.minLength,
	};
	if (project.secrets) {
		if (!trust.trusted) {
			ignoredProjectGrants.push({
				capability: "permissions.secrets",
				decision: "allow",
				reason: "project secrets policy ignored while the project is untrusted",
			});
		} else {
			// Lowering the floor redacts more values, so it is the only project
			// minLength that applies.
			const projectMinLength = project.secrets.minLength;
			if (typeof projectMinLength === "number") {
				if (projectMinLength > secrets.minLength) {
					ignoredProjectGrants.push({ capability: "permissions.secrets.minLength", decision: "deny", reason: MIN_LENGTH_RAISE_REASON });
				} else {
					secrets.minLength = projectMinLength;
				}
			}
			// Extra names only widen what can be matched, so they apply.
			secrets.secretNames = [...new Set([...secrets.secretNames, ...(project.secrets.secretNames ?? [])])];
			// Forwarding stays user-owned: a project cannot put env vars into children.
			if (project.secrets.passthrough?.length) {
				ignoredProjectGrants.push({ capability: "permissions.secrets.passthrough", decision: "deny", reason: PASSTHROUGH_REASON });
			}
		}
	}

	return { defaults, defaultSources, rules, ignoredProjectGrants, secrets, trust };
}
