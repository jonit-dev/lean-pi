/**
 * The exploration budget (PRD-023 Phase 1, ROADMAP §6.3).
 *
 * `ExploreBudget` is the negative control against a governor that merely asks
 * nicely: the gate runs *after* every JEV answer, it can only reduce a
 * selection, and an exhausted dimension terminates the loop — the semantic
 * answer never gets to extend it. A round that does not fit is not run at all.
 *
 * The settings below are read structurally out of `LeanPiConfig`, the way
 * PRD-019 reads `rtk:`: the module declares its own keys and defaults, a config
 * with no `exploration:` block behaves exactly like the defaults, and no key is
 * added to the shared config type.
 */
import type { LeanPiConfig } from "../core/types.js";
import { DEFAULT_IGNORE_GLOBS } from "./gather.js";

export interface ExploreBudget {
	/** Rounds the loop may start. */
	maxRounds: number;
	/** Files that may enter context. */
	maxFilesRead: number;
	/** Bytes that may enter context. */
	maxBytesIntoContext: number;
}

export interface ExplorationSettings extends ExploreBudget {
	/** Candidates one round may produce — the bound that keeps a greedy match pattern finite. */
	maxCandidates: number;
	/** Matched lines kept per file, so one pathological file cannot dominate a round. */
	maxMatchesPerFile: number;
	/** Test files one round may discover. */
	maxTests: number;
	/** Inline bytes per file's snippet; the rest is stored and referenced, never inlined. */
	snippetBytesPerFile: number;
	/** Rank score at or above which a snippet's file qualifies it for context. */
	snippetScoreThreshold: number;
	/** Directory segments never walked. */
	ignore: readonly string[];
	/** Repository defaults; the scout packet's `test_runners` own the per-runner globs. */
	testGlobs: readonly string[];
}

/** Repository defaults: three rounds, five files, 24 KB of context — a bounded exploration. */
export const EXPLORATION_DEFAULTS: ExplorationSettings = {
	maxRounds: 3,
	maxFilesRead: 5,
	maxBytesIntoContext: 24_000,
	maxCandidates: 64,
	maxMatchesPerFile: 24,
	maxTests: 32,
	snippetBytesPerFile: 4_000,
	snippetScoreThreshold: 0.5,
	ignore: DEFAULT_IGNORE_GLOBS,
	testGlobs: ["**/*.test.ts", "**/*.spec.ts", "**/*.test.js", "**/*.spec.js", "**/test_*.py", "**/*_test.go"],
};

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function ratio(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function stringList(value: unknown, fallback: readonly string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return entries.length > 0 ? entries : [...fallback];
}

/** Read the `exploration:` surface out of a loaded config; a malformed field keeps its default. */
export function explorationSettingsOf(
	config?: LeanPiConfig | null,
	overrides: Partial<ExplorationSettings> = {},
): ExplorationSettings {
	const raw = ((config as { exploration?: Record<string, unknown> } | null | undefined)?.exploration ?? {}) as Record<string, unknown>;
	return {
		maxRounds: positiveInteger(raw.maxRounds, EXPLORATION_DEFAULTS.maxRounds),
		maxFilesRead: positiveInteger(raw.maxFilesRead, EXPLORATION_DEFAULTS.maxFilesRead),
		maxBytesIntoContext: positiveInteger(raw.maxBytesIntoContext, EXPLORATION_DEFAULTS.maxBytesIntoContext),
		maxCandidates: positiveInteger(raw.maxCandidates, EXPLORATION_DEFAULTS.maxCandidates),
		maxMatchesPerFile: positiveInteger(raw.maxMatchesPerFile, EXPLORATION_DEFAULTS.maxMatchesPerFile),
		maxTests: positiveInteger(raw.maxTests, EXPLORATION_DEFAULTS.maxTests),
		snippetBytesPerFile: positiveInteger(raw.snippetBytesPerFile, EXPLORATION_DEFAULTS.snippetBytesPerFile),
		snippetScoreThreshold: ratio(raw.snippetScoreThreshold, EXPLORATION_DEFAULTS.snippetScoreThreshold),
		ignore: stringList(raw.ignore, EXPLORATION_DEFAULTS.ignore),
		testGlobs: stringList(raw.testGlobs, EXPLORATION_DEFAULTS.testGlobs),
		...overrides,
	};
}

/** Accounting for one exploration: the only thing that decides what fits. */
export class BudgetLedger {
	readonly budget: ExploreBudget;
	private roundsUsed = 0;
	private filesUsed = 0;
	private bytesUsed = 0;

	constructor(budget: ExploreBudget) {
		this.budget = budget;
	}

	startRound(): number {
		this.roundsUsed += 1;
		return this.roundsUsed;
	}

	get rounds(): number {
		return this.roundsUsed;
	}

	get filesRead(): number {
		return this.filesUsed;
	}

	get bytes(): number {
		return this.bytesUsed;
	}

	roundsRemaining(): number {
		return Math.max(this.budget.maxRounds - this.roundsUsed, 0);
	}

	remainingFiles(): number {
		return Math.max(this.budget.maxFilesRead - this.filesUsed, 0);
	}

	remainingBytes(): number {
		return Math.max(this.budget.maxBytesIntoContext - this.bytesUsed, 0);
	}

	exhausted(): boolean {
		return this.roundsRemaining() === 0 || this.remainingFiles() === 0 || this.remainingBytes() === 0;
	}

	/** Charge one file that entered context; callers gate first, so this never overruns. */
	chargeFile(bytes: number): void {
		this.filesUsed += 1;
		this.bytesUsed += Math.max(bytes, 0);
	}

	/** Charge context bytes that are not a file's own entry, e.g. an inlined snippet. */
	chargeBytes(bytes: number): void {
		this.bytesUsed += Math.max(bytes, 0);
	}
}

/**
 * The gate: the longest prefix of a ranked selection that fits the remaining
 * budget, never longer than the input. Applied after every ranking answer, so a
 * JEV answer that promotes fifty candidates still reaches context as a prefix.
 */
export function gateSelection<T extends { contextBytes: number }>(entries: readonly T[], ledger: BudgetLedger): T[] {
	const gated: T[] = [];
	let bytes = 0;
	for (const entry of entries) {
		if (gated.length >= ledger.remainingFiles()) break;
		if (bytes + entry.contextBytes > ledger.remainingBytes()) break;
		bytes += entry.contextBytes;
		gated.push(entry);
	}
	return gated;
}
