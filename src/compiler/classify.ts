/**
 * Independent complexity and review-risk classification (PRD-004 Phase 2,
 * ROADMAP §12/§13).
 *
 * Execution complexity and review risk are separate axes and the separation is
 * structural: `classifyReviewRisk` is never handed the complexity result or the
 * complexity band — not on the JEV path, not on the fallback path.
 */
import type { TaskPacket } from "../scout/index.js";
import type { JevClient } from "../jev/client.js";
import { accept } from "../jev/confidence.js";
import { ensureSite } from "../jev/registry.js";
import type { JevQuestion, JevResult, JevUsage } from "../jev/types.js";
import type { LeanPiConfig } from "../core/types.js";
import type { ExecutionBand, ExecutionComplexity, RequiredCapability, ReviewRisk } from "./contract.js";

export const COMPLEXITY_SITE_ID = "classify.execution_complexity";
export const CAPABILITY_SITE_ID = "classify.required_capability";
export const REVIEW_RISK_SITE_ID = "classify.review_risk_input";

const YES_NO = { yes: "yes", no: "no" } as const;

export const COMPLEXITY_QUESTIONS: JevQuestion[] = [
	{ id: "mechanical", kind: "Choice", text: "Is this a mechanical or rename-scale edit?", options: YES_NO },
	{ id: "explicit_result", kind: "Choice", text: "Is the expected result explicit?", options: YES_NO },
	{ id: "several_modules", kind: "Choice", text: "Does it span several modules?", options: YES_NO },
	{ id: "unfamiliar_coupled", kind: "Choice", text: "Is the subsystem unfamiliar or highly coupled?", options: YES_NO },
	{ id: "concurrency_perf", kind: "Choice", text: "Is it concurrency, compiler/runtime or performance-critical?", options: YES_NO },
	{ id: "confidence", kind: "Score", text: "How confident is this classification?", levels: ["unsure", "fairly sure", "certain"] },
];

export const CAPABILITY_QUESTIONS: JevQuestion[] = [
	{
		id: "specialization",
		kind: "Choice",
		text: "Which specialization, if any, does correctness depend on?",
		options: { none: "language-agnostic", native: "native/C/C++/Rust", runtime: "runtime or compiler internals", data: "database or query engines" },
	},
	{ id: "index", kind: "Score", text: "What minimum coding capability is sufficient?", levels: ["basic", "competent", "advanced", "expert"] },
];

export const REVIEW_RISK_QUESTIONS: JevQuestion[] = [
	{ id: "deterministic_sufficient", kind: "Choice", text: "Is deterministic verification sufficient for this change class?", options: YES_NO },
	{ id: "alters_visible", kind: "Choice", text: "Does the change alter externally visible behavior?", options: YES_NO },
	{ id: "wide_blast", kind: "Choice", text: "Is the blast radius wide relative to the tested surface?", options: YES_NO },
	{ id: "confidence", kind: "Score", text: "How confident is this risk assessment?", levels: ["unsure", "fairly sure", "certain"] },
];

export function registerClassifierSites(): void {
	ensureSite({
		id: COMPLEXITY_SITE_ID,
		questions: COMPLEXITY_QUESTIONS,
		returnType: ["Choice", "Choice", "Choice", "Choice", "Choice", "Score"],
		consequence: "normal",
		telemetryTag: COMPLEXITY_SITE_ID,
		fallback: ({ questions }): JevResult[] =>
			questions.map((question): JevResult =>
				question.kind === "Choice"
					? { kind: "Choice", questionId: question.id, choice: "no", probabilities: {}, confidence: 0 }
					: { kind: "Score", questionId: question.id, score: 1, legend: {}, confidence: 0 },
			),
	});
	ensureSite({
		id: CAPABILITY_SITE_ID,
		questions: CAPABILITY_QUESTIONS,
		returnType: ["Choice", "Score"],
		consequence: "normal",
		telemetryTag: CAPABILITY_SITE_ID,
		fallback: ({ questions }): JevResult[] =>
			questions.map((question): JevResult =>
				question.kind === "Choice"
					? { kind: "Choice", questionId: question.id, choice: "none", probabilities: {}, confidence: 0 }
					: { kind: "Score", questionId: question.id, score: 1, legend: {}, confidence: 0 },
			),
	});
	ensureSite({
		id: REVIEW_RISK_SITE_ID,
		questions: REVIEW_RISK_QUESTIONS,
		returnType: ["Choice", "Choice", "Choice", "Score"],
		consequence: "normal",
		telemetryTag: REVIEW_RISK_SITE_ID,
		fallback: ({ questions }): JevResult[] =>
			questions.map((question): JevResult =>
				question.kind === "Choice"
					? { kind: "Choice", questionId: question.id, choice: "no", probabilities: {}, confidence: 0 }
					: { kind: "Score", questionId: question.id, score: 1, legend: {}, confidence: 0 },
			),
	});
}

const CONCURRENCY_PERF = /\b(concurren\w*|thread|race|deadlock|lock|compiler|runtime|performance|latenc\w*|optimi[sz]e|native|benchmark)\b/i;
const MECHANICAL = /\b(rename|typo|constant|label|string|copy|wording|css|color|colour|format|indentation)\b/i;
const SEVERAL_MODULES = /\b(modules?|packages?|subsystem|integration|cross-|end-to-end|migrat\w*|several|multiple)\b/i;

/** Complexity band from deterministic markers; E2/MEDIUM is the conservative default (§49). */
export function heuristicBand(request: string, packet: TaskPacket): ExecutionBand {
	if (CONCURRENCY_PERF.test(request)) return "E3";
	if (SEVERAL_MODULES.test(request) || packet.workspace.likely_modules.length > 1) return "E2";
	if (MECHANICAL.test(request) && packet.workspace.changed_files.length <= 6) return "E0";
	if (MECHANICAL.test(request)) return "E1";
	return "E2";
}

export const COMPLEXITY_BY_BAND: Record<ExecutionBand, ExecutionComplexity> = {
	E0: "LOW",
	E1: "LOW",
	E2: "MEDIUM",
	E3: "HIGH",
};

export interface ClassifiedExecution {
	band: ExecutionBand;
	complexity: ExecutionComplexity;
	fallbackUsed: boolean;
	confidence: number;
	tokens: JevUsage;
}

export interface ComplexityInput {
	client: Pick<JevClient, "ask" | "fallbackCount"> & Partial<Pick<JevClient, "lastUsage">>;
	request: string;
	packet: TaskPacket;
	config: LeanPiConfig;
}

export async function classifyExecution({ client, request, packet, config }: ComplexityInput): Promise<ClassifiedExecution> {
	registerClassifierSites();
	const before = client.fallbackCount();
	let results: JevResult[];
	try {
		results = await client.ask(COMPLEXITY_SITE_ID, COMPLEXITY_QUESTIONS, { request, packet });
	} catch {
		const band = heuristicBand(request, packet);
		return { band, complexity: COMPLEXITY_BY_BAND[band], fallbackUsed: true, confidence: 0, tokens: zero() };
	}
	if (client.fallbackCount() > before || !results.every((result) => accept(result, "normal"))) {
		// Conservative: MEDIUM with no readable marker, a band when the packet shows one.
		const band = heuristicBand(request, packet);
		return { band, complexity: COMPLEXITY_BY_BAND[band], fallbackUsed: true, confidence: 0, tokens: zero() };
	}
	const tokens = client.lastUsage?.() ?? zero();

	const said = (id: string) => results.some((result) => result.questionId === id && result.kind === "Choice" && result.choice === "yes");
	const band: ExecutionBand = said("concurrency_perf") || said("unfamiliar_coupled")
		? "E3"
		: said("several_modules") || !said("explicit_result")
			? "E2"
			: said("mechanical")
				? "E0"
				: "E1";
	void config;
	return { band, complexity: COMPLEXITY_BY_BAND[band], fallbackUsed: false, confidence: confidenceOf(results), tokens };
}

export interface ClassifiedCapability {
	required_capability: RequiredCapability;
	fallbackUsed: boolean;
	confidence: number;
	tokens: JevUsage;
}

const INDEX_BY_BAND: Record<ExecutionBand, number> = { E0: 30, E1: 45, E2: 65, E3: 88 };
const INDEX_BY_LEVEL = [30, 55, 75, 92];

export interface CapabilityInput extends ComplexityInput {
	band: ExecutionBand;
}

export async function deriveRequiredCapability({ client, request, packet, band }: CapabilityInput): Promise<ClassifiedCapability> {
	registerClassifierSites();
	const specialization = packet.repository.languages[0];
	const fallback: RequiredCapability = {
		min_coding_index: INDEX_BY_BAND[band],
		...(specialization ? { specialization } : {}),
	};
	const before = client.fallbackCount();
	let results: JevResult[];
	try {
		results = await client.ask(CAPABILITY_SITE_ID, CAPABILITY_QUESTIONS, { request, packet });
	} catch {
		return { required_capability: fallback, fallbackUsed: true, confidence: 0, tokens: zero() };
	}
	const tokens = client.lastUsage?.() ?? zero();
	const choice = results.find((result) => result.questionId === "specialization");
	const score = results.find((result) => result.questionId === "index");
	if (
		client.fallbackCount() > before ||
		!results.every((result) => accept(result, "normal")) ||
		choice?.kind !== "Choice" ||
		score?.kind !== "Score"
	) {
		return { required_capability: fallback, fallbackUsed: true, confidence: 0, tokens: zero() };
	}
	const level = Math.min(Math.max(Math.round(score.score), 0), INDEX_BY_LEVEL.length - 1);
	return {
		required_capability: {
			min_coding_index: INDEX_BY_LEVEL[level] as number,
			...(choice.choice && choice.choice !== "none" ? { specialization: choice.choice } : {}),
		},
		fallbackUsed: false,
		confidence: confidenceOf(results),
		tokens,
	};
}

const VISIBLE_SURFACE =
	/\b(api|cli|command|config|schema|wire|protocol|format|migration|ui|public|interface|endpoint|response|output)\b/i;

export interface ReviewRiskSignals {
	altersVisible: boolean;
	wideBlast: boolean;
	deterministicSufficient: boolean;
	securityOrMigration: boolean;
}

/** The three §Solution signals, readable from the packet and the request alone. */
export function reviewRiskSignals(request: string, packet: TaskPacket): ReviewRiskSignals {
	const changed = packet.workspace.changed_files;
	const modules = packet.workspace.likely_modules;
	const hasRunner = packet.workspace.test_runners.length > 0;
	const changedTests = changed.some((file) => /test|spec|__tests__/i.test(file));
	const confined = changed.length <= 2 && modules.length <= 1;
	return {
		altersVisible: VISIBLE_SURFACE.test(request),
		wideBlast: !confined || (!hasRunner && changed.length > 0),
		deterministicSufficient: hasRunner && confined && !changedTests,
		securityOrMigration: /\b(migrat\w*|auth\w*|secret\w*|credential\w*|permission\w*|encrypt\w*)\b/i.test(request),
	};
}

export function reviewRiskFromSignals(signals: ReviewRiskSignals, elevateReview: boolean): ReviewRisk {
	let count = 0;
	if (signals.altersVisible) count += 1;
	if (signals.wideBlast) count += 1;
	if (!signals.deterministicSufficient) count += 1;
	let level = Math.min(count, 3);
	if (signals.securityOrMigration) level = 3;
	if (elevateReview) level = Math.min(level + 1, 3);
	return `R${level}` as ReviewRisk;
}

export interface ReviewRiskInput {
	client: Pick<JevClient, "ask" | "fallbackCount"> & Partial<Pick<JevClient, "lastUsage">>;
	request: string;
	packet: TaskPacket;
	elevateReview: boolean;
}

export interface ClassifiedReviewRisk {
	review_risk: ReviewRisk;
	fallbackUsed: boolean;
	confidence: number;
	tokens: JevUsage;
}

function zero(): JevUsage {
	return { inputTokens: 0, outputTokens: 0 };
}

function confidenceOf(results: JevResult[]): number {
	return results.length === 0 ? 0 : Math.min(...results.map((result) => result.confidence));
}

export async function classifyReviewRisk({ client, request, packet, elevateReview }: ReviewRiskInput): Promise<ClassifiedReviewRisk> {
	registerClassifierSites();
	const signals = reviewRiskSignals(request, packet);
	const deterministic = reviewRiskFromSignals(signals, elevateReview);
	const before = client.fallbackCount();
	let results: JevResult[];
	try {
		results = await client.ask(REVIEW_RISK_SITE_ID, REVIEW_RISK_QUESTIONS, { request, packet });
	} catch {
		return { review_risk: deterministic, fallbackUsed: true, confidence: 0, tokens: zero() };
	}
	if (client.fallbackCount() > before || !results.every((result) => accept(result, "normal"))) {
		return { review_risk: deterministic, fallbackUsed: true, confidence: 0, tokens: zero() };
	}
	const tokens = client.lastUsage?.() ?? zero();

	const said = (id: string) => results.some((result) => result.questionId === id && result.kind === "Choice" && result.choice === "yes");
	// The three signals count into R0–R3; the complexity band is not consulted.
	const counted: ReviewRiskSignals = {
		deterministicSufficient: said("deterministic_sufficient"),
		altersVisible: said("alters_visible"),
		wideBlast: said("wide_blast"),
		securityOrMigration: signals.securityOrMigration,
	};
	return { review_risk: reviewRiskFromSignals(counted, elevateReview), fallbackUsed: false, confidence: confidenceOf(results), tokens };
}
