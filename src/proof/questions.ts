/**
 * The §38 atomic questions and the evidence-gap enum (PRD-010 Phase 1).
 *
 * Two decision sites, one question set each: proof sufficiency asks four
 * `Choice` questions over one criterion's packet, and the missing-proof site
 * asks a single `Choice` over the gap enum. Both are registered in PRD-002's
 * registry (`gate.ts`) with a deterministic fallback that reads only the packet
 * these questions are asked about, so JEV off is still a gate.
 */
import type { ChoiceQuestion } from "../jev/types.js";

export const SUFFICIENCY_SITE_ID = "proof.sufficiency";
export const MISSING_PROOF_SITE_ID = "proof.missing_proof_category";

/** Q1's scale. `PARTIAL` is a real answer: some of the criterion is demonstrated. */
export type Demonstrates = "YES" | "PARTIAL" | "NO";
export type YesNo = "YES" | "NO";

/** Question ids are the wire keys, so they are declared once and read by the answer mapper. */
export const SUFFICIENCY_QUESTION_IDS = {
	demonstrates: "proof.sufficiency.demonstrates",
	contradiction: "proof.sufficiency.contradiction",
	staticForRuntime: "proof.sufficiency.static_for_runtime",
	unevidencedPath: "proof.sufficiency.unevidenced_path",
} as const;

export type SufficiencyKey = keyof typeof SUFFICIENCY_QUESTION_IDS;

export const GAP_QUESTION_ID = "proof.missing_proof_category.gap";

const DEMONSTRATE_OPTIONS: Record<string, string | null> = {
	YES: "this criterion's own records directly demonstrate it",
	PARTIAL: "some of this criterion is demonstrated and some is not",
	NO: "nothing in this criterion's records demonstrates it",
};

const YES_NO_OPTIONS: Record<string, string | null> = {
	YES: "yes",
	NO: "no",
};

/**
 * The four §38 questions, asked as a set. Every one of them is scoped to a single
 * criterion because the packet handed to JEV is that criterion's packet.
 */
export const SUFFICIENCY_QUESTIONS: ChoiceQuestion[] = [
	{
		id: SUFFICIENCY_QUESTION_IDS.demonstrates,
		kind: "Choice",
		text: "Does the evidence attributed to this criterion directly demonstrate it?",
		options: DEMONSTRATE_OPTIONS,
	},
	{
		id: SUFFICIENCY_QUESTION_IDS.contradiction,
		kind: "Choice",
		text: "Is any evidence attributed to this criterion contradictory?",
		options: YES_NO_OPTIONS,
	},
	{
		id: SUFFICIENCY_QUESTION_IDS.staticForRuntime,
		kind: "Choice",
		text: "Is this criterion's evidence primarily static where runtime behavior is required?",
		options: YES_NO_OPTIONS,
	},
	{
		id: SUFFICIENCY_QUESTION_IDS.unevidencedPath,
		kind: "Choice",
		text: "Is there an important execution path of this criterion with no evidence?",
		options: YES_NO_OPTIONS,
	},
];

/**
 * The §38 evidence-gap enum, verbatim. It is the option set of the gap question
 * and the key space of `actions.ts`' mapping table, so a member cannot be added
 * to one without the other failing to compile.
 */
export const PROOF_GAP_CATEGORIES = [
	"NONE",
	"TARGETED_TEST_REQUIRED",
	"BUILD_REQUIRED",
	"TYPECHECK_REQUIRED",
	"RUNTIME_TEST_REQUIRED",
	"UI_VERIFICATION_REQUIRED",
	"REGRESSION_TEST_REQUIRED",
	"DIFF_INSPECTION_REQUIRED",
	"REVIEW_REQUIRED",
	"USER_CONFIRMATION_REQUIRED",
	"MORE_CONTEXT_REQUIRED",
] as const;

export type ProofGapCategory = (typeof PROOF_GAP_CATEGORIES)[number];

export function isGapCategory(value: string): value is ProofGapCategory {
	return (PROOF_GAP_CATEGORIES as readonly string[]).includes(value);
}

/** JEV picks one of these; `src/proof/actions.ts` is the only place that says what it means. */
export const GAP_QUESTION: ChoiceQuestion = {
	id: GAP_QUESTION_ID,
	kind: "Choice",
	text: "Which single evidence category would most directly close this criterion's proof gap?",
	options: {
		NONE: "no further evidence is needed",
		TARGETED_TEST_REQUIRED: "the criterion's targeted test was not run or did not cover it",
		BUILD_REQUIRED: "the change was never built",
		TYPECHECK_REQUIRED: "the types were never checked",
		RUNTIME_TEST_REQUIRED: "the criterion needs the code actually executed at runtime",
		UI_VERIFICATION_REQUIRED: "the criterion is a user-visible surface that was never exercised",
		REGRESSION_TEST_REQUIRED: "the change reaches beyond the targeted tests and the wider suite was not run",
		DIFF_INSPECTION_REQUIRED: "the change itself was never inspected",
		REVIEW_REQUIRED: "no deterministic check is mapped to this criterion; it needs a semantic review",
		USER_CONFIRMATION_REQUIRED: "only the owner can confirm this criterion",
		MORE_CONTEXT_REQUIRED: "the criterion cannot be judged from the evidence at hand",
	},
};
