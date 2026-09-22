/**
 * The pi-subagents integration (PRD-041).
 *
 * LeanPi attaches the pinned `pi-subagents` package and owns two things it does
 * not: the operator's per-run child concurrency limit, and a shipped default
 * that works with LeanPi's registered-only native models.
 *
 * The config path is upstream's own: the public SDK `getAgentDir()` (which the
 * package also calls) plus `extensions/subagent/config.json`. LeanPi writes only
 * the keys it owns and preserves every other key, because the file is shared
 * with upstream's other settings. A file it cannot safely rewrite is left
 * untouched and upstream is not registered at all, so a session never runs with
 * a silently clamped cap.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerSubagentExtension from "pi-subagents";

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
 * The one attach path. Writes the defaults before upstream captures its config,
 * installs the clamp for this session's max, then registers the package once. A
 * config LeanPi cannot safely extend aborts registration — never a silent clamp
 * against a file it does not understand.
 *
 * Returns the captured `{path, limit}` for the session, or `undefined` when the
 * config was invalid and registration was aborted. The SDK and CLI entries that
 * also own a command surface hand this to `registerSubagentsLimitCommand`; a
 * bare extension entry (no command surface) ignores the return.
 */
export function subagentsFactory(pi: ExtensionAPI): CapturedLimit | undefined {
	const agentDir = getAgentDir();
	const outcome = ensureDefaultConfig(agentDir);
	if (outcome.status === "invalid") return undefined;
	clampSubagentOverride(pi, outcome.limit);
	registerSubagentExtension(pi);
	return { path: subagentConfigPath(agentDir), limit: outcome.limit };
}
