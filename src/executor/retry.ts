/**
 * The bounded retry state machine (PRD-007 Phase 3, ROADMAP §33).
 *
 * Retry ceilings are enforced here, in code — never requested in a prompt. The
 * record is §33's own: `attempt`, `strategy`, `failureSignature`, `newEvidence`,
 * `model`. `nextAttempt` is the loop's only continuation condition, and it
 * returns `reject` the moment either budget is spent, whatever a model or a JEV
 * answer asks for.
 */
import { createHash } from "node:crypto";

export type AttemptStrategy = "same" | "reassess" | "escalate";

export interface FailureInput {
	/** The verifier kind that failed, or the worker failure kind when no verifier ran. */
	kind: string;
	/** The first failing diagnostic, unnormalized. */
	detail: string;
	/** Evidence gathered since the previous attempt that the signature alone cannot see. */
	newEvidence?: boolean;
}

export interface RetryRecord {
	attempt: number;
	strategy: AttemptStrategy;
	failureSignature: string | null;
	newEvidence: boolean;
	/** The role this attempt ran on. */
	model: string;
	backend: string;
}

export interface RetryBudget {
	attemptsUsed: number;
	executionAttempts: number;
	escalationsUsed: number;
	maxEscalations: number;
}

export type RetryDecision = "retry" | "reject" | "escalate";

// eslint-disable-next-line no-control-regex -- stripping ANSI escapes is exactly matching a control character
const ANSI = /\u001B\[[0-9;]*m/g;
const ABSOLUTE_PATH = /(?:[A-Za-z]:)?(?:\/[\w.@+-]+){2,}/g;
const LINE_COLUMN = /:\d+(?::\d+)?\b/g;
const DURATION = /\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|m|min)\b/gi;
const TEMP_DIR = /\b(?:tmp|temp)[\w./-]*\b/gi;
const HEX = /\b[0-9a-f]{7,}\b/gi;
const NUMBERS = /\b\d+\b/g;

/**
 * Normalize a diagnostic so a genuinely identical failure hashes identically
 * across attempts, while a different cause does not collide (FR-066).
 */
export function normalizeDiagnostic(detail: string): string {
	return detail
		.replace(ANSI, "")
		.replace(ABSOLUTE_PATH, "<path>")
		.replace(TEMP_DIR, "<tmp>")
		.replace(HEX, "<sha>")
		.replace(LINE_COLUMN, ":<line>")
		.replace(DURATION, "<time>")
		.replace(NUMBERS, "<n>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 400);
}

export function failureSignature(failure: FailureInput): string {
	return createHash("sha1").update(`${failure.kind}\u0000${normalizeDiagnostic(failure.detail)}`).digest("hex").slice(0, 16);
}

/**
 * The §33 policy table, as a plain switch. Budgets are checked first, always:
 * a decision can change *what* the next attempt runs, never *whether* the
 * ceiling holds.
 */
export function nextAttempt(history: readonly RetryRecord[], failure: FailureInput, budget: RetryBudget): RetryDecision {
	if (budget.attemptsUsed >= budget.executionAttempts) return "reject";
	const canEscalate = budget.escalationsUsed < budget.maxEscalations;

	const signature = failureSignature(failure);
	const failed = history.filter((record) => record.failureSignature !== null);
	const previous = failed[failed.length - 1];
	if (!previous) return "retry";

	if (previous.failureSignature === signature) {
		// Same failure. New evidence is the only thing that makes repeating the
		// same strategy worth an attempt; otherwise the escalation gate is the
		// honest next step, and a spent escalation budget means stop.
		if (failure.newEvidence) return "retry";
		return canEscalate ? "escalate" : "reject";
	}

	// A new failure reassesses the strategy; once two or more distinct strategies
	// have failed, §33 sends the turn to the gate instead.
	const exhausted = new Set(failed.map((record) => record.strategy));
	return exhausted.size >= 2 && canEscalate ? "escalate" : "retry";
}

/** Append one row; the lane owns the counter, so a caller can never grant an attempt. */
export function recordAttempt(
	history: RetryRecord[],
	entry: { strategy: AttemptStrategy; failure: FailureInput | null; newEvidence: boolean; model: string; backend: string },
): RetryRecord {
	const record: RetryRecord = {
		attempt: history.length + 1,
		strategy: entry.strategy,
		failureSignature: entry.failure ? failureSignature(entry.failure) : null,
		newEvidence: entry.newEvidence,
		model: entry.model,
		backend: entry.backend,
	};
	history.push(record);
	return record;
}

export function spendAttempt(budget: RetryBudget): RetryBudget {
	return { ...budget, attemptsUsed: budget.attemptsUsed + 1 };
}

export function spendEscalation(budget: RetryBudget): RetryBudget {
	return { ...budget, escalationsUsed: budget.escalationsUsed + 1 };
}

/** `quick → balanced → strong`, the FR-067 ladder. `strong` is the top. */
export const ROLE_LADDER = ["quick", "balanced", "strong"] as const;

export function stepRole(role: string): (typeof ROLE_LADDER)[number] {
	const index = ROLE_LADDER.indexOf(role as (typeof ROLE_LADDER)[number]);
	if (index === -1) return "balanced";
	return ROLE_LADDER[Math.min(index + 1, ROLE_LADDER.length - 1)]!;
}
