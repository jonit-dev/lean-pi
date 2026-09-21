/**
 * The three routing decision sites (PRD-020 Phases 2–3, ROADMAP §49).
 *
 * Every site registers with PRD-002's registry with a non-null deterministic
 * fallback, so routing, effort and delegation are identical with JEV enabled and
 * disabled — JEV can only reorder inside a band the deterministic scorer already
 * produced, never choose outside it. `routing.quota_preference` and
 * `routing.delegation_worth` are `low` consequence (they reorder or decline an
 * optimization), `routing.reasoning_effort` is `normal` (it changes what the
 * backend is asked to spend).
 */
import { ensureSite } from "../jev/registry.js";
import type { JevQuestion, JevResult } from "../jev/types.js";
import { ROUTING_SITE_IDS, type EffortLevel } from "./defaults.js";

export const QUOTA_PREFERENCE_SITE_ID = ROUTING_SITE_IDS.quota_preference;
export const REASONING_EFFORT_SITE_ID = ROUTING_SITE_IDS.reasoning_effort;
export const DELEGATION_WORTH_SITE_ID = ROUTING_SITE_IDS.delegation_worth;

export const EFFORT_LEVELS: readonly EffortLevel[] = ["minimal", "low", "medium", "high"];

export const EFFORT_QUESTION_ID = "effort";
export const QUOTA_QUESTION_ID = "candidate";
export const DELEGATION_QUESTION_ID = "delegation";

export interface QuotaPreferenceState {
	/** The tie-band members, cheapest first — the only ids an answer may name. */
	candidates: { id: string; backend: string; route_cost: number; reason: string }[];
	/**
	 * Models the runtime knows that are not in the tie band, with why. Decision
	 * data, not options: it travels in the question text because `state` is hashed
	 * in `metadata-only` mode, while an answer may only name a band member.
	 */
	inventory?: { id: string; backend: string; reason: string }[];
}

export interface EffortState {
	complexity: string;
	default_effort: EffortLevel;
	evidence: string;
}

export interface DelegationState {
	slices: number;
	threshold: number;
}

export const EFFORT_RUBRIC: Record<EffortLevel, string> = {
	minimal: "one short pass is enough: the change is mechanical and locally verifiable",
	low: "a single careful pass with a targeted check",
	medium: "multiple steps with reasoning about call sites and edge cases",
	high: "deep reasoning: interacting invariants, wide blast radius, or a repeated failure",
};

/** One Choice question, restricted to the tie band the deterministic scorer produced. */
export function quotaPreferenceQuestions(state: QuotaPreferenceState): JevQuestion[] {
	// The full inventory is stated, the eligible band is the enum. A model that
	// did not clear the bar is visible to JEV but cannot be chosen, so the
	// constraint stays the deterministic scorer's.
	const band = new Set(state.candidates.map((candidate) => candidate.id));
	const excluded = (state.inventory ?? []).filter((entry) => !band.has(entry.id));
	const inventoryLine =
		excluded.length === 0
			? ""
			: ` Other models on this machine: ${excluded.map((entry) => `${entry.backend === "" ? "" : `${entry.backend}/`}${entry.id} (${entry.reason})`).join("; ")}.`;
	return [
		{
			id: QUOTA_QUESTION_ID,
			kind: "Choice",
			text: `Candidates A and B both meet the capability bar for this task; which is more likely to succeed on the first attempt?${inventoryLine}`,
			options: Object.fromEntries(state.candidates.map((candidate) => [candidate.id, candidate.reason])),
		},
	];
}

export function effortQuestions(state: EffortState): JevQuestion[] {
	return [
		{
			id: EFFORT_QUESTION_ID,
			kind: "Choice",
			text: `For this contract at complexity ${state.complexity} with ${state.evidence}, is minimal / low / medium / high effort the cheapest level likely to succeed?`,
			options: EFFORT_RUBRIC,
		},
	];
}

export function delegationQuestions(state: DelegationState): JevQuestion[] {
	return [
		{
			id: DELEGATION_QUESTION_ID,
			kind: "Choice",
			text: `Does splitting this contract into ${state.slices} declared independent slices save more than the extra dispatch and context cost?`,
			options: {
				delegate: "the slices are independent enough that separate workers pay for themselves",
				inline: "one worker, one context: the split would cost more than it saves",
			},
		},
	];
}

/** The documented fallbacks; each is the branch the deterministic path already takes. */
export function fallbackCandidate(state: QuotaPreferenceState): string {
	return state.candidates[0]?.id ?? "none";
}

export function fallbackEffort(state: EffortState): EffortLevel {
	return state.default_effort;
}

export function fallbackDelegation(state: DelegationState): "delegate" | "inline" {
	return state.slices > state.threshold ? "delegate" : "inline";
}

function asState<T>(state: unknown): T {
	// The registry hands a site's state back as `unknown`; the caller that filled
	// it in this PRD is the only writer, so one narrowing at the boundary is enough.
	return state as T;
}

/** Registered once per process; the compiler and the router may both run in one session. */
export function registerRoutingSites(): void {
	ensureSite({
		id: QUOTA_PREFERENCE_SITE_ID,
		questions: quotaPreferenceQuestions({ candidates: [] }),
		returnType: ["Choice"],
		consequence: "low",
		telemetryTag: QUOTA_PREFERENCE_SITE_ID,
		fallback: ({ state }): JevResult[] => [
			{ kind: "Choice", questionId: QUOTA_QUESTION_ID, choice: fallbackCandidate(asState<QuotaPreferenceState>(state)), probabilities: {}, confidence: 0 },
		],
	});
	ensureSite({
		id: REASONING_EFFORT_SITE_ID,
		questions: effortQuestions({ complexity: "MEDIUM", default_effort: "medium", evidence: "no telemetry" }),
		returnType: ["Choice"],
		consequence: "normal",
		telemetryTag: REASONING_EFFORT_SITE_ID,
		fallback: ({ state }): JevResult[] => [
			{ kind: "Choice", questionId: EFFORT_QUESTION_ID, choice: fallbackEffort(asState<EffortState>(state)), probabilities: {}, confidence: 0 },
		],
	});
	ensureSite({
		id: DELEGATION_WORTH_SITE_ID,
		questions: delegationQuestions({ slices: 1, threshold: 2 }),
		returnType: ["Choice"],
		consequence: "low",
		telemetryTag: DELEGATION_WORTH_SITE_ID,
		fallback: ({ state }): JevResult[] => [
			{ kind: "Choice", questionId: DELEGATION_QUESTION_ID, choice: fallbackDelegation(asState<DelegationState>(state)), probabilities: {}, confidence: 0 },
		],
	});
}
