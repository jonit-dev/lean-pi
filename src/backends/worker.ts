/**
 * The worker contract both backend kinds speak (PRD-008, ROADMAP §23).
 *
 * A native backend (LeanPi owns the Pi agent loop) and an external harness
 * worker (Claude Code / Codex / OpenCode own the loop) return the *identical*
 * `WorkerResult` shape, so PRD-007's executor never branches on `type`. The
 * packet is bounded by construction: objective, allowed tools, budget and an
 * optional output schema — no routing metadata, no transcript.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ModelRole } from "../core/types.js";

/** FR-055: the three billing classes a backend can carry. */
export type Billing = "subscription" | "metered" | "local";

/** The bounded job LeanPi hands to one backend worker. */
export interface WorkerTaskPacket {
	/** What the worker must accomplish; the worker prompt when `prompt` is absent. */
	objective: string;
	/** The resolved role whose backend chain the worker runs on. */
	role: ModelRole;
	/** Assembled prompt text when the caller sends more than the objective. */
	prompt?: string;
	/** Workspace files the packet asks for — the only paths `changedFiles` reports. */
	files?: string[];
	/** LeanPi tool names the worker is allowed to use (§44's vocabulary). */
	allowedTools?: string[];
	/** Hard stopping condition for the Pi agent loop, in model turns. */
	budget?: number;
	/** JSON Schema the structured result must satisfy; passed to vendors that support it. */
	outputSchema?: Record<string, unknown>;
	/** Model id for harness model selection (`opencode run --model`). */
	model?: string;
	/** Reasoning effort the compiler decided for this turn (ROADMAP §12). */
	effort?: "low" | "medium" | "high";
	/** Harness agent selection (`opencode run --agent`). */
	agent?: string;
	/** Vendor session to continue instead of starting a fresh one. */
	sessionId?: string;
}

/** The single result shape both `runNative` and `runHarness` return. */
export interface WorkerResult {
	status: "ok" | "blocked";
	/** Files from `packet.files` whose content actually changed. */
	changedFiles: string[];
	summary: string;
	sessionId?: string;
	raw?: unknown;
}

/** Why a worker invocation failed; every kind is a fallback trigger (FR-046). */
export type WorkerFailureKind =
	| "exit"
	| "parse"
	| "spawn"
	| "limit"
	| "schema"
	| "provider"
	| "model"
	| "timeout"
	| "no_change"
	| "blocked";

/** A typed worker failure — never a throw that unwinds the turn. */
export interface WorkerFailure {
	status: "failed";
	failure: WorkerFailureKind;
	reason: string;
	/** `null` when the process died from a signal rather than exiting. */
	exitCode?: number | null;
	sessionId?: string;
	tokens?: number;
	/**
	 * The token breakdown the attempt managed to report before it failed. A failed
	 * attempt has still spent money, and it is the failed ones retry economics
	 * most needs priced correctly: without the breakdown the whole total lands in
	 * the uncached-input bucket and is mispriced.
	 */
	usage?: InvocationUsage;
}

export type WorkerOutcome = WorkerResult | WorkerFailure;

export function isWorkerFailure(outcome: WorkerOutcome): outcome is WorkerFailure {
	return outcome.status === "failed";
}

/**
 * One emitted fact per worker invocation — success or failure (the cost hook
 * PRD-015 records and PRD-020 prices). Shadow pricing is deliberately absent.
 */
export interface BackendInvocation {
	backend: string;
	/** The concrete model the call ran on, when the backend resolved one. */
	model?: string;
	billing: Billing;
	quotaClass?: string;
	catalogModelId?: string;
	role: ModelRole;
	wallMs: number;
	exitCode: number | null;
	tokens?: number;
	/** The token breakdown, when the backend can report one (PRD-015's pricing reads it). */
	usage?: InvocationUsage;
}

/**
 * Tokens one backend call consumed, as the backend counted them. The coarse
 * `BackendInvocation.tokens` stays for the billing rollup; a backend that knows
 * the breakdown reports it here so the run's cost is priced per bucket.
 */
export interface InvocationUsage {
	inputTokens?: number;
	cachedInputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
}

/** Per-billing rollup; PRD-015's totals and AC-2's separation read this. */
export interface BillingTotals {
	invocations: number;
	wallMs: number;
	tokens: number;
}

export function billingTotals(records: readonly BackendInvocation[]): Record<Billing, BillingTotals> {
	const totals: Record<Billing, BillingTotals> = {
		subscription: { invocations: 0, wallMs: 0, tokens: 0 },
		metered: { invocations: 0, wallMs: 0, tokens: 0 },
		local: { invocations: 0, wallMs: 0, tokens: 0 },
	};
	for (const record of records) {
		const total = totals[record.billing];
		total.invocations += 1;
		total.wallMs += record.wallMs;
		total.tokens += record.tokens ?? 0;
	}
	return totals;
}

/** A failed backend inside a chain, kept so a blocked turn reports every reason. */
export interface WorkerAttempt {
	backend: string;
	failure: WorkerFailureKind;
	reason: string;
}

export interface WorkerTurnOutcome {
	status: "completed" | "blocked";
	/** The backend that produced the result; absent when the chain is exhausted. */
	backend?: string;
	result?: WorkerResult;
	/** One row per failed backend, in attempt order. */
	attempts: WorkerAttempt[];
}

/**
 * Content snapshot of the packet's declared files, taken before and after a run.
 * A worker reports "workspace change" only for a file whose bytes actually moved,
 * so a vendor envelope claiming success cannot pass on its own word.
 */
export type FileSnapshot = Record<string, string | null>;

export function snapshotFiles(cwd: string, files: readonly string[]): FileSnapshot {
	const snapshot: FileSnapshot = {};
	for (const file of files) {
		const path = isAbsolute(file) ? file : join(cwd, file);
		snapshot[file] = existsSync(path) ? readFileSync(path, "utf8") : null;
	}
	return snapshot;
}

export function changedFilesSince(before: FileSnapshot, cwd: string, files: readonly string[]): string[] {
	const after = snapshotFiles(cwd, files);
	return files.filter((file) => before[file] !== after[file]);
}

/** The model id a backend runs for a role: the role map first, then the entry. */
export interface RoleModelSource {
	model: string | null;
	modelsByRole: Partial<Record<ModelRole, string>>;
}

export function modelFor(backend: RoleModelSource, role: ModelRole): string | null {
	return backend.modelsByRole[role] ?? backend.model;
}

/** An envelope's payload is sometimes a JSON string in a text field; never throw on it. */
export function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== "string") return undefined;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return undefined;
	}
}
