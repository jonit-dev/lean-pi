/**
 * Atomic typed JEV questions and their results (PRD-002 Phase 1, FR-011).
 *
 * The shapes mirror TypeSafe's evaluation endpoint (`POST /v1/systemone`)
 * verbatim: a `state` plus a map of typed `questions`, answered under the same
 * ids. JEV answers typed questions; it never generates the execution contract
 * (§8), so no answer can carry a contract-shaped object — the property AC-7
 * asserts.
 */

export type QuestionKind = "Choice" | "Score" | "Noul";

/** Consequence class consumed by `accept()` (§50). Numeric thresholds live in confidence.ts. */
export type Consequence = "low" | "normal" | "high";

/** A choice question: option → rubric description (`null` when the option needs none). */
export interface ChoiceQuestion {
	id: string;
	kind: "Choice";
	text: string;
	options: Record<string, string | null>;
}

/** A score question: an ordered rubric of at least two levels. */
export interface ScoreQuestion {
	id: string;
	kind: "Score";
	text: string;
	levels: string[];
}

/** A yes/no question with an optional description of what yes and no mean. */
export interface NoulQuestion {
	id: string;
	kind: "Noul";
	text: string;
	criteria?: { true?: string; false?: string };
}

export type JevQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export interface ChoiceAnswer {
	kind: "Choice";
	questionId: string;
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

export interface ScoreAnswer {
	kind: "Score";
	questionId: string;
	score: number;
	legend: Record<string, string>;
	confidence: number;
}

export interface NoulAnswer {
	kind: "Noul";
	questionId: string;
	/** Probability the answer is yes, 0..1. */
	value: number;
	/**
	 * The wire contract carries no confidence for a noul answer, so decisiveness
	 * — the distance from a coin flip, normalized to 0..1 — stands in for it.
	 */
	confidence: number;
}

export type JevResult = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export interface JevUsage {
	inputTokens: number;
	outputTokens: number;
}

/** The scalar view recorded in the decision log — never a nested structure. */
export function answerValue(result: JevResult): string | number | null {
	switch (result.kind) {
		case "Choice":
			return result.choice;
		case "Score":
			return result.score;
		case "Noul":
			return result.value;
	}
}

export function decisiveness(probability: number): number {
	return Math.abs(probability - 0.5) * 2;
}
