/**
 * The §39 decision table, by code, plus the deterministic fallbacks of both
 * decision sites (PRD-010 Phase 1, FR-125/FR-127).
 *
 * `decideCriterion` is pure and reads nothing that is not scoped to one
 * criterion: the aggregate is computed over that criterion's own mandatory
 * records, staleness is that criterion's own, and the four answers describe that
 * criterion's packet. There is no parameter by which a JEV answer can produce
 * `PASS` without this criterion's aggregate — and a deterministic failure or a
 * contradiction outranks every semantic opinion, including a model that reports
 * none.
 */
import type { VerificationStatus } from "../verify/aggregate.js";
import { aggregate } from "../verify/aggregate.js";
import type { EvidenceRecord, EvidenceStatus } from "../verify/evidence.js";
import type { ChoiceAnswer, JevResult } from "../jev/types.js";
import { GAP_ACTIONS, categoryForVerifierKind, type ProofAction } from "./actions.js";
import type { ProofCriterion, ProofPacket } from "./packet.js";
import {
	SUFFICIENCY_QUESTION_IDS,
	type Demonstrates,
	type ProofGapCategory,
	type SufficiencyKey,
	type YesNo,
} from "./questions.js";

export type CriterionDecision = "PASS" | "MISSING_PROOF" | "FAILED" | "BLOCKED";
export type TaskDecision = CriterionDecision;

/** Q1..Q4's answers for one criterion. */
export interface SufficiencyAnswers {
	demonstrates: Demonstrates;
	contradiction: YesNo;
	staticForRuntime: YesNo;
	unevidencedPath: YesNo;
}

/** The minimum a record exposes for contradiction detection; `EvidenceRecord` and a packet entry both qualify. */
export interface ScopeRecord {
	kind: string;
	status: EvidenceStatus;
	scope: string;
}

export interface Contradiction {
	scope: string;
	passing: ScopeRecord;
	failing: ScopeRecord;
}

/**
 * Two records over the same scope that disagree: one measured a pass, the other a
 * failure. Deterministic and scope-keyed — nothing here reads a status the
 * deterministic aggregate already accounted for, so a contradiction inside an
 * otherwise-passing criterion still fails it (FR-125).
 */
export function detectContradiction(records: readonly ScopeRecord[]): Contradiction | null {
	const byScope = new Map<string, { passing?: ScopeRecord; failing?: ScopeRecord }>();
	for (const record of records) {
		const scope = record.scope.trim();
		if (scope.length === 0) continue;
		const slot = byScope.get(scope) ?? {};
		if (record.status === "pass" && slot.passing === undefined) slot.passing = record;
		if (record.status === "fail" && slot.failing === undefined) slot.failing = record;
		byScope.set(scope, slot);
	}
	for (const [scope, slot] of byScope) {
		if (slot.passing && slot.failing) return { scope, passing: slot.passing, failing: slot.failing };
	}
	return null;
}

export interface CoverageResult {
	satisfied: boolean;
	/** Required kinds with no fresh passing record attributed to this criterion. */
	unsatisfied: readonly string[];
}

/**
 * The coverage rule over a packet alone: satisfiable only when the criterion has
 * at least one required kind and every one of them has a fresh `pass` in the
 * packet's evidence. A record that is stale or `unavailable` is absent from
 * `evidence` by construction, so either one leaves its kind unsatisfied — the
 * rule can never pass something a missing measurement leaves open.
 */
export function coverageOfPacket(packet: ProofPacket): CoverageResult {
	const satisfiedKinds = new Set(
		packet.evidence.filter((entry) => entry.status === "pass").map((entry) => entry.kind),
	);
	const unsatisfied = packet.criterion.required.filter((kind) => !satisfiedKinds.has(kind));
	return { satisfied: packet.criterion.required.length > 0 && unsatisfied.length === 0, unsatisfied };
}

/** The `proof.sufficiency` site's declared fallback: the coverage rule, expressed as answers. */
export function coverageFallback(packet: ProofPacket): SufficiencyAnswers {
	const coverage = coverageOfPacket(packet);
	const contradiction = detectContradiction(packet.evidence);
	return {
		demonstrates: coverage.satisfied && contradiction === null ? "YES" : "NO",
		contradiction: contradiction === null ? "NO" : "YES",
		staticForRuntime: "NO",
		unevidencedPath: coverage.unsatisfied.length > 0 ? "YES" : "NO",
	};
}

/** The `proof.missing_proof_category` site's declared fallback: the first unsatisfied required kind, mapped. */
export function gapCategoryFallback(packet: ProofPacket): ProofGapCategory {
	const coverage = coverageOfPacket(packet);
	for (const kind of coverage.unsatisfied) {
		const category = categoryForVerifierKind(kind);
		if (category !== undefined) return category;
	}
	// Nothing deterministic is left to run: either no verifier kind is mapped to
	// this criterion at all, or every unsatisfied kind is one the table does not
	// cover. The reviewer lane is the only rung remaining, and it is never `NONE`.
	return "REVIEW_REQUIRED";
}

/** The fallback answers as the `Choice` results the registry requires. */
export function answersToResults(answers: SufficiencyAnswers, confidence = 1): JevResult[] {
	const keys = Object.keys(SUFFICIENCY_QUESTION_IDS) as SufficiencyKey[];
	return keys.map((key): ChoiceAnswer => {
		const choice = answers[key];
		return { kind: "Choice", questionId: SUFFICIENCY_QUESTION_IDS[key], choice, probabilities: { [choice]: confidence }, confidence };
	});
}

export interface CriterionInputs {
	criterion: ProofCriterion;
	packet: ProofPacket;
	/** This criterion's mandatory fresh records: what its deterministic aggregate is computed over. */
	mandatory: readonly EvidenceRecord[];
	/** Every fresh record attributed to this criterion, mandatory and advisory. */
	records: readonly EvidenceRecord[];
	/** Records attributed to this criterion whose workspace state no longer matches. */
	stale: readonly EvidenceRecord[];
	answers: SufficiencyAnswers;
	/** Whether the review the contract demands for this criterion has passed. */
	reviewPassed: boolean;
	/** The classification site's answer for this criterion. */
	gapCategory: ProofGapCategory;
	/** Set when the gate has established that no further action can be taken for this criterion. */
	blocked?: string;
}

export interface CriterionResult {
	id: string;
	decision: CriterionDecision;
	reasons: string[];
	aggregate: VerificationStatus;
	coverage: CoverageResult;
	contradiction: Contradiction | null;
	gap: { category: ProofGapCategory; action: ProofAction };
}

/**
 * The §39 table. Reasons are carried per clause so a MISSING_PROOF names every
 * clause that failed, not just the first.
 */
export function decideCriterion(inputs: CriterionInputs): CriterionResult {
	const { criterion, packet, mandatory, records, stale, answers } = inputs;
	const status = aggregate(mandatory, stale);
	const coverage = coverageOfPacket(packet);
	const contradiction = detectContradiction(records);
	const gap = { category: inputs.gapCategory, action: GAP_ACTIONS[inputs.gapCategory] };
	const result = (decision: CriterionDecision, reasons: string[]): CriterionResult => ({
		id: criterion.id,
		decision,
		reasons,
		aggregate: status,
		coverage,
		contradiction,
		gap,
	});

	if (status === "deterministic_failure") {
		return result("FAILED", [`${criterion.id}: the deterministic aggregate is deterministic_failure`]);
	}
	if (contradiction) {
		return result("FAILED", [
			`${criterion.id}: ${contradiction.passing.kind} passed while ${contradiction.failing.kind} failed over scope "${contradiction.scope}"`,
		]);
	}
	if (answers.contradiction === "YES") {
		return result("FAILED", [`${criterion.id}: the sufficiency answer reports contradictory evidence`]);
	}
	if (
		status === "pass" &&
		stale.length === 0 &&
		answers.demonstrates === "YES" &&
		answers.staticForRuntime !== "YES" &&
		answers.unevidencedPath !== "YES" &&
		inputs.reviewPassed &&
		coverage.satisfied
	) {
		return result("PASS", [`${criterion.id}: every required kind has a fresh passing record and the review passed`]);
	}

	const missing: string[] = [];
	if (status === "incomplete") missing.push(`${criterion.id}: a mandatory check is not_run or unavailable`);
	if (stale.length > 0) missing.push(`${criterion.id}: ${stale.length} record(s) no longer match the workspace state`);
	if (answers.demonstrates !== "YES") missing.push(`${criterion.id}: the evidence does not directly demonstrate it (${answers.demonstrates})`);
	if (answers.staticForRuntime === "YES") missing.push(`${criterion.id}: the evidence is static where runtime behavior is required`);
	if (answers.unevidencedPath === "YES") missing.push(`${criterion.id}: an important execution path has no evidence`);
	if (!coverage.satisfied) {
		missing.push(`${criterion.id}: no fresh passing record for ${coverage.unsatisfied.join(", ") || "any required kind"}`);
	}
	if (!inputs.reviewPassed) missing.push(`${criterion.id}: the required review has not passed`);
	missing.push(`${criterion.id}: the gap is ${inputs.gapCategory}`);

	if (inputs.blocked !== undefined) return result("BLOCKED", [...missing, inputs.blocked]);
	return result("MISSING_PROOF", missing);
}

/**
 * The strict fold: the task takes the worst per-criterion outcome and every
 * criterion keeps its own result. No task-wide aggregate exists that could feed
 * back into a criterion, so one passing typecheck cannot carry the set.
 *
 * `MISSING_PROOF` outranks `BLOCKED` so that the loop spends its remaining rounds
 * on a criterion it can still improve; once the bound is reached every remaining
 * gap is `BLOCKED` and the task decision becomes `BLOCKED`. An empty criteria
 * list has nothing to prove and folds to `PASS`.
 */
export function foldTaskDecision(results: readonly { decision: CriterionDecision }[]): TaskDecision {
	const severity: Record<CriterionDecision, number> = { FAILED: 3, MISSING_PROOF: 2, BLOCKED: 1, PASS: 0 };
	let worst: TaskDecision = "PASS";
	for (const result of results) {
		if (severity[result.decision] > severity[worst]) worst = result.decision;
	}
	return worst;
}
