/**
 * The execution boundary (PRD-013 Phase 2, ROADMAP §42, FR-133–FR-136).
 *
 * ROADMAP §42's four steps, in this order, because the order is the whole point:
 *
 *   1. limits and the user's own stop, before anything can be spent;
 *   2. deterministic evidence refreshed, current-workspace only;
 *   3. machine clauses decided in code — zero model calls;
 *   4. one atomic JEV question per semantic clause that survives step 3.
 *
 * JEV is therefore reached only when no deterministic clause is outstanding: an
 * answer that could not change the continue/stop decision is exactly the
 * inference §6.4 forbids buying. `GOAL_MET` is reachable only from fresh
 * deterministic evidence plus PRD-010's decision table, never from an executor's
 * self-report, and the site's declared fallback is `insufficient_evidence` — a
 * disabled or unreachable JEV can never fabricate completion.
 */
import type { LeanPiConfig } from "../core/types.js";
import { accept } from "../jev/confidence.js";
import { ensureSite, type DecisionSite } from "../jev/registry.js";
import type { ChoiceAnswer, ChoiceQuestion, JevQuestion, JevResult, JevUsage } from "../jev/types.js";
import { VERIFIER_KINDS, verifierFor } from "../verify/descriptors.js";
import type { EvidenceRecord, EvidenceStore } from "../verify/evidence.js";
import type { ProofEvidenceView } from "../proof/packet.js";
import { splitClauses, type GoalClause } from "./clauses.js";
import { derivedCriterionClauses, resolveCriterionText, type PrdGoalSource } from "./from-prd.js";
import { checkBudget, costReader, type GoalStop } from "./limits.js";
import type { GoalState, GoalStore } from "./state.js";

export const GOAL_SEMANTIC_SITE_ID = "goal.semantic_completion";
export const GOAL_SEMANTIC_TELEMETRY_TAG = "goal/semantic_completion";
export const GOAL_SEMANTIC_QUESTION_ID = "goal.semantic_clause";
/** The one non-positive verdict: the clause is undecidable, never merely unsatisfied. */
export const GOAL_SEMANTIC_FALLBACK = "insufficient_evidence";

export function semanticQuestion(clause: GoalClause): ChoiceQuestion {
	return {
		id: GOAL_SEMANTIC_QUESTION_ID,
		kind: "Choice",
		text: `Given this evidence, is the goal clause "${clause.text}" satisfied?`,
		options: {
			yes: "the current evidence demonstrates the clause",
			no: "the current evidence does not demonstrate the clause yet",
			[GOAL_SEMANTIC_FALLBACK]: "the evidence cannot decide the clause",
		},
	};
}

/**
 * The site's declared question is a template: the ask carries one concrete
 * clause at a time, and the state carries the clause so a batch of one is still
 * attributable. The fallback is non-null and answers `insufficient_evidence` for
 * every question actually asked.
 */
export function registerGoalSites(): DecisionSite {
	return ensureSite({
		id: GOAL_SEMANTIC_SITE_ID,
		questions: [semanticQuestion({ id: "semantic:0", text: "<clause>", kind: "semantic", kinds: [], criterion: null })],
		returnType: ["Choice"],
		consequence: "normal",
		telemetryTag: GOAL_SEMANTIC_TELEMETRY_TAG,
		fallback: ({ questions }) =>
			questions
				.filter((question): question is ChoiceQuestion => question.kind === "Choice")
				.map(
					(question): JevResult => ({
						kind: "Choice",
						questionId: question.id,
						choice: GOAL_SEMANTIC_FALLBACK,
						probabilities: {},
						confidence: 1,
					}),
				),
	});
}

/** PRD-002's client as this module needs it: `ask`, the privacy mode, and the counters the real client exposes. */
export interface GoalJev {
	ask(siteId: string, questions: JevQuestion[], state: unknown): Promise<JevResult[]>;
	getMode?(): string;
	fallbackCount?(): number;
	lastUsage?(): JevUsage;
}

export interface RemainingWorkItem {
	id: string;
	text: string;
	blockedReason?: string;
}

/** PRD-025's `remainingWork()`: what is actionable, and what is blocked and why. */
export interface RemainingWork {
	actionable: readonly RemainingWorkItem[];
	blocked: readonly RemainingWorkItem[];
}

/** Structure, not an import: PRD-025 owns the list and this engine owns the verdict. */
export interface RemainingWorkSource {
	remainingWork(): RemainingWork;
}

export interface GoalBoundaryDeps {
	/** The hash the current workspace state is stamped with; a record from another state can never satisfy a clause. */
	workspaceHash: string;
	/** PRD-009's store. When supplied it is authoritative, exactly as in the proof gate. */
	evidence?: EvidenceStore;
	/** Records for a caller with no store; filtered by `workspaceHash` here. */
	records?: readonly EvidenceRecord[];
	config?: LeanPiConfig;
	/** The injected client. Absent, or a disabled mode, exercises the declared fallback. */
	jev?: GoalJev;
	/** PRD-015's accumulated run cost. Defaults to the project's run store; pricing is never computed here. */
	costSoFar?: () => number;
	cwd?: string;
	sessionId?: string;
	/** PRD-025's ordered list: the "useful work remains" input. */
	todos?: RemainingWorkSource;
	/** PRD-012's remaining criteria, re-read at every boundary. */
	prd?: PrdGoalSource | null;
	/** Where the turn counter and every stop are persisted. Absent leaves evaluation pure. */
	goals?: GoalStore;
	/** Verification kinds this workspace can produce. Defaults to the registered verifiers. */
	producibleKinds?: readonly string[];
	now?: () => Date;
}

export interface ClauseOutcome {
	clause: GoalClause;
	satisfied: boolean;
	/** The clause could not be decided at all — never a synonym for "unsatisfied". */
	undecidable: boolean;
	source: "evidence" | "proof_gate" | "jev" | "none";
	detail: string;
}

export interface GoalEvaluation {
	decision: "continue" | "stop";
	stop: GoalStop | null;
	reason: string;
	clauses: ClauseOutcome[];
	turns_used: number;
	/** The record as persisted by this boundary. */
	state: GoalState;
}

interface Resolution {
	outcome: ClauseOutcome;
	impossible: boolean;
}

function producibleKinds(deps: GoalBoundaryDeps): readonly string[] {
	return deps.producibleKinds ?? VERIFIER_KINDS.filter((kind) => verifierFor(kind) !== undefined);
}

/** Freshness is a read-time comparison, exactly as PRD-009 defines it. */
function evidenceView(deps: GoalBoundaryDeps): ProofEvidenceView {
	const hash = deps.workspaceHash;
	const stored = deps.evidence?.view(hash);
	const all = stored ? [...stored.records, ...stored.staleRecords] : [...(deps.records ?? [])];
	return {
		records: all.filter((record) => record.workspaceHash === hash),
		staleRecords: all.filter((record) => record.workspaceHash !== hash),
		assertions: [],
		workspaceHash: hash,
	};
}

function resolveMachineClause(
	clause: GoalClause,
	deps: GoalBoundaryDeps,
	view: ProofEvidenceView,
	derived: readonly GoalClause[] | null,
): Resolution {
	if (clause.criterion !== null) {
		const criterionId = clause.criterion;
		if (derived === null) {
			return {
				impossible: false,
				outcome: {
					clause,
					satisfied: false,
					undecidable: false,
					source: "none",
					detail: `no PRD state is wired to resolve ${criterionId}`,
				},
			};
		}
		const remaining = derived.find((entry) => entry.criterion === criterionId);
		if (remaining) {
			return {
				impossible: false,
				outcome: {
					clause,
					satisfied: false,
					undecidable: false,
					source: "proof_gate",
					detail: `${criterionId} is not VERIFIED in the active PRD (${remaining.text})`,
				},
			};
		}
		const proof = resolveCriterionText({ criterionId, text: clause.text }, view);
		return {
			impossible: false,
			outcome: {
				clause,
				satisfied: proof.satisfied,
				undecidable: false,
				source: "proof_gate",
				detail: proof.detail,
			},
		};
	}

	const producible = producibleKinds(deps);
	const unproducible = clause.kinds.filter((kind) => !producible.includes(kind));
	if (unproducible.length > 0) {
		return {
			impossible: true,
			outcome: {
				clause,
				satisfied: false,
				undecidable: false,
				source: "none",
				detail: `clause "${clause.text}" needs ${unproducible.join(", ")}, which this workspace cannot produce`,
			},
		};
	}
	const unmet = clause.kinds.filter(
		(kind) => !view.records.some((record) => record.kind === kind && record.status === "pass"),
	);
	return {
		impossible: false,
		outcome:
			unmet.length === 0
				? {
						clause,
						satisfied: true,
						undecidable: false,
						source: "evidence",
						detail: `fresh ${clause.kinds.join(", ")} evidence passes`,
					}
				: {
						clause,
						satisfied: false,
						undecidable: false,
						source: "evidence",
						detail: `no fresh passing ${unmet.join(", ")} evidence for "${clause.text}"`,
					},
	};
}

function jevUsable(deps: GoalBoundaryDeps): boolean {
	if (!deps.jev) return false;
	if (deps.config?.jev.mode === "disabled") return false;
	return deps.jev.getMode?.() !== "disabled";
}

/** What JEV is asked about: the clause, and a bounded digest of the evidence it must judge. */
function questionState(clause: GoalClause, view: ProofEvidenceView): Record<string, unknown> {
	return {
		clause: clause.text,
		clause_id: clause.id,
		goal_evidence: view.records.slice(-10).map((record) => `${record.kind}: ${record.status} (${record.scope})`),
		stale_evidence: view.staleRecords.slice(-5).map((record) => `${record.kind}: stale`),
		assertions: [],
	};
}

async function askSemanticClause(clause: GoalClause, deps: GoalBoundaryDeps, view: ProofEvidenceView): Promise<ClauseOutcome> {
	if (!jevUsable(deps)) {
		return {
			clause,
			satisfied: false,
			undecidable: true,
			source: "none",
			detail: "JEV is unavailable, so the semantic clause is undecidable rather than unsatisfied",
		};
	}
	const question = semanticQuestion(clause);
	let results: JevResult[] = [];
	try {
		results = await deps.jev!.ask(GOAL_SEMANTIC_SITE_ID, [question], questionState(clause, view));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { clause, satisfied: false, undecidable: true, source: "jev", detail: `the JEV call failed: ${message}` };
	}
	const answer = results.find(
		(result): result is ChoiceAnswer => result.kind === "Choice" && result.questionId === question.id,
	);
	if (!answer || !(answer.choice in question.options) || !accept(answer, "normal")) {
		return { clause, satisfied: false, undecidable: true, source: "jev", detail: "JEV returned no accepted answer" };
	}
	if (answer.choice === "yes") {
		return { clause, satisfied: true, undecidable: false, source: "jev", detail: "JEV answered yes" };
	}
	if (answer.choice === "no") {
		return { clause, satisfied: false, undecidable: false, source: "jev", detail: "JEV answered no" };
	}
	return { clause, satisfied: false, undecidable: true, source: "jev", detail: `JEV answered ${answer.choice}` };
}

/**
 * The clause set for this boundary. A goal that names PRD criteria quantifies
 * over PRD-012's remaining ones too — that union is what lets a criterion
 * PRD-012 reopens re-enter the goal after it had once been satisfied.
 */
function clauseSet(
	text: string,
	derived: readonly GoalClause[] | null,
): GoalClause[] {
	const base = splitClauses(text);
	const named = base.filter((clause) => clause.criterion !== null);
	if (named.length === 0 || derived === null) return base;
	const extra = derived.filter((clause) => !named.some((own) => own.criterion === clause.criterion));
	return [...named, ...extra, ...base.filter((clause) => clause.criterion === null)];
}

/**
 * Evaluate one execution boundary. Deterministic and total: every path returns
 * exactly one of the five stop conditions or a bounded `continue`.
 */
export async function evaluateGoal(state: GoalState, deps: GoalBoundaryDeps): Promise<GoalEvaluation> {
	registerGoalSites();
	if (!state.active) {
		return {
			decision: "stop",
			stop: "USER_STOPPED",
			reason: `USER_STOPPED: the goal ${`"${state.text}"`} is not active`,
			clauses: [],
			turns_used: state.turns_used,
			state,
		};
	}

	const turnState: GoalState = { ...state, turns_used: state.turns_used + 1 };
	const stopNow = (stop: GoalStop, reason: string, clauses: ClauseOutcome[]): GoalEvaluation => {
		const next = { ...turnState, active: false };
		deps.goals?.save(next);
		return { decision: "stop", stop, reason, clauses, turns_used: next.turns_used, state: next };
	};
	const keepGoing = (reason: string, clauses: ClauseOutcome[]): GoalEvaluation => {
		deps.goals?.save(turnState);
		return { decision: "continue", stop: null, reason, clauses, turns_used: turnState.turns_used, state: turnState };
	};

	// Step 1 — limits first: a budget-exhausted goal costs zero inference.
	const cost = (deps.costSoFar ?? costReader(deps.cwd ?? process.cwd(), deps.sessionId, deps.config))();
	const budget = checkBudget(turnState, cost);
	if (budget.exceeded) return stopNow("BUDGET_EXCEEDED", `BUDGET_EXCEEDED: ${budget.reason}`, []);

	// PRD-012's remaining criteria are read once for this boundary: the clause set
	// and every criterion verdict must agree on the same derived list.
	const derived = deps.prd ? derivedCriterionClauses(deps.prd) : null;
	const clauses = clauseSet(turnState.text, derived);
	if (clauses.length === 0) {
		return stopNow("BLOCKED", `BLOCKED: the goal "${turnState.text}" names no checkable clause`, []);
	}

	// Steps 2 and 3 — refresh evidence, then decide every machine clause in code.
	const view = evidenceView(deps);
	const resolutions: Resolution[] = [];
	const semantic: GoalClause[] = [];
	for (const clause of clauses) {
		if (clause.kind === "semantic") semantic.push(clause);
		else resolutions.push(resolveMachineClause(clause, deps, view, derived));
	}

	const impossible = resolutions.find((resolution) => resolution.impossible);
	if (impossible) return stopNow("GOAL_IMPOSSIBLE", `GOAL_IMPOSSIBLE: ${impossible.outcome.detail}`, [impossible.outcome]);

	const outcomes = resolutions.map((resolution) => resolution.outcome);
	const outstanding = resolutions.filter((resolution) => !resolution.outcome.satisfied).map((resolution) => resolution.outcome);
	if (outstanding.length > 0) return continueOrBlock(turnState, keepGoing, stopNow, outstanding, [...outcomes], deps);

	if (semantic.length === 0) {
		return stopNow("GOAL_MET", `GOAL_MET: every clause holds — ${outcomes.map((outcome) => outcome.detail).join("; ")}`, outcomes);
	}

	// Step 4 — only a semantic clause survives, and only now is JEV asked.
	const asked: ClauseOutcome[] = [];
	for (const clause of semantic) asked.push(await askSemanticClause(clause, deps, view));
	const withSemantics = [...outcomes, ...asked];
	if (asked.every((outcome) => outcome.satisfied)) {
		return stopNow("GOAL_MET", `GOAL_MET: every clause holds — ${withSemantics.map((outcome) => outcome.detail).join("; ")}`, withSemantics);
	}
	const refuted = asked.filter((outcome) => !outcome.satisfied && !outcome.undecidable);
	if (refuted.length > 0) return continueOrBlock(turnState, keepGoing, stopNow, refuted, withSemantics, deps);

	const undecided = asked.filter((outcome) => outcome.undecidable);
	return stopNow(
		"BLOCKED",
		`BLOCKED: ${undecided.map((outcome) => `"${outcome.clause.text}" could not be decided (${outcome.detail})`).join("; ")}`,
		withSemantics,
	);
}

/**
 * A continuation needs *useful work*, and PRD-025's list is what answers that:
 * nothing actionable left is a stop, not a spin. With no list wired the engine
 * has no such signal and continues — every continuation is still bounded by
 * `max_turns` and `max_cost`, so the loop cannot run away.
 */
function continueOrBlock(
	state: GoalState,
	keepGoing: (reason: string, clauses: ClauseOutcome[]) => GoalEvaluation,
	stopNow: (stop: GoalStop, reason: string, clauses: ClauseOutcome[]) => GoalEvaluation,
	outstanding: ClauseOutcome[],
	clauses: ClauseOutcome[],
	deps: GoalBoundaryDeps,
): GoalEvaluation {
	const detail = outstanding.map((outcome) => `"${outcome.clause.text}": ${outcome.detail}`).join("; ");
	const work = deps.todos?.remainingWork();
	if (work && work.actionable.length === 0) {
		const blocked = work.blocked.map((item) => `${item.id} (${item.blockedReason ?? item.text})`);
		return stopNow(
			"BLOCKED",
			`BLOCKED: ${detail}; no actionable work remains${
				blocked.length > 0 ? ` — blocked: ${blocked.join(", ")}` : ""
			}`,
			clauses,
		);
	}
	return keepGoing(`continue: ${detail}`, clauses);
}

export interface GoalLoopDeps extends GoalBoundaryDeps {
	/** One executor turn; PRD-007's loop supplies it. Called only while the boundary says continue. */
	turn(): Promise<void>;
}

export interface GoalLoopResult {
	/** Boundaries evaluated, never more than `max_turns`. */
	turns: number;
	evaluations: GoalEvaluation[];
	final: GoalEvaluation;
}

/**
 * The continuation loop: evaluate, take one executor turn, re-read the goal, and
 * repeat — with no user input in between. Termination needs no extra rule: every
 * boundary increments `turns_used` and the budget check runs before anything
 * else, so the loop is bounded by the same cap that bounds the goal. Re-reading
 * the persisted goal each iteration is what makes a mid-loop `/goal stop` land
 * as `USER_STOPPED` instead of one more turn.
 */
export async function runGoalLoop(state: GoalState, deps: GoalLoopDeps): Promise<GoalLoopResult> {
	const evaluations: GoalEvaluation[] = [];
	let current = deps.goals?.load() ?? state;
	let final: GoalEvaluation | null = null;
	for (;;) {
		final = await evaluateGoal(current, deps);
		evaluations.push(final);
		if (final.decision === "stop") break;
		await deps.turn();
		current = deps.goals?.load() ?? final.state;
	}
	return { turns: evaluations.length, evaluations, final };
}
