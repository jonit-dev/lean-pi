/**
 * The proof gate (PRD-010): the single place where LeanPi converts evidence into
 * the claim "done".
 *
 * One call per turn. It decides each criterion on that criterion's own records,
 * folds the per-criterion results into the task decision, and — while the
 * contract's `limits.semantic_review_rounds` allows it — spends gathering rounds
 * on the cheapest action for the worst gap. A criterion never passes on a JEV
 * answer alone: `PASS` also requires its own deterministic aggregate, its own
 * coverage, and the review the contract demands. When nothing more can be
 * gathered, §41's ladder runs and the task lands on a user-visible `BLOCKED`.
 *
 * Both JEV sites are registered here with a deterministic fallback computed from
 * the packet alone, so JEV off is still a gate — and a strictly more
 * conservative one: the coverage rule can never pass what JEV would reject for
 * absent evidence.
 */
import type { ArtifactStore } from "../context/artifacts.js";
import type { ExecutionContract, SiteTelemetryRow } from "../compiler/contract.js";
import type { TaskState } from "../compiler/state.js";
import type { LeanPiConfig } from "../core/types.js";
import { accept } from "../jev/confidence.js";
import { ensureSite } from "../jev/registry.js";
import type { ChoiceQuestion, JevQuestion, JevResult, JevUsage } from "../jev/types.js";
import type { EvidenceRecord, EvidenceStore, ModelAssertion } from "../verify/evidence.js";
import type { ShellExec } from "../verify/run.js";
import type { BrowserFacility } from "../runtime/browser.js";
import { runtimePlanOf } from "../runtime/plan.js";
import { GAP_ACTIONS, type ProofAction } from "./actions.js";
import {
	answersToResults,
	coverageFallback,
	decideCriterion,
	foldTaskDecision,
	gapCategoryFallback,
	type CriterionInputs,
	type CriterionResult,
	type SufficiencyAnswers,
	type TaskDecision,
} from "./decide.js";
import { buildPacket, type ProofCriterion, type ProofEvidenceView, type ProofPacket } from "./packet.js";
import {
	GAP_QUESTION,
	GAP_QUESTION_ID,
	isGapCategory,
	MISSING_PROOF_SITE_ID,
	SUFFICIENCY_QUESTION_IDS,
	SUFFICIENCY_QUESTIONS,
	SUFFICIENCY_SITE_ID,
	type ProofGapCategory,
	type SufficiencyKey,
} from "./questions.js";
import {
	escalateLadder,
	lastReviewAttempt,
	recover,
	reviewDecision,
	type ProofAttempt,
	type ProofReview,
	type ProofReviewVerdict,
	type RecoverDeps,
} from "./recover.js";

/** The knobs the gate reads off config, which PRD-004 owns the keys for. */
const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * The JEV control plane as this module needs it: `ask` plus the two counters the
 * real client exposes. `fallbackCount` is how `fallbackUsed` is observed — a
 * fallback answer is indistinguishable from a fired one otherwise.
 */
export interface ProofJev {
	ask(siteId: string, questions: JevQuestion[], state: unknown): Promise<JevResult[]>;
	fallbackCount?(): number;
	lastUsage?(): JevUsage;
}

/** What the gate reads off PRD-007's `ExecutorOutcome`; the store, when supplied, is authoritative. */
export interface ProofOutcome {
	/** The workspace hash the executor's evidence is stamped with. */
	workspaceHash?: string;
	/** The executor's records. Ignored when a store is supplied, which also carries stale records. */
	evidence?: readonly EvidenceRecord[];
	/** The executor's claims: hearsay, filed under `claims`, never under `evidence`. */
	assertions?: readonly ModelAssertion[];
	changedFiles?: readonly string[];
	summary?: string | null;
}

export interface ProofDeps {
	/** The §8 contract: its `limits.semantic_review_rounds` is the only round ceiling. */
	contract: ExecutionContract;
	config?: LeanPiConfig;
	/** PRD-009's store. Supplying it is what lets a recovery run leave a record behind. */
	store?: EvidenceStore;
	jev?: ProofJev;
	/** PRD-011's reviewer lane, bound to the turn's reviewer deps. */
	review?: ProofReview;
	/** Verdicts already recorded for this task, e.g. from an earlier manual `/review`. */
	reviewVerdicts?: readonly ProofReviewVerdict[];
	/** When supplied, each ladder verdict is mirrored into the review slice. */
	state?: TaskState;
	artifacts?: ArtifactStore;
	cwd?: string;
	commands?: Partial<Record<string, string>>;
	timeoutMs?: number;
	exec?: ShellExec;
	/** The host's browser adapter, threaded to a gathered browser/screenshot verifier. */
	browserFacility?: BrowserFacility | null;
}

export interface ProofCriterionResult extends CriterionResult {
	packet: ProofPacket;
	answers: SufficiencyAnswers;
}

export interface ProofActionRecord {
	criterion: string;
	category: ProofGapCategory;
	action: ProofAction;
	/** True when the action ran and PRD-009 stored a record for it. */
	executed: boolean;
	/** The gathering round it ran in; `null` when no round was spent. */
	round: number | null;
}

export interface ProofGateResult {
	decision: TaskDecision;
	criteria: ProofCriterionResult[];
	attempts: ProofAttempt[];
	/** Gathering rounds performed; never more than the contract's bound. */
	rounds: number;
	actions: ProofActionRecord[];
	telemetry: SiteTelemetryRow[];
	/** Verdicts this run produced, newest last. */
	reviewVerdicts: ProofReviewVerdict[];
}

/**
 * Register both decision sites. Idempotent, because a compiler may compile many
 * tasks in one process. The numeric consequence floor lives in
 * `jev/confidence.ts`, not on the row: these are `high`.
 */
export function registerProofSites(): void {
	ensureSite({
		id: SUFFICIENCY_SITE_ID,
		questions: SUFFICIENCY_QUESTIONS,
		returnType: ["Choice", "Choice", "Choice", "Choice"],
		consequence: "high",
		telemetryTag: SUFFICIENCY_SITE_ID,
		fallback: ({ state }) => answersToResults(coverageFallback(state as ProofPacket)),
	});
	ensureSite({
		id: MISSING_PROOF_SITE_ID,
		questions: [GAP_QUESTION],
		returnType: ["Choice"],
		consequence: "high",
		telemetryTag: MISSING_PROOF_SITE_ID,
		fallback: ({ state }) => [
			{
				kind: "Choice",
				questionId: GAP_QUESTION_ID,
				choice: gapCategoryFallback(state as ProofPacket),
				probabilities: {},
				confidence: 1,
			},
		],
	});
}

/**
 * The §8 contract's round ceiling. `semantic_review_rounds` is authoritative when
 * set — `0` is a legal bound that skips straight to the ladder — and
 * `LeanPiConfig.proof.maxAttempts` only answers for a contract that omits the
 * field, so exactly one ceiling exists at runtime.
 */
function roundLimit(contract: ExecutionContract, config: LeanPiConfig | undefined): number {
	const declared = (contract as { limits?: { semantic_review_rounds?: unknown } }).limits?.semantic_review_rounds;
	if (typeof declared === "number" && Number.isFinite(declared) && declared >= 0) return Math.floor(declared);
	const configured = (config as { proof?: { maxAttempts?: unknown } } | undefined)?.proof?.maxAttempts;
	if (typeof configured === "number" && Number.isFinite(configured) && configured >= 0) return Math.floor(configured);
	return DEFAULT_MAX_ATTEMPTS;
}

/**
 * Whether the review the contract demands has passed for one criterion: with no
 * reviewer class there is nothing to await, otherwise a passing verdict must
 * exist and must not name this criterion as a finding.
 */
function reviewPassedFor(
	contract: ExecutionContract,
	criterionId: string,
	verdicts: readonly ProofReviewVerdict[],
): boolean {
	const reviewerClass = contract.routing?.reviewer_class ?? "none";
	if (reviewerClass === "none") return true;
	const named = verdicts.some((verdict) =>
		(verdict.verdict?.findings ?? verdict.findings ?? []).some((finding) => finding.criterion === criterionId),
	);
	return !named && verdicts.some((verdict) => reviewDecision(verdict) === "PASS");
}

/**
 * The plan for one round. A criterion this module can actually measure comes
 * first, so a gap that can only end on a review rung cannot stop a sibling's
 * verifier from running; within that, the worst gap first (the most unsatisfied
 * required kinds), then the cheapest action, then declaration order.
 *
 * A plan is measurable only when the selected action is an available verifier for
 * a kind this criterion actually declares — otherwise the round would run a check
 * the contract never asked for, which cannot satisfy coverage and would only burn
 * the bound.
 */
function selectPlan(gaps: readonly ProofCriterionResult[]): ProofCriterionResult {
	const measurable = (gap: ProofCriterionResult): number => {
		const action = gap.gap.action;
		return action.executor === "verifier" &&
			action.unavailableReason === undefined &&
			action.target !== null &&
			gap.coverage.unsatisfied.includes(action.target)
			? 0
			: 1;
	};
	let best = gaps[0]!;
	for (const gap of gaps) {
		const better =
			measurable(gap) - measurable(best) ||
			gap.coverage.unsatisfied.length - best.coverage.unsatisfied.length ||
			best.gap.action.cost - gap.gap.action.cost;
		if (better < 0) best = gap;
	}
	return best;
}

interface SiteAsk {
	results: JevResult[];
	fallbackUsed: boolean;
}

/** One site, one ask, one fallback observation. An unreachable control plane is the fallback's job. */
async function askSite(
	jev: ProofJev | undefined,
	siteId: string,
	questions: ChoiceQuestion[],
	state: unknown,
): Promise<SiteAsk> {
	if (!jev) return { results: [], fallbackUsed: true };
	const before = jev.fallbackCount?.() ?? 0;
	let results: JevResult[] = [];
	try {
		results = await jev.ask(siteId, questions, state);
	} catch {
		results = [];
	}
	const after = jev.fallbackCount?.() ?? 0;
	return { results, fallbackUsed: after > before };
}

/**
 * A declared option answered above the high-consequence floor. An undeclared or
 * below-floor answer is not an answer: the caller takes its deterministic branch
 * rather than a guess.
 */
function choiceOf(question: ChoiceQuestion, results: readonly JevResult[]): { choice: string; confidence: number } | null {
	for (const result of results) {
		if (result.questionId !== question.id || result.kind !== "Choice") continue;
		if (!(result.choice in question.options)) return null;
		return accept(result, "high") ? { choice: result.choice, confidence: result.confidence } : null;
	}
	return null;
}

async function askSufficiency(
	jev: ProofJev | undefined,
	packet: ProofPacket,
): Promise<{ answers: SufficiencyAnswers; fallbackUsed: boolean; confidence: number }> {
	const asked = await askSite(jev, SUFFICIENCY_SITE_ID, SUFFICIENCY_QUESTIONS, packet);
	const answers = coverageFallback(packet);
	const writable = answers as Record<SufficiencyKey, string>;
	let fallbackUsed = asked.fallbackUsed;
	let confidence = 1;
	for (const key of Object.keys(SUFFICIENCY_QUESTION_IDS) as SufficiencyKey[]) {
		const question = SUFFICIENCY_QUESTIONS.find((entry) => entry.id === SUFFICIENCY_QUESTION_IDS[key])!;
		const answered = choiceOf(question, asked.results);
		if (answered === null) {
			fallbackUsed = true;
			continue;
		}
		writable[key] = answered.choice;
		confidence = Math.min(confidence, answered.confidence);
	}
	return { answers, fallbackUsed, confidence };
}

async function askGap(
	jev: ProofJev | undefined,
	packet: ProofPacket,
): Promise<{ category: ProofGapCategory; fallbackUsed: boolean; confidence: number }> {
	const asked = await askSite(jev, MISSING_PROOF_SITE_ID, [GAP_QUESTION], packet);
	const answered = choiceOf(GAP_QUESTION, asked.results);
	if (answered === null || !isGapCategory(answered.choice)) {
		return { category: gapCategoryFallback(packet), fallbackUsed: true, confidence: 1 };
	}
	return { category: answered.choice, fallbackUsed: asked.fallbackUsed, confidence: answered.confidence };
}

/**
 * Decide every criterion, and re-decide the whole set whenever a round or the
 * ladder changed something. Asking the gap site is conditional: a criterion that
 * already passes or has deterministically failed has no gap to classify.
 */
export async function evaluateProofGate(
	criteria: readonly ProofCriterion[],
	outcome: ProofOutcome,
	deps: ProofDeps,
): Promise<ProofGateResult> {
	registerProofSites();
	const store = deps.store;
	const hash = outcome.workspaceHash ?? "";
	// Read fresh every round: a recovery round writes a record through PRD-009, and
	// the re-entered packet has to see it or the loop can never converge.
	const snapshot = (): ProofEvidenceView =>
		store
			? { ...store.view(hash), workspaceHash: hash }
			: {
					records: (outcome.evidence ?? []).filter((record) => record.workspaceHash === hash),
					staleRecords: (outcome.evidence ?? []).filter((record) => record.workspaceHash !== hash),
					assertions: [...(outcome.assertions ?? [])],
					workspaceHash: hash,
				};

	const verdicts: ProofReviewVerdict[] = [
		...(deps.reviewVerdicts ?? (deps.state?.review().verdicts ?? []).map((decision) => ({ decision }))),
	];
	const produced = verdicts.length;
	const limit = roundLimit(deps.contract, deps.config);
	const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
	const blocked = new Map<string, string>();
	const attempts: ProofAttempt[] = [];
	const actions: ProofActionRecord[] = [];
	const telemetry: SiteTelemetryRow[] = [];
	let rounds = 0;

	const recoverDeps: RecoverDeps = {
		workspaceHash: hash,
		...(store ? { store } : {}),
		...(deps.cwd ? { cwd: deps.cwd } : {}),
		// PRD-022: a gathered runtime verifier reads the contract's own runtime
		// declarations, threaded here rather than left in the process-global binder.
		runtime: runtimePlanOf(deps.contract),
		...(deps.browserFacility !== undefined ? { browserFacility: deps.browserFacility } : {}),
		// The host project's `verify:` block, same as PRD-009's own runner reads:
		// without it a recovery round ignores the configured command and shells out
		// to the built-in default (`npx vitest run`) in someone else's repository.
		...(deps.commands ?? deps.config?.verify?.commands ? { commands: deps.commands ?? deps.config?.verify?.commands } : {}),
		...((deps.timeoutMs ?? deps.config?.verify?.timeoutMs) !== undefined ? { timeoutMs: deps.timeoutMs ?? deps.config?.verify?.timeoutMs } : {}),
		...(deps.exec ? { exec: deps.exec } : {}),
		...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
		...(deps.review ? { review: deps.review } : {}),
		onReviewVerdict: (verdict) => deps.state?.recordReview(reviewDecision(verdict)),
	};

	const decideAll = async (): Promise<ProofCriterionResult[]> => {
		const view = snapshot();
		const results: ProofCriterionResult[] = [];
		for (const criterion of criteria) {
			const packet = buildPacket(criterion, view, {
				changedFiles: outcome.changedFiles ?? [],
				summary: outcome.summary ?? null,
				reviewStatus: verdicts.length > 0 ? reviewDecision(verdicts[verdicts.length - 1]!) : "none",
				...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
			});
			const sufficiency = await askSufficiency(deps.jev, packet);
			const required = new Set(criterion.required);
			const attributed = view.records.filter((record) => record.criterion.includes(criterion.id));
			const inputs: CriterionInputs = {
				criterion,
				packet,
				mandatory: attributed.filter((record) => required.has(record.kind)),
				records: attributed,
				stale: view.staleRecords.filter((record) => record.criterion.includes(criterion.id)),
				answers: sufficiency.answers,
				reviewPassed: reviewPassedFor(deps.contract, criterion.id, verdicts),
				gapCategory: "NONE",
				...(blocked.has(criterion.id) ? { blocked: blocked.get(criterion.id)! } : {}),
			};
			const provisional = decideCriterion(inputs);
			const usage = deps.jev?.lastUsage?.() ?? { inputTokens: 0, outputTokens: 0 };
			telemetry.push({
				site_id: SUFFICIENCY_SITE_ID,
				answer: provisional.decision,
				confidence: sufficiency.confidence,
				fallback_used: sufficiency.fallbackUsed,
				tokens: usage,
			});
			if (provisional.decision === "PASS" || provisional.decision === "FAILED") {
				results.push({ ...provisional, packet, answers: sufficiency.answers });
				continue;
			}
			const gap = await askGap(deps.jev, packet);
			telemetry.push({
				site_id: MISSING_PROOF_SITE_ID,
				answer: gap.category,
				confidence: gap.confidence,
				fallback_used: gap.fallbackUsed,
				tokens: deps.jev?.lastUsage?.() ?? { inputTokens: 0, outputTokens: 0 },
			});
			results.push({ ...decideCriterion({ ...inputs, gapCategory: gap.category }), packet, answers: sufficiency.answers });
		}
		return results;
	};

	let results: ProofCriterionResult[] = [];
	for (;;) {
		results = await decideAll();
		const decision = foldTaskDecision(results);
		if (decision === "PASS" || decision === "FAILED") break;
		const gaps = results.filter((result) => result.decision === "MISSING_PROOF");
		if (gaps.length === 0) break;

		const plan = selectPlan(gaps);
		const action = GAP_ACTIONS[plan.gap.category];
		const record: ProofActionRecord = {
			criterion: plan.id,
			category: plan.gap.category,
			action,
			executed: false,
			round: null,
		};
		actions.push(record);

		if (action.unavailableReason !== undefined) {
			// §39's first BLOCKED clause: the selected action has no executor, so the
			// gate says so with the category instead of guessing at a category's worth.
			blocked.set(plan.id, `${action.unavailableReason} (${plan.gap.category})`);
			continue;
		}

		if (action.executor !== "verifier") {
			// Not a measurement this module can take: a review rung, an owner decision,
			// a context fetch, or `NONE`. Neither §39 BLOCKED clause fires, so the
			// criterion stays MISSING_PROOF with its action recorded for the caller.
			break;
		}

		if (rounds >= limit) {
			const ladder = await escalateLadder(gaps.map((gap) => gap.id), recoverDeps);
			attempts.push(...ladder.attempts);
			verdicts.push(...ladder.verdicts);
			const last = lastReviewAttempt(ladder.attempts);
			for (const gap of gaps) {
				blocked.set(
					gap.id,
					`${gap.id} stays unproved (${gap.gap.category}) after the §41 ladder: ${last?.level ?? "no rung"} returned ${last?.decision ?? "no verdict"}`,
				);
			}
			continue;
		}

		const recovered = await recover({ criterion: byId.get(plan.id)!, category: plan.gap.category, action, round: rounds + 1 }, recoverDeps);
		attempts.push(...recovered.attempts);
		verdicts.push(...recovered.verdicts);
		if (recovered.record !== null) {
			rounds += 1;
			record.executed = true;
			record.round = rounds;
		} else {
			// A verifier round that produced nothing (no store, or a runner that threw
			// before a result existed) leaves the criterion unproved with the reason.
			blocked.set(plan.id, recovered.reason);
		}
	}

	return {
		decision: foldTaskDecision(results),
		criteria: results,
		attempts,
		rounds,
		actions,
		telemetry,
		reviewVerdicts: verdicts.slice(produced),
	};
}
