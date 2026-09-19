/**
 * The structured working state (PRD-014 Phase 2, ROADMAP §20).
 *
 * Assembled from injected sources and session facts only — never from the chat
 * transcript — so clearing history does not change it. The `WorkingStateSources`
 * seam is owned here and implemented by PRD-009 (evidence + `workspaceHash`),
 * PRD-013 (goal state) and PRD-007 (attempt counter), which keeps the dependency
 * one-way while this module is buildable and testable on stub sources.
 */
import { stringify as stringifyYaml } from "yaml";

export interface WorkingState {
	goal: string;
	acceptance: string[];
	files_touched: string[];
	current_failure: string | null;
	verification: Record<string, string>;
	attempts: number;
	unresolved: string[];
}

export interface WorkingStateSources {
	goal(): string;
	acceptance(): string[];
	filesTouched(): string[];
	failingEvidence(): { summary: string; workspaceHash?: string } | null;
	verificationByKind(): Record<string, string>;
	attempts(): number;
	unresolved(): string[];
}

export interface WorkingStateSession {
	/** Workspace diff, relative paths, already sorted by the caller. */
	filesTouched?: string[];
}

export const WORKING_STATE_MAX_BYTES = 3000;

function truncate(values: string[], keep: number, label: string): string[] {
	if (values.length <= keep) return values;
	return [...values.slice(0, keep), `+${values.length - keep} more ${label}`];
}

/**
 * Build the record from its sources, then enforce the ceiling by truncating the
 * unbounded lists with an explicit marker — a named field is never dropped.
 */
export function buildWorkingState(
	sources: WorkingStateSources,
	session: WorkingStateSession = {},
	maxBytes: number = WORKING_STATE_MAX_BYTES,
): WorkingState {
	const failing = sources.failingEvidence();
	const state: WorkingState = {
		goal: sources.goal(),
		acceptance: [...sources.acceptance()],
		files_touched: [...(session.filesTouched ?? sources.filesTouched())],
		current_failure: failing ? failing.summary : null,
		verification: { ...sources.verificationByKind() },
		attempts: sources.attempts(),
		unresolved: [...sources.unresolved()],
	};

	let budget = 24;
	while (Buffer.byteLength(serializeWorkingState(state), "utf8") > maxBytes && budget > 2) {
		state.files_touched = truncate(sources.filesTouched(), budget, "files");
		state.unresolved = truncate(sources.unresolved(), budget, "unresolved");
		if (Buffer.byteLength(state.goal, "utf8") > 600) state.goal = state.goal.slice(0, 600);
		budget = Math.floor(budget / 2);
	}
	return state;
}

/** YAML with a fixed key order, so the same state always serializes to the same bytes. */
export function serializeWorkingState(state: WorkingState): string {
	return stringifyYaml(
		{
			goal: state.goal,
			acceptance: state.acceptance,
			files_touched: state.files_touched,
			current_failure: state.current_failure,
			verification: Object.fromEntries(Object.entries(state.verification).sort(([left], [right]) => left.localeCompare(right))),
			attempts: state.attempts,
			unresolved: state.unresolved,
		},
		{ lineWidth: 0 },
	);
}

/** Stub sources for a session with no PRD-009/013/007 implementations yet. */
export function stubSources(overrides: Partial<WorkingStateSources> = {}): WorkingStateSources {
	return {
		goal: () => "",
		acceptance: () => [],
		filesTouched: () => [],
		failingEvidence: () => null,
		verificationByKind: () => ({}),
		attempts: () => 0,
		unresolved: () => [],
		...overrides,
	};
}
