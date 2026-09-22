/**
 * Recovery: one concrete action per gathering round, then the §41 ladder
 * (PRD-010 Phase 2, FR-126/FR-127).
 *
 * `recover` dispatches through `actions.ts` and nothing else, so the only paths
 * out of a proof gap are a registered PRD-009 verifier, PRD-011's reviewer lane,
 * or an owner/context lane this module cannot run — never a synthesized record.
 * The single writer of PRD-009's `records` channel is
 * `EvidenceStore.record` called with a result a verifier actually produced.
 *
 * The ladder calls the reviewer lane once per rung with the matching
 * `ReviewLevel`; it never touches the evidence store, which is what makes "the
 * store gains no entry across the ladder" a structural property rather than a
 * promise.
 */
import type { ArtifactStore } from "../context/artifacts.js";
import {
	captureArtifact,
	DEFAULT_SCOPES,
	quoteScope,
	resolveCommand,
	verifierFor,
	verifierOutcome,
	type ScopeSpec,
	type VerifierContext,
	type VerifierDescriptor,
} from "../verify/descriptors.js";
import type { EvidenceRecord, EvidenceStatus, EvidenceStore, VerifierResult } from "../verify/evidence.js";
import type { ShellExec } from "../verify/run.js";
import type { BrowserFacility } from "../runtime/browser.js";
import type { RuntimePlan } from "../runtime/plan.js";
import type { ProofAction, ProofActionExecutor } from "./actions.js";
import type { ProofCriterion } from "./packet.js";
import type { ProofGapCategory } from "./questions.js";

const DEFAULT_TIMEOUT_MS = 120_000;

/** The two rungs of §41's ladder. PRD-011's lane also accepts `NO_SEMANTIC_REVIEW`; the ladder never calls it. */
export type ProofReviewLevel = "QUICK_REVIEW" | "STRONG_REVIEW";

const LADDER_LEVELS: readonly ProofReviewLevel[] = ["QUICK_REVIEW", "STRONG_REVIEW"];

export interface ProofReviewFinding {
	criterion?: string;
	severity?: string;
}

/**
 * PRD-011's verdict, read structurally. Its lane returns the status inside
 * `verdict` (`{ verdict: { decision, findings } }`); a caller that flattens the
 * shape may set `decision` directly. Both are accepted, and an unreadable
 * verdict resolves to `ESCALATE` — never to `PASS`.
 */
export interface ProofReviewVerdict {
	decision?: string;
	verdict?: { decision?: string; findings?: ReadonlyArray<ProofReviewFinding> };
	level?: string;
	independence?: string;
	findings?: ReadonlyArray<ProofReviewFinding>;
	reason?: string;
}

/** The single status field, whichever shape the lane handed back. */
export function reviewDecision(verdict: ProofReviewVerdict): string {
	const decision = verdict.verdict?.decision ?? verdict.decision;
	return typeof decision === "string" && decision.length > 0 ? decision : "ESCALATE";
}

/**
 * PRD-011's reviewer lane, injected rather than imported: the lane needs the
 * turn's backend pool and the §30 review packet its own builder produces from
 * the diff and artifact store, none of which belong to the proof gate. The
 * caller binds `run` to `review(packet, level, 'gate', deps)`.
 */
export interface ProofReview<R = unknown> {
	/** The §30 packet PRD-011's `buildPacket` built; this module never reads it. */
	packet: R;
	run(packet: R, level: ProofReviewLevel, mode: "gate"): Promise<ProofReviewVerdict>;
}

export type ProofAttempt =
	| {
			kind: "gather";
			/** 1-based gathering round; never exceeds the contract's `limits.semantic_review_rounds`. */
			round: number;
			criterion: string;
			category: ProofGapCategory;
			executor: ProofActionExecutor;
			target: string | null;
			/** The command the verifier actually ran; empty when nothing was launched. */
			command: string;
			status: EvidenceStatus | null;
			produced: boolean;
	  }
	| {
			kind: "review";
			level: ProofReviewLevel;
			criterion: string | null;
			decision: string;
			independence?: string;
			reason?: string;
	  };

export interface RecoverDeps {
	/** PRD-009's store: the record a recovery run produces lands here and nowhere else. */
	store?: EvidenceStore;
	/** The workspace hash the new record is stamped with. */
	workspaceHash: string;
	cwd?: string;
	commands?: Partial<Record<string, string>>;
	timeoutMs?: number;
	exec?: ShellExec;
	artifacts?: ArtifactStore;
	/** PRD-022's runtime plan for this recovery, so a gathered runtime verifier reads the contract's declarations. */
	runtime?: RuntimePlan;
	/** The host's browser adapter, threaded to a gathered browser/screenshot verifier. */
	browserFacility?: BrowserFacility | null;
	review?: ProofReview;
	/** Lets the caller mirror each ladder verdict into `TaskState.review`. */
	onReviewVerdict?: (verdict: ProofReviewVerdict) => void;
}

export interface RecoverRequest {
	criterion: ProofCriterion;
	category: ProofGapCategory;
	action: ProofAction;
	/** The 1-based gathering round this action runs in, for the attempt ledger. */
	round: number;
}

export interface RecoverOutcome {
	/** `evidence`: a record was produced. `blocked`: no further action is available. */
	status: "evidence" | "blocked";
	reason: string;
	attempts: ProofAttempt[];
	verdicts: ProofReviewVerdict[];
	record: EvidenceRecord | null;
}

function blocked(reason: string, attempts: ProofAttempt[] = []): RecoverOutcome {
	return { status: "blocked", reason, attempts, verdicts: [], record: null };
}

/** Runs the mapped verifier for one criterion and lets PRD-009 store its result. */
async function runVerifierRound(request: RecoverRequest, deps: RecoverDeps): Promise<RecoverOutcome> {
	const kind = request.action.target;
	if (kind === null) return blocked(`${request.category} names no verifier kind to run`);
	if (!deps.store) {
		return blocked(`no evidence store is attached: a ${kind} run would produce a record nothing could read`);
	}

	// The criterion's scope is raw data (a declared pattern, or the compiler's
	// literal path list); quoting happens once inside `resolveCommand`, so this
	// path cannot disagree with selection.
	const scope: ScopeSpec = request.criterion.scope ?? DEFAULT_SCOPES[kind] ?? "";
	// Attribution is stamped here rather than by `selectVerifiers`: the whole point
	// of this round is a record for the criterion whose coverage was short.
	const descriptor: VerifierDescriptor = {
		kind,
		command: resolveCommand(kind, scope, deps.commands ?? {}),
		mandatory: true,
		criterion: [request.criterion.id],
		scope: quoteScope(scope),
	};
	const context: VerifierContext = {
		cwd: deps.cwd ?? process.cwd(),
		timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		...(deps.runtime ? { runtime: deps.runtime } : {}),
		...(deps.browserFacility !== undefined ? { browserFacility: deps.browserFacility } : {}),
		...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
		...(deps.exec ? { exec: deps.exec } : {}),
	};

	// PRD-022 registers `runtime_smoke` and `browser_test`; until a kind has a
	// runner the attempt still happens and is recorded as `not_run`, so a missing
	// facility reads as a gap instead of as a pass.
	const runner = verifierFor(kind);
	let result: VerifierResult;
	try {
		result = runner
			? await runner.run(descriptor, context)
			: verifierOutcome(descriptor, "not_run", {
					reason: `no verifier registered for kind "${kind}"`,
					artifactRef: captureArtifact(deps.artifacts, kind, `no verifier registered for kind "${kind}"`),
				});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		result = verifierOutcome(descriptor, "error", {
			reason,
			artifactRef: captureArtifact(deps.artifacts, kind, `$ ${descriptor.command}\n${reason}`),
		});
	}

	const record = deps.store.record(result, deps.workspaceHash);
	return {
		status: "evidence",
		reason: `${kind} recorded ${record.status} for ${request.criterion.id}`,
		attempts: [
			{
				kind: "gather",
				round: request.round,
				criterion: request.criterion.id,
				category: request.category,
				executor: request.action.executor,
				target: request.action.target,
				command: descriptor.command,
				status: record.status,
				produced: true,
			},
		],
		verdicts: [],
		record,
	};
}

/** The last rung this ladder walked, narrowed so the caller can read its level and decision. */
export function lastReviewAttempt(attempts: readonly ProofAttempt[]): Extract<ProofAttempt, { kind: "review" }> | undefined {
	let last: Extract<ProofAttempt, { kind: "review" }> | undefined;
	for (const attempt of attempts) {
		if (attempt.kind === "review") last = attempt;
	}
	return last;
}

/**
 * §41's ladder: `QUICK_REVIEW` then `STRONG_REVIEW`, once each, stopping when a
 * rung passes — a passing review needs no stronger rung. A lane that throws is
 * recorded as `ESCALATE` rather than ending the turn.
 */
export async function escalateLadder(
	criteria: readonly string[],
	deps: RecoverDeps,
): Promise<{ attempts: ProofAttempt[]; verdicts: ProofReviewVerdict[]; reason: string }> {
	const attempts: ProofAttempt[] = [];
	const verdicts: ProofReviewVerdict[] = [];
	const criterion = criteria.length > 0 ? criteria.join(", ") : null;
	if (!deps.review) {
		return { attempts, verdicts, reason: "no reviewer lane is wired: the §41 ladder cannot run" };
	}

	for (const level of LADDER_LEVELS) {
		let verdict: ProofReviewVerdict;
		try {
			verdict = await deps.review.run(deps.review.packet, level, "gate");
		} catch (error) {
			verdict = { decision: "ESCALATE", reason: `the reviewer lane threw: ${error instanceof Error ? error.message : String(error)}` };
		}
		const decision = reviewDecision(verdict);
		verdicts.push(verdict);
		deps.onReviewVerdict?.(verdict);
		attempts.push({
			kind: "review",
			level,
			criterion,
			decision,
			...(verdict.independence ? { independence: verdict.independence } : {}),
			...(verdict.reason ? { reason: verdict.reason } : {}),
		});
		if (decision === "PASS") break;
	}

	const last = lastReviewAttempt(attempts);
	return {
		attempts,
		verdicts,
		reason: `${criterion ?? "the task"} stays unproved: the ladder ended at ${last?.level ?? "no rung"} with ${last?.decision ?? "no verdict"}`,
	};
}

/**
 * One recovery round. Returns `evidence` when a verifier ran and PRD-009 stored
 * its record (the caller re-enters the gate with the updated packet), and
 * `blocked` with the reason when the selected action has no executor here.
 */
export async function recover(request: RecoverRequest, deps: RecoverDeps): Promise<RecoverOutcome> {
	const { action, category } = request;
	if (action.unavailableReason) return blocked(action.unavailableReason);
	switch (action.executor) {
		case "verifier":
			return runVerifierRound(request, deps);
		case "review": {
			const ladder = await escalateLadder([request.criterion.id], deps);
			return { status: "blocked", reason: ladder.reason, attempts: ladder.attempts, verdicts: ladder.verdicts, record: null };
		}
		case "owner":
			return blocked(`${action.detail}: ${category} is an owner decision, so the gate asks rather than acts`);
		case "context":
			return blocked(`${action.detail}: ${category} needs PRD-014's retrieval, which the gate does not run`);
		case "none":
			return blocked(`${category} names no action, so the gap stays open`);
	}
}
