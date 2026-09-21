/**
 * The persisted goal record (PRD-013 Phase 1, ROADMAP §42, FR-131).
 *
 * ROADMAP §42's five fields plus the turn counter the limit check needs, and
 * nothing else: persistence across turns and resumes is a serialization
 * concern, so the record round-trips through one JSON file under the project's
 * existing `.leanpi/` directory — no new store, no schema, no migration logic
 * for a format that has never shipped.
 *
 * `--max-turns` / `--max-cost` are optional flags over optional limits: an
 * absent flag takes `goal.default_max_turns` / `goal.default_max_cost`, and
 * with neither the goal runs uncapped. A cap the user did not ask for stopped
 * real work mid-task, so the bound is opt-in — `0` on either axis means "no
 * cap" everywhere it is read.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LeanPiConfig } from "../core/types.js";

/**
 * ROADMAP §42's record plus `turns_used`, and the session that set it.
 *
 * `session_id` is what stops a goal outliving the conversation that asked for
 * it. The record is a file on disk, so before this field an `active` goal from
 * last week was still injected into the working state of every later session —
 * a user who typed "hi" in a fresh conversation got a harness pursuing a goal
 * they had forgotten setting, with nothing on screen saying why. It is optional
 * because records written before this field exist; a record without one is read
 * as belonging to no live session, which is the safe reading.
 */
export interface GoalState {
	text: string;
	active: boolean;
	max_turns: number;
	max_cost: number;
	started_at: string;
	turns_used: number;
	session_id?: string;
}

export const GOAL_STATE_PATH_DEFAULT = ".leanpi/goal.json";

/** No cap unless asked for: `0` on either axis disables that limit. */
export const DEFAULT_MAX_TURNS = 0;
export const DEFAULT_MAX_COST = 0;

export const GOAL_USAGE = "usage: /goal <text> [--max-turns <n>] [--max-cost <usd>] | /goal | /goal stop";

export function goalStatePath(cwd: string): string {
	return join(cwd, GOAL_STATE_PATH_DEFAULT);
}

function positive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * The `goal:` config block, read structurally: PRD-001's loader passes unknown
 * keys through `overrides` untouched and this PRD owns the defaults rather than
 * the key declaration. An absent or unusable value means no cap on that axis.
 */
export function defaultGoalLimits(config?: LeanPiConfig): { max_turns: number; max_cost: number } {
	const goal = (config as { goal?: { default_max_turns?: unknown; default_max_cost?: unknown } } | undefined)?.goal;
	return {
		max_turns: positive(goal?.default_max_turns, DEFAULT_MAX_TURNS),
		max_cost: positive(goal?.default_max_cost, DEFAULT_MAX_COST),
	};
}

/** A stored file is a record only when all six fields are of the right type. */
function toGoalState(raw: unknown): GoalState | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	if (typeof record.text !== "string" || record.text.length === 0) return null;
	if (typeof record.active !== "boolean" || typeof record.started_at !== "string") return null;
	if (typeof record.max_turns !== "number" || typeof record.max_cost !== "number") return null;
	if (typeof record.turns_used !== "number") return null;
	return {
		text: record.text,
		active: record.active,
		max_turns: record.max_turns,
		max_cost: record.max_cost,
		started_at: record.started_at,
		turns_used: record.turns_used,
		...(typeof record.session_id === "string" ? { session_id: record.session_id } : {}),
	};
}

export interface GoalStore {
	load(): GoalState | null;
	save(state: GoalState): void;
	clear(): void;
}

/** The file-backed store. Reading degrades — a missing or unparsable file is "no goal". */
export function createGoalStore(cwd: string): GoalStore {
	const path = goalStatePath(cwd);
	return {
		load() {
			if (!existsSync(path)) return null;
			try {
				return toGoalState(JSON.parse(readFileSync(path, "utf8")) as unknown);
			} catch {
				return null;
			}
		},
		save(state) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`);
		},
		clear() {
			rmSync(path, { force: true });
		},
	};
}

export interface GoalArgs {
	/** The goal text with flags removed; empty for a bare `/goal` or `/goal stop`. */
	text: string;
	maxTurns: number | null;
	maxCost: number | null;
	stop: boolean;
	/** A non-null message when a flag was malformed; the command refuses rather than guessing. */
	error: string | null;
}

function flagValue(token: string, name: string): string | null | undefined {
	if (token === name) return null;
	return token.startsWith(`${name}=`) ? token.slice(name.length + 1) : undefined;
}

/**
 * `--max-turns 5` and `--max-turns=5` are both accepted; anything else is text.
 * A malformed number is an error, never a silent default: a goal whose bound was
 * meant to be 5 and silently became 2 is a goal that stops too early.
 */
export function parseGoalArgs(args: string): GoalArgs {
	const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
	const text: string[] = [];
	const parsed: GoalArgs = { text: "", maxTurns: null, maxCost: null, stop: false, error: null };

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		let name: string | null = null;
		let raw: string | undefined;
		for (const candidate of ["--max-turns", "--max-cost"]) {
			const inline = flagValue(token, candidate);
			if (inline === undefined) continue;
			name = candidate;
			raw = inline ?? tokens[index + 1];
			if (inline === null) index += 1;
			break;
		}
		if (name === null) {
			text.push(token);
			continue;
		}
		if (raw === undefined) {
			parsed.error = `${name} needs a value; ${GOAL_USAGE}`;
			return parsed;
		}
		const value = Number(raw);
		if (!Number.isFinite(value) || value <= 0) {
			parsed.error = `${name} must be a positive number, got "${raw}"; ${GOAL_USAGE}`;
			return parsed;
		}
		if (name === "--max-turns") parsed.maxTurns = value;
		else parsed.maxCost = value;
	}

	parsed.text = text.join(" ").trim();
	parsed.stop = parsed.text === "stop";
	return parsed;
}

export function newGoalState(
	text: string,
	limits: { max_turns: number; max_cost: number },
	startedAt: string,
	sessionId?: string,
): GoalState {
	return {
		text,
		active: true,
		max_turns: limits.max_turns,
		max_cost: limits.max_cost,
		started_at: startedAt,
		turns_used: 0,
		...(sessionId === undefined ? {} : { session_id: sessionId }),
	};
}

/**
 * Whether this record is the goal of the session asking. A goal set in another
 * session — or by a build that did not record one — is history, not an
 * instruction: it is shown when asked for and never injected into a turn.
 */
export function isRunningHere(state: GoalState | null, sessionId?: string): boolean {
	if (state === null || !state.active) return false;
	// Plain equality, `undefined` included: a caller with no session (a test, an
	// SDK embedding) matches a record with no session, while a real session never
	// matches a record written before this field existed — which is the stale
	// goal this check exists to keep out of the prompt.
	return state.session_id === sessionId;
}

/**
 * PRD-014's `WorkingStateSources.goal()` slot: the active goal's text, and an
 * empty string when no goal is running *in this session*. This is the one place
 * a goal reaches a prompt, so it is the one place the session check has to hold.
 */
export function goalTextSource(store: GoalStore, sessionId?: string): () => string {
	return () => {
		const state = store.load();
		return isRunningHere(state, sessionId) ? (state as GoalState).text : "";
	};
}
