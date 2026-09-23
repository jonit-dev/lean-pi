/**
 * The §10 planning gate (PRD-004 Phase 1, FR-012).
 *
 * Six atomic questions asked in one `ask('gate.prd_required', …)` batch and
 * combined in ordinary code into `PRD_REQUIRED | DIRECT_EXECUTION | UNCERTAIN`.
 * The thresholds come from configuration so §10's "calibrate from real LeanPi
 * task data" requirement has somewhere to land.
 */
import type { TaskPacket } from "../scout/index.js";
import type { JevClient } from "../jev/client.js";
import { accept } from "../jev/confidence.js";
import { ensureSite } from "../jev/registry.js";
import type { ChoiceAnswer, JevQuestion, JevResult, JevUsage } from "../jev/types.js";
import type { LeanPiConfig } from "../core/types.js";
import type { PlanningDecision } from "./contract.js";

export const GATE_SITE_ID = "gate.prd_required";

export const GATE_QUESTIONS: JevQuestion[] = [
	{ id: "architecture", kind: "Choice", text: "Does the task require choosing or changing architecture?", options: { yes: "yes", no: "no" } },
	{ id: "multi_behavior", kind: "Choice", text: "Does it alter multiple externally visible behaviors?", options: { yes: "yes", no: "no" } },
	{ id: "ambiguous", kind: "Choice", text: "Does it contain materially ambiguous requirements?", options: { yes: "yes", no: "no" } },
	{ id: "multi_stage", kind: "Choice", text: "Does it involve multiple dependent implementation stages?", options: { yes: "yes", no: "no" } },
	{ id: "acceptance_helpful", kind: "Choice", text: "Would acceptance criteria materially reduce execution risk?", options: { yes: "yes", no: "no" } },
	{ id: "localized", kind: "Choice", text: "Is the work a localized implementation/fix with a clear expected result?", options: { yes: "yes", no: "no" } },
	{ id: "confidence", kind: "Score", text: "How confident is this assessment?", levels: ["unsure", "fairly sure", "certain"] },
];

export interface GateOutcome {
	decision: PlanningDecision;
	tokens: JevUsage;
	/** Raised by the §10 low-confidence path and consumed by the risk classifier. */
	elevateReview: boolean;
	fallbackUsed: boolean;
	/** True only when the decision came from JEV's confident branch (PRD-044). */
	confident: boolean;
	answers: Record<string, string>;
	confidence: number;
}

/** Registered once per process; the compiler may compile many tasks. */
export function registerGateSite(): void {
	ensureSite({
		id: GATE_SITE_ID,
		questions: GATE_QUESTIONS,
		returnType: ["Choice", "Choice", "Choice", "Choice", "Choice", "Choice", "Score"],
		consequence: "high",
		telemetryTag: GATE_SITE_ID,
		fallback: ({ questions }): JevResult[] =>
			questions.map((question): JevResult =>
				question.kind === "Choice"
					? { kind: "Choice", questionId: question.id, choice: "no", probabilities: {}, confidence: 0 }
					: { kind: "Score", questionId: question.id, score: 0, legend: {}, confidence: 0 },
			),
	});
}

const ARCHITECTURAL_VERBS = /\b(replace|rewrite|migrat\w*|redesign|architect\w*|port|introduce|overhaul|rework)\b/i;
const MULTI_STAGE_MARKERS = /\b(then|afterwards|followed by|stages?|milestones?|phase[sd]?)\b/i;
const AMBIGUITY_MARKERS = /\b(maybe|somehow|not sure|unclear|figure out|investigate|as appropriate|etc\.|or something)\b/i;

export interface GateHeuristicSignals {
	architectural: boolean;
	multiModule: boolean;
	ambiguous: boolean;
	localized: boolean;
}

/** Deterministic signals over the scout packet and the request (§10 fallback). */
export function gateSignals(request: string, packet: TaskPacket): GateHeuristicSignals {
	const changed = packet.workspace.changed_files;
	const modules = packet.workspace.likely_modules;
	const multiModule = modules.length > 1 || changed.length > 3;
	const localized = changed.length <= 2 && modules.length <= 1 && !multiModule;
	return {
		architectural: ARCHITECTURAL_VERBS.test(request) || MULTI_STAGE_MARKERS.test(request),
		multiModule,
		ambiguous: AMBIGUITY_MARKERS.test(request),
		localized,
	};
}

/** The §10 fallback: never a `false` on uncertainty — high-risk work prefers a PRD. */
export function heuristicGate(request: string, packet: TaskPacket): GateOutcome {
	const signals = gateSignals(request, packet);
	const decision: PlanningDecision =
		signals.architectural || (signals.multiModule && signals.ambiguous)
			? "PRD_REQUIRED"
			: signals.localized && !signals.ambiguous
				? "DIRECT_EXECUTION"
				: "PRD_REQUIRED";
	return { decision, elevateReview: false, fallbackUsed: true, confident: false, answers: {}, confidence: 0, tokens: { inputTokens: 0, outputTokens: 0 } };
}

export interface GateInput {
	client: Pick<JevClient, "ask" | "fallbackCount"> & Partial<Pick<JevClient, "lastUsage">>;
	request: string;
	packet: TaskPacket;
	config: LeanPiConfig;
}

export async function runGate({ client, request, packet, config }: GateInput): Promise<GateOutcome> {
	registerGateSite();
	const threshold = config.thresholds.gate_prd_required;
	let results: JevResult[];
	const before = client.fallbackCount();
	try {
		results = await client.ask(GATE_SITE_ID, GATE_QUESTIONS, { request, packet });
	} catch {
		return heuristicGate(request, packet);
	}
	const fallbackUsed = client.fallbackCount() > before;
	if (fallbackUsed) return heuristicGate(request, packet);
	const tokens = client.lastUsage?.() ?? { inputTokens: 0, outputTokens: 0 };

	const answers: Record<string, string> = {};
	let confidence = 1;
	for (const result of results) {
		if (result.kind === "Choice") answers[result.questionId] = result.choice;
		confidence = Math.min(confidence, result.confidence);
	}
	// A malformed or partial answer set is low confidence, never a `false`.
	const missing = GATE_QUESTIONS.some((question) => question.kind === "Choice" && answers[question.id] === undefined);
	const confident = !missing && results.every((result) => accept(result, "high")) && confidence >= threshold;

	const said = (id: string) => answers[id] === "yes";
	const bounded = said("localized") && !said("architecture") && !said("multi_stage");

	if (confident) {
		if (said("architecture") || said("multi_behavior") || said("multi_stage")) {
			return { decision: "PRD_REQUIRED", elevateReview: false, fallbackUsed: false, confident: true, answers, confidence, tokens };
		}
		if (said("localized") && !said("ambiguous")) {
			return { decision: "DIRECT_EXECUTION", elevateReview: false, fallbackUsed: false, confident: true, answers, confidence, tokens };
		}
	}

	// §10/§50 low-confidence resolution, asymmetric by risk.
	const signals = gateSignals(request, packet);
	const highRisk = !bounded || signals.architectural || signals.multiModule;
	return {
		decision: highRisk ? "PRD_REQUIRED" : "DIRECT_EXECUTION",
		elevateReview: !highRisk,
		fallbackUsed: false,
		confident: false,
		answers,
		confidence,
		tokens,
	};
}

export function choiceOf(result: JevResult): string | null {
	return result.kind === "Choice" ? (result as ChoiceAnswer).choice : null;
}
