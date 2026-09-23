/**
 * The pi-subagents integration (PRD-041).
 *
 * LeanPi selects the one pinned `pi-subagents` resource path and lets Pi's
 * native loader attach it, and owns two things the package does not: the
 * operator's per-run child concurrency limit, and a shipped default that works
 * with LeanPi's registered-only native models.
 *
 * The config path is upstream's own: the public SDK `getAgentDir()` (which the
 * package also calls) plus `extensions/subagent/config.json`. LeanPi writes only
 * the keys it owns and preserves every other key, because the file is shared
 * with upstream's other settings. A malformed or unsafe file aborts selection
 * with an actionable error before anything loads, so a session never runs with a
 * silently clamped cap against a file it does not understand.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Pi from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ResolvedResource } from "@earendil-works/pi-coding-agent";
import { dependencyDir } from "../cli/launch.js";

// The three SDK modules this file uses, not the SDK's index: the launcher imports
// this file before the banner, and the index (every provider, tool and TUI
// component) held the logo back ~400ms on every start.
// ponytail: deep paths past Pi's `exports`; a Pi release that moves them fails this import at startup and in the suite.
const sdkDir = dependencyDir(join("@earendil-works", "pi-coding-agent", "dist"), leanPiPackageRoot());
if (sdkDir === undefined) throw new Error("@earendil-works/pi-coding-agent is missing from this installation of leanpi; reinstall it.");
const sdk = (path: string) => import(pathToFileURL(join(sdkDir, path)).href) as Promise<typeof Pi>;
const [{ getAgentDir }, { SettingsManager }, { DefaultPackageManager }] = await Promise.all([
	sdk("config.js"),
	sdk("core/settings-manager.js"),
	sdk("core/package-manager.js"),
]);

/** The per-run child concurrency LeanPi enforces unless the operator says otherwise. */
export const SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT = 3;

/** The two upstream config keys LeanPi owns. */
export const SUBAGENTS_LIMIT_KEY = "globalConcurrencyLimit";
export const SUBAGENTS_ASYNC_KEY = "asyncByDefault";

/** The parent tools the pinned package registers (verified in 0.70.1). */
export const SUBAGENT_PARENT_TOOL_NAMES = ["subagent", "bg_wait", "subagent_supervisor"] as const;

/** The subset upstream intends to be active as soon as it registers. */
export const SUBAGENT_ACTIVE_TOOL_NAMES = ["subagent", "bg_wait"] as const;

/** Upstream's config path, resolved the same way upstream resolves it. */
export function subagentConfigPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "extensions", "subagent", "config.json");
}

/** A valid operator limit: a positive safe integer. */
export function isValidConcurrencyLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

interface ReadConfig {
	exists: boolean;
	value?: Record<string, unknown>;
	problem?: string;
}

function readConfigObject(agentDir: string): ReadConfig {
	const path = subagentConfigPath(agentDir);
	if (!existsSync(path)) return { exists: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return { exists: true, problem: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { exists: true, problem: "not a JSON object" };
	return { exists: true, value: parsed as Record<string, unknown> };
}

/** Atomic write: a sibling temp file, then `renameSync`, so a crash never truncates the config. */
function writeConfigObject(path: string, value: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	renameSync(temporary, path);
}

export type EnsureConfigOutcome =
	| { status: "created" | "present"; path: string; limit: number }
	| { status: "invalid"; path: string; problem: string };

/** A config LeanPi can safely extend: a plain JSON object whose owned keys are valid when present. */
function ownedKeyProblem(config: Record<string, unknown>): string | undefined {
	const limit = config[SUBAGENTS_LIMIT_KEY];
	if (limit !== undefined && !isValidConcurrencyLimit(limit)) {
		return `${SUBAGENTS_LIMIT_KEY} must be a positive safe integer, got ${JSON.stringify(limit)}`;
	}
	const asyncDefault = config[SUBAGENTS_ASYNC_KEY];
	if (asyncDefault !== undefined && typeof asyncDefault !== "boolean") {
		return `${SUBAGENTS_ASYNC_KEY} must be a boolean, got ${JSON.stringify(asyncDefault)}`;
	}
	return undefined;
}

/**
 * Write LeanPi's defaults when the config does not already name them.
 *
 * - absent file, or a plain object missing an owned key → add only that key
 * - explicit valid values → leave every one of them alone
 * - malformed JSON, non-object, or an explicit invalid owned key → **no write**
 *
 * The default `asyncByDefault:false` is deliberate: LeanPi registers only native
 * models, so an async child (an external process) cannot see the parent's
 * provider and would fail to resolve `backend/model`. Async still works when the
 * operator names a child-visible provider/model and sets `asyncByDefault:true`.
 */
export function ensureDefaultConfig(agentDir: string = getAgentDir()): EnsureConfigOutcome {
	const path = subagentConfigPath(agentDir);
	const current = readConfigObject(agentDir);
	if (current.value === undefined) {
		if (current.exists) return { status: "invalid", path, problem: current.problem ?? "unreadable" };
		writeConfigObject(path, { [SUBAGENTS_LIMIT_KEY]: SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT, [SUBAGENTS_ASYNC_KEY]: false });
		return { status: "created", path, limit: SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT };
	}
	const problem = ownedKeyProblem(current.value);
	if (problem !== undefined) return { status: "invalid", path, problem };

	const next = { ...current.value };
	let changed = false;
	if (next[SUBAGENTS_LIMIT_KEY] === undefined) {
		next[SUBAGENTS_LIMIT_KEY] = SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT;
		changed = true;
	}
	if (next[SUBAGENTS_ASYNC_KEY] === undefined) {
		next[SUBAGENTS_ASYNC_KEY] = false;
		changed = true;
	}
	if (changed) writeConfigObject(path, next);
	return { status: changed ? "created" : "present", path, limit: next[SUBAGENTS_LIMIT_KEY] as number };
}

export interface OperatorLimitView {
	path: string;
	/** The value on disk, or the LeanPi default when the file has none; null when unreadable. */
	saved: number | null;
	/** The value the running session captured, or undefined when none is running. */
	active: number | undefined;
	problem?: string;
}

/**
 * Inspect without writing a byte. `saved` is what a new session would read;
 * `active` is the value the caller's session captured. When they differ, the
 * change applies after `/reload` or a restart.
 *
 * `active` is supplied by the caller — the session that captured it — rather
 * than read from a process-global map: two sessions sharing an upstream config
 * path must each report the value they actually captured.
 */
export function inspectOperatorLimit(agentDir: string = getAgentDir(), active?: number): OperatorLimitView {
	const path = subagentConfigPath(agentDir);
	const current = readConfigObject(agentDir);
	if (current.value === undefined) {
		if (current.exists) return { path, saved: null, active, problem: current.problem ?? "unreadable" };
		return { path, saved: SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT, active };
	}
	const problem = ownedKeyProblem(current.value);
	if (problem !== undefined) return { path, saved: null, active, problem };
	const saved = current.value[SUBAGENTS_LIMIT_KEY];
	return { path, saved: saved === undefined ? SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT : (saved as number), active };
}

/**
 * Persist a new operator limit, or reset to the default. Throws on an invalid
 * request and on an existing file that is not safely extensible, in both cases
 * without writing.
 */
export function setLimit(value: number | "reset", agentDir: string = getAgentDir()): { path: string; limit: number } {
	const resolved = value === "reset" ? SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT : value;
	if (!isValidConcurrencyLimit(resolved)) {
		throw new Error(`subagent concurrency limit must be a positive safe integer, got ${JSON.stringify(resolved)}`);
	}
	const path = subagentConfigPath(agentDir);
	const current = readConfigObject(agentDir);
	if (current.value === undefined) {
		if (current.exists) throw new Error(`subagent config at ${path} is ${current.problem ?? "unreadable"}; refusing to overwrite it`);
	} else {
		const problem = ownedKeyProblem(current.value);
		if (problem !== undefined) throw new Error(`subagent config at ${path} has an invalid ${problem}; refusing to overwrite it`);
	}
	writeConfigObject(path, { ...(current.value ?? {}), [SUBAGENTS_LIMIT_KEY]: resolved });
	return { path, limit: resolved };
}

/**
 * Clamp a model-issued workflow override down to the operator max.
 *
 * Upstream accepts a top-level `globalConcurrencyLimit` only on
 * `workflowScript`/`workflowScriptPath`; a plain `{agent, task}` call rejects
 * the field, so the handler never injects it there. A lower explicit value is
 * left alone — the operator max is a ceiling, not a floor.
 */
export function clampSubagentOverride(pi: Pick<ExtensionAPI, "on">, max: number): void {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent") return;
		const input = event.input as Record<string, unknown>;
		if (input.workflowScript === undefined && input.workflowScriptPath === undefined) return;
		const requested = input[SUBAGENTS_LIMIT_KEY];
		if (typeof requested === "number" && requested > max) input[SUBAGENTS_LIMIT_KEY] = max;
	});
}

/**
 * The limit a session captured at attach time: the upstream config path and the
 * value its clamp enforces. A factory/caller holds this and passes it to the
 * command surface, so the `/subagents-limit` "active" value is the one this
 * session captured — never a later session's write, even when both share an
 * upstream config path.
 */
export interface CapturedLimit {
	path: string;
	limit: number;
}

/**
 * LeanPi's own attach. It writes the defaults, installs the clamp and captures
 * the session's max — but it no longer registers the upstream package itself.
 * Upstream is loaded through Pi's native resource loader by path, so Pi's
 * canonical-path dedupe can guarantee one copy even when the operator also has
 * `pi-subagents` configured globally (see `prepareSubagents`).
 *
 * Returns the captured `{path, limit}` for the session, or `undefined` when the
 * config was invalid (a bare extension entry never blocks the session). The SDK
 * and CLI entries that also own a command surface hand this to
 * `registerSubagentsLimitCommand`; a bare extension entry ignores the return.
 */
export function subagentsFactory(pi: ExtensionAPI): CapturedLimit | undefined {
	const agentDir = getAgentDir();
	const outcome = ensureDefaultConfig(agentDir);
	if (outcome.status === "invalid") return undefined;
	clampSubagentOverride(pi, outcome.limit);
	return { path: subagentConfigPath(agentDir), limit: outcome.limit };
}

/** The upstream package name LeanPi pins and loads through Pi's resource loader. */
export const SUBAGENTS_PACKAGE_NAME = "pi-subagents";

/** Where the upstream resource will come from, for the operator-facing message on a conflict. */
export interface SubagentSelection {
	/** The exact enabled extension path Pi's own resolution returned, or the bundled pin. */
	entry: string;
	/** Human description of the source: a configured package source, or the bundled dependency. */
	source: string;
	origin: "configured" | "bundled";
	version: string;
	/** The operator max LeanPi captured, so the caller can surface the same value. */
	limit: number;
}

export interface PrepareSubagentsOptions {
	cwd: string;
	/** The resource agent dir Pi's loader will use (not necessarily `getAgentDir()`). */
	agentDir: string;
	/** The same manager the eventual Pi loader uses, so discovery cannot diverge. */
	settingsManager: Pi.SettingsManager;
	/**
	 * CLI preflight only: the interactive child re-runs Pi's trust bootstrap, so a
	 * project-scoped `pi-subagents` would load on top of the selected copy. Detect
	 * it from project settings bytes (never executing project code) and fail
	 * closed instead of silently doubling.
	 */
	rejectConfiguredProjectCopy?: boolean;
}

interface PiManifest {
	name?: string;
	version?: string;
	pi?: { extensions?: string[] };
}

function leanPiPackageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The exact upstream version LeanPi declares, read from this package's dependency. */
export function reviewedSubagentsVersion(): string {
	const raw = readFileSync(join(leanPiPackageRoot(), "package.json"), "utf8");
	const manifest = JSON.parse(raw) as { dependencies?: Record<string, string> };
	const pin = manifest.dependencies?.[SUBAGENTS_PACKAGE_NAME];
	if (typeof pin !== "string" || pin.length === 0) {
		throw new Error(`LeanPi's package.json declares no ${SUBAGENTS_PACKAGE_NAME} dependency`);
	}
	return pin;
}

function readManifest(root: string): PiManifest | undefined {
	const path = join(root, "package.json");
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PiManifest;
	} catch {
		return undefined;
	}
}

/** The package root a resolved resource belongs to, ascending to the nearest manifest for a plain local file. */
function packageRootForPath(resourcePath: string, metadata: { origin?: string; baseDir?: string }): string | undefined {
	if (metadata.origin === "package" && metadata.baseDir) return metadata.baseDir;
	let dir = dirname(resourcePath);
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Does a configured source (npm spec, git URL or local path) name the upstream
 * package? Segment equality, never a substring: `pi-subagents-extra` is not it.
 * npm is its exact package name (`@other/pi-subagents` is another package); git
 * and local sources their last path segment, so an SSH `git@host:owner/repo`
 * splits at `:`/`/`, never at the user's `@`.
 */
function identifiesSubagents(source: string): boolean {
	const spec = source.trim();
	if (spec.startsWith("npm:")) return /^(@?[^@]+(?:\/[^@]+)?)/.exec(spec.slice("npm:".length).trim())?.[1] === SUBAGENTS_PACKAGE_NAME;
	const segment = spec.replace(/[?#].*$/, "").split(/[\\/:]/).pop() ?? "";
	return segment.replace(/@.*$/, "").replace(/\.git$/, "") === SUBAGENTS_PACKAGE_NAME;
}

function configuredProjectSubagentCopy(cwd: string, pin: string): string | undefined {
	const advice = `a project copy would load on top of LeanPi's managed v${pin} one; remove or disable that entry, or run \`pi\` directly.`;
	// Pi resolves project-local sources against `.pi`; a local copy is identified
	// by its manifest name, read as data, so a renamed checkout still counts.
	const base = join(cwd, ".pi");
	const isLocalCopy = (entry: string): boolean => {
		const trimmed = entry.trim();
		// Pi's `~` rule: bare `~`, `~/`, and `~\` on Windows only.
		const home = trimmed === "~" || trimmed.startsWith("~/") || (process.platform === "win32" && trimmed.startsWith("~\\"));
		const path = home ? join(homedir(), trimmed.slice(1)) : resolve(base, trimmed);
		if (!existsSync(path)) return false;
		const root = statSync(path).isDirectory() ? path : packageRootForPath(path, {});
		return root !== undefined && readManifest(root)?.name === SUBAGENTS_PACKAGE_NAME;
	};
	const settingsPath = join(base, "settings.json");
	if (existsSync(settingsPath)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
		} catch {
			parsed = undefined;
		}
		if (parsed !== null && typeof parsed === "object") {
			const settings = parsed as { packages?: unknown; extensions?: unknown };
			// A non-array value is no list Pi loads from: skip it, never iterate it.
			for (const list of [settings.packages, settings.extensions]) {
				for (const entry of Array.isArray(list) ? list : []) {
					const source = typeof entry === "string" ? entry : (entry as { source?: unknown })?.source;
					const filter = (entry as { extensions?: unknown })?.extensions;
					// A pattern (`!x`, `-x`, `+x`, glob) only filters, and an empty package
					// filter disables the package's extensions: neither loads a copy.
					if (typeof source !== "string" || /^[!+-]|\*/.test(source.trim()) || (Array.isArray(filter) && filter.length === 0)) continue;
					const remote = /^(npm|git|github|https?|ssh):/.test(source.trim());
					if (identifiesSubagents(source) || (!remote && isLocalCopy(source))) {
						return `project settings at ${settingsPath} configure ${SUBAGENTS_PACKAGE_NAME} (${source}); ${advice}`;
					}
				}
			}
		}
	}
	// A project package dropped under `.pi/extensions/<any name>` is discovered
	// without appearing in settings; its manifest is data, not code.
	const discovered = join(base, "extensions");
	const dirs = existsSync(discovered) && statSync(discovered).isDirectory() ? readdirSync(discovered).filter((name) => !name.startsWith(".") && name !== "node_modules") : [];
	for (const dir of [discovered, ...dirs.map((name) => join(discovered, name))]) {
		if (readManifest(dir)?.name === SUBAGENTS_PACKAGE_NAME) return `project extensions at ${dir} contain ${SUBAGENTS_PACKAGE_NAME}; ${advice}`;
	}
	return undefined;
}

/**
 * A configured global upstream that is not installed: reject it before a fallback
 * the runtime would later double. Global settings belong to the SDK resource
 * `agentDir`, which need not be `getAgentDir()`.
 */
function missingConfiguredSubagentSource(manager: Pi.DefaultPackageManager, settingsManager: Pi.SettingsManager, agentDir: string, pin: string): string | undefined {
	const global = settingsManager.getGlobalSettings();
	const settingsPath = join(agentDir, "settings.json");
	for (const pkg of global.packages ?? []) {
		const source = typeof pkg === "string" ? pkg : pkg.source;
		if (!identifiesSubagents(source)) continue;
		if (manager.getInstalledPath(source, "user") !== undefined) continue;
		return `${SUBAGENTS_PACKAGE_NAME} is configured at ${source} but is not installed. Install v${pin} or remove that entry from ${settingsPath}; LeanPi will not install it during preflight.`;
	}
	for (const entry of global.extensions ?? []) {
		if (!identifiesSubagents(entry)) continue;
		const path = isAbsolute(entry) ? entry : resolve(agentDir, entry);
		if (!existsSync(path)) {
			return `${SUBAGENTS_PACKAGE_NAME} is configured at ${entry} but ${path} does not exist. Fix or remove that entry from ${settingsPath}.`;
		}
	}
	return undefined;
}

/**
 * Pick one upstream entry from Pi's own resolution. Only enabled copies count: a
 * disabled one is the operator's choice, not a conflict. An enabled copy must be
 * the pinned version; more than one is a conflict, not a silent pick. Nothing
 * here installs or writes.
 */
function resolveConfiguredEntry(extensions: ResolvedResource[], pin: string): { selection?: SubagentSelection; conflict?: string } {
	const byRoot = new Map<string, { version: string; source: string; enabled: ResolvedResource[] }>();
	for (const resource of extensions) {
		if (!resource.enabled) continue;
		const root = packageRootForPath(resource.path, resource.metadata);
		if (root === undefined) continue;
		const manifest = readManifest(root);
		if (manifest?.name !== SUBAGENTS_PACKAGE_NAME) continue;
		const entry = byRoot.get(root) ?? { version: String(manifest.version ?? "unknown"), source: resource.metadata.source, enabled: [] };
		entry.enabled.push(resource);
		byRoot.set(root, entry);
	}
	const roots = [...byRoot.entries()];
	if (roots.length > 1) {
		const shown = roots.map(([root, entry]) => `${entry.source} v${entry.version} at ${root}`).join(", ");
		return { conflict: `multiple ${SUBAGENTS_PACKAGE_NAME} copies are enabled (${shown}); remove every copy but the pinned v${pin} one.` };
	}
	const only = roots[0];
	if (only === undefined) return {}; // none enabled (absent, or disabled by the operator) → bundled fallback
	const [root, entry] = only;
	if (entry.version !== pin) {
		return { conflict: `${SUBAGENTS_PACKAGE_NAME} ${entry.version} at ${root} (${entry.source}) does not match LeanPi's pinned v${pin}; install v${pin} or remove the configured copy.` };
	}
	const declared = (readManifest(root)?.pi?.extensions ?? []).map((relative) => resolve(root, relative));
	const chosen = entry.enabled.find((resource) => declared.includes(resolve(resource.path))) ?? entry.enabled[0];
	if (entry.enabled.length > 1 && chosen !== undefined && declared.length <= 1) {
		return { conflict: `${SUBAGENTS_PACKAGE_NAME} at ${root} exposes ${entry.enabled.length} enabled extension entries (${entry.enabled.map((resource) => resource.path).join(", ")}); LeanPi loads exactly one.` };
	}
	if (chosen === undefined) return {};
	return { selection: { entry: chosen.path, source: entry.source, origin: "configured", version: entry.version, limit: 0 } };
}

/** The pinned copy LeanPi ships as a dependency, verified against the reviewed version. */
function bundledEntry(pin: string): { entry: string; source: string } {
	let path: string;
	try {
		path = createRequire(import.meta.url).resolve(SUBAGENTS_PACKAGE_NAME);
	} catch (error) {
		throw new Error(`LeanPi's pinned ${SUBAGENTS_PACKAGE_NAME} dependency is not installed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const manifest = readManifest(dirname(path));
	if (manifest?.name !== SUBAGENTS_PACKAGE_NAME) throw new Error(`${path} is not the ${SUBAGENTS_PACKAGE_NAME} package`);
	if (manifest.version !== pin) throw new Error(`installed ${SUBAGENTS_PACKAGE_NAME} is v${manifest.version}, LeanPi pins v${pin}; reinstall dependencies`);
	return { entry: path, source: `bundled dependency v${pin}` };
}

/**
 * Select the one upstream resource path Pi's native loader will attach.
 *
 * Fails closed before anything loads: a malformed operator config, a different
 * pinned version, more than one enabled copy, or a configured-but-missing source
 * all throw actionable errors instead of a silent second registration. No user
 * settings or environment are written and no missing source is installed.
 */
export async function prepareSubagents(options: PrepareSubagentsOptions): Promise<SubagentSelection> {
	const pin = reviewedSubagentsVersion();
	// Before any upstream factory can capture its config. Upstream now loads as a
	// path extension, which Pi runs before LeanPi's inline factory, so this cannot
	// move to `subagentsFactory`.
	const outcome = ensureDefaultConfig(getAgentDir());
	if (outcome.status === "invalid") {
		throw new Error(`pi-subagents config at ${outcome.path} is ${outcome.problem}; refusing to load pi-subagents. Fix or remove that file.`);
	}
	if (options.rejectConfiguredProjectCopy === true) {
		const projectCopy = configuredProjectSubagentCopy(options.cwd, pin);
		if (projectCopy !== undefined) throw new Error(projectCopy);
	}
	const manager = new DefaultPackageManager({ cwd: options.cwd, agentDir: options.agentDir, settingsManager: options.settingsManager });
	const missing = missingConfiguredSubagentSource(manager, options.settingsManager, options.agentDir, pin);
	if (missing !== undefined) throw new Error(missing);
	// `resolve()` without a callback installs missing sources like Pi's own loader.
	// Preflight must not: skip every other source, and route a configured upstream
	// to the actionable rejection above rather than an install.
	const resolved = await manager.resolve(async (source) => {
		if (identifiesSubagents(source)) throw new Error(`${SUBAGENTS_PACKAGE_NAME} is configured at ${source} but not installed; install v${pin} or remove that source, LeanPi will not install it during preflight.`);
		return "skip";
	});
	const configured = resolveConfiguredEntry(resolved.extensions, pin);
	if (configured.conflict !== undefined) throw new Error(configured.conflict);
	if (configured.selection !== undefined) return { ...configured.selection, limit: outcome.limit };
	const bundled = bundledEntry(pin);
	return { entry: bundled.entry, source: bundled.source, origin: "bundled", version: pin, limit: outcome.limit };
}

/**
 * The CLI's global-only preflight. The interactive child re-runs Pi's own trust
 * bootstrap, so this manager deliberately loads no project settings or packages;
 * a project `pi-subagents` is reported, not trusted. The selected path is passed
 * to Pi's `--extension`, whose canonical-path merge dedupes it against the global
 * copy Pi also discovers.
 */
export async function prepareCliSubagents(cwd: string = process.cwd()): Promise<SubagentSelection> {
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	return prepareSubagents({ cwd, agentDir, settingsManager, rejectConfiguredProjectCopy: true });
}
