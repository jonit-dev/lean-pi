/**
 * The six exploration decision sites (PRD-023 Phase 2–4, FR-020, §49).
 *
 * Each site is declared once with atomic question text, its return kind, a
 * consequence class for §50 and a non-null deterministic fallback, so the
 * decision log and calibration get every site for free and *disabling JEV needs
 * no code path of its own*: the governor calls the registered fallback on every
 * answer it does not receive, which makes the deterministic rule the shipped
 * default rather than a patched-in branch.
 *
 * The fallbacks answer from the question's own `state` (the facts they need),
 * never from anything the caller keeps privately, so a fallback resolves
 * identically whether JEV is off, unreachable or merely unconfident.
 */
import { getSite, ensureSite, type DecisionSite, type FallbackContext } from "../jev/registry.js";
import type { JevQuestion, JevResult } from "../jev/types.js";
import { CANDIDATE_SCORE_LEVELS, candidateQuestionId, scoreToLevel, snippetVerdict, type Snippet } from "./rank.js";
import type { Candidate } from "./gather.js";
import type { TestCandidate } from "./tests.js";

export const EXPLORATION_CANDIDATE_SITE_ID = "explore.candidate_relevance";
export const EXPLORATION_SUFFICIENCY_SITE_ID = "explore.sufficiency";
export const EXPLORATION_SUBSYSTEM_SITE_ID = "explore.subsystem_order";
export const EXPLORATION_SNIPPET_SITE_ID = "explore.snippet_relevance";
export const EXPLORATION_SIBLING_SITE_ID = "explore.sibling_expansion";
export const EXPLORATION_TEST_SITE_ID = "explore.test_relevance";

/** The six sites this module registers, in decision order. */
export const EXPLORATION_SITE_IDS = [
	EXPLORATION_CANDIDATE_SITE_ID,
	EXPLORATION_SUBSYSTEM_SITE_ID,
	EXPLORATION_SNIPPET_SITE_ID,
	EXPLORATION_SIBLING_SITE_ID,
	EXPLORATION_TEST_SITE_ID,
	EXPLORATION_SUFFICIENCY_SITE_ID,
] as const;

export type ExplorationSiteId = (typeof EXPLORATION_SITE_IDS)[number];

/** What each site degrades to. AC-3 asserts all six by id and by this name. */
export const EXPLORATION_FALLBACK_NAMES: Record<ExplorationSiteId, string> = {
	[EXPLORATION_CANDIDATE_SITE_ID]: "matchCount / sqrt(bytes), boosted by path proximity to changed_files and likely_modules membership; fixed top-N",
	[EXPLORATION_SUFFICIENCY_SITE_ID]: "stop after maxRounds, or as soon as a round adds no newly accepted file",
	[EXPLORATION_SUBSYSTEM_SITE_ID]: "scout likely_modules order, then directories of changed_files, then top-level roots by match count",
	[EXPLORATION_SNIPPET_SITE_ID]: "keep snippets from files above the rank threshold, up to the per-file byte cap; drop the rest",
	[EXPLORATION_SIBLING_SITE_ID]: "expand same-basename test and type siblings only while under half the remaining byte budget; never expand callers",
	[EXPLORATION_TEST_SITE_ID]: "path/basename overlap with accepted files plus test_runners ownership",
};

export const SUFFICIENCY_OPTIONS: Record<string, string> = {
	ENOUGH_EVIDENCE: "the accepted files and resolved symbols cover every clause of the objective",
	NEED_MORE: "at least one objective clause has no evidence yet",
};

export const SNIPPET_OPTIONS: Record<string, string> = {
	KEEP: "the hit shows code that bears on the objective",
	DROP: "an incidental name collision, not worth a token",
};

export const SIBLING_OPTIONS: Record<string, string> = {
	EXPAND: "reading this sibling is worth its token cost for this objective",
	SKIP: "this sibling class is not worth the tokens here",
};

export const SUFFICIENCY_QUESTION_ID = "explore.sufficiency.stop";
export const SUBSYSTEM_IMPLICATED_QUESTION_ID = "explore.subsystem.implicated";
export const SUBSYSTEM_ROOT_QUESTION_ID = "explore.subsystem.root";

export const SIBLING_CLASSES = ["test", "type", "caller"] as const;

export type SiblingClass = (typeof SIBLING_CLASSES)[number];

export function siblingQuestionId(path: string, siblingClass: SiblingClass): string {
	return `sibling:${path}:${siblingClass}`;
}

/** Site 1: one atomic score per deterministic candidate, over the facts the candidate carries. */
export function candidateQuestions(objective: string, candidates: readonly Candidate[]): JevQuestion[] {
	return candidates.map((candidate): JevQuestion => {
		const lines = candidate.matchedLines
			.slice(0, 3)
			.map((line) => `${line.number}: ${line.text.trim().slice(0, 80)}`)
			.join(" | ");
		return {
			id: candidateQuestionId(candidate.path),
			kind: "Score",
			text: [
				"How relevant is this file to the task?",
				`objective: ${objective}`,
				`path: ${candidate.path} (${candidate.language}, ${candidate.bytes} bytes)`,
				`matches: ${candidate.matchCount}, symbol hits: ${candidate.symbolHits}, directory distance to changed files: ${candidate.distanceToChangedFiles}`,
				lines.length > 0 ? `matched lines: ${lines}` : "matched lines: none",
			]
				.join(" ")
				.slice(0, 600),
			levels: [...CANDIDATE_SCORE_LEVELS],
		};
	});
}

/** Site 4: one atomic keep/drop per snippet batch, before anything enters context. */
export function snippetQuestions(snippets: readonly Snippet[]): JevQuestion[] {
	return snippets.map(
		(snippet): JevQuestion => ({
			id: snippet.id,
			kind: "Choice",
			text: `Does this grep/LSP hit show code that bears on the objective, or is it an incidental name collision? ${snippet.path}: ${snippet.text
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 300)}`,
			options: SNIPPET_OPTIONS,
		}),
	);
}

/** Site 5: one atomic expand/skip per sibling class of an accepted file. */
export function siblingQuestions(objective: string, siblings: readonly SiblingCandidate[]): JevQuestion[] {
	return siblings.map(
		(sibling): JevQuestion => ({
			id: sibling.id,
			kind: "Choice",
			text: `For ${sibling.file}, is reading its ${sibling.class} sibling (${sibling.paths.join(", ") || "none found"}) worth the token cost for this objective? ${objective}`.slice(
				0,
				400,
			),
			options: SIBLING_OPTIONS,
		}),
	);
}

/** Site 6: one atomic score per discovered candidate test. */
export function testQuestions(objective: string, tests: readonly TestCandidate[]): JevQuestion[] {
	return tests.map(
		(test): JevQuestion => ({
			id: `test:${test.path}`,
			kind: "Score",
			text: `Does this test exercise the behavior this task changes? objective: ${objective} test: ${test.path} (runners: ${test.runners.join(", ") || "unknown"})`.slice(
				0,
				400,
			),
			levels: [...CANDIDATE_SCORE_LEVELS],
		}),
	);
}

/** Site 3: is one root clearly implicated, and which one. */
export function subsystemQuestions(objective: string, roots: readonly string[]): JevQuestion[] {
	return [
		{
			id: SUBSYSTEM_IMPLICATED_QUESTION_ID,
			kind: "Noul",
			text: `Does one of these enumerated subsystem roots clearly contain the code this task must change? ${objective}`.slice(0, 400),
			criteria: { true: "one root is clearly implicated", false: "no single root stands out" },
		},
		{
			id: SUBSYSTEM_ROOT_QUESTION_ID,
			kind: "Choice",
			text: `Which of these enumerated subsystem roots most likely contains the code this task must change? ${objective}`.slice(0, 400),
			options: Object.fromEntries(roots.map((root) => [root, `the code this task must change lives under ${root}`])),
		},
	];
}

/** Site 2: one atomic stop question per round over a compact evidence summary. */
export function sufficiencyQuestions(objective: string): JevQuestion[] {
	return [
		{
			id: SUFFICIENCY_QUESTION_ID,
			kind: "Choice",
			text: `Given the objective and the evidence gathered so far, is the evidence sufficient to start implementing? ${objective}`.slice(0, 400),
			options: SUFFICIENCY_OPTIONS,
		},
	];
}

/** One sibling class of one accepted file, as the site's question and its fallback both see it. */
export interface SiblingCandidate {
	id: string;
	file: string;
	class: SiblingClass;
	/** Existing paths in this class; empty means nothing to expand. */
	paths: string[];
	bytes: number;
}

/** Site 5's rule, answerable from the question state alone. */
export function siblingVerdict(sibling: Pick<SiblingCandidate, "class" | "paths" | "bytes">, remainingBytes: number, shareOfBudget = 0.5): "EXPAND" | "SKIP" {
	if (sibling.paths.length === 0) return "SKIP";
	if (sibling.class === "caller") return "SKIP";
	return sibling.bytes <= remainingBytes * shareOfBudget ? "EXPAND" : "SKIP";
}

function scoreResult(question: JevQuestion, score: number): JevResult {
	return { kind: "Score", questionId: question.id, score: scoreToLevel(score), legend: {}, confidence: 1 };
}

function choiceResult(question: JevQuestion, choice: string, confidence = 1): JevResult {
	return { kind: "Choice", questionId: question.id, choice, probabilities: { [choice]: 1 }, confidence };
}

/** The candidate site's fallback: the deterministic score of each asked candidate. */
export function candidateFallback(context: FallbackContext): JevResult[] {
	const state = context.state as { candidates?: Array<{ path: string; deterministicScore: number }> } | undefined;
	return context.questions.map((question) => {
		const facts = (state?.candidates ?? []).find((entry) => `candidate:${entry.path}` === question.id);
		return scoreResult(question, facts?.deterministicScore ?? 0);
	});
}

/** The snippet site's fallback: keep above the rank threshold, up to the byte cap. */
export function snippetFallback(context: FallbackContext): JevResult[] {
	const state = context.state as { threshold?: number; snippets?: Array<{ id: string; fileScore: number }> } | undefined;
	return context.questions.map((question) => {
		const facts = (state?.snippets ?? []).find((entry) => entry.id === question.id);
		const verdict = snippetVerdict(facts?.fileScore ?? 0, state?.threshold ?? 0.5);
		return choiceResult(question, verdict, 0);
	});
}

/** The sibling site's fallback: same-basename test/type siblings under half the remaining bytes. */
export function siblingFallback(context: FallbackContext): JevResult[] {
	const state = context.state as { remainingBytes?: number; shareOfBudget?: number; siblings?: SiblingCandidate[] } | undefined;
	return context.questions.map((question) => {
		const facts = (state?.siblings ?? []).find((entry) => entry.id === question.id);
		const verdict = facts
			? siblingVerdict(facts, state?.remainingBytes ?? 0, state?.shareOfBudget ?? 0.5)
			: "SKIP";
		return choiceResult(question, verdict, 0);
	});
}

/** The sufficiency site's fallback: a round that added nothing new is evidence enough to stop. */
export function sufficiencyFallback(context: FallbackContext): JevResult[] {
	const state = context.state as { addedThisRound?: number } | undefined;
	const added = state?.addedThisRound ?? 0;
	return context.questions.map((question) => choiceResult(question, added === 0 ? "ENOUGH_EVIDENCE" : "NEED_MORE", 0));
}

/** The subsystem site's fallback: no root implicated, so the deterministic breadth order stands. */
export function subsystemFallback(context: FallbackContext): JevResult[] {
	const state = context.state as { roots?: string[] } | undefined;
	const root = (state?.roots ?? [])[0] ?? ".";
	return context.questions.map((question) =>
		question.kind === "Noul"
			? { kind: "Noul", questionId: question.id, value: 0, confidence: 1 }
			: choiceResult(question, root, 0),
	);
}

/** The test site's fallback: the path/ownership score of each asked test. */
export function testFallback(context: FallbackContext): JevResult[] {
	const state = context.state as { tests?: Array<{ path: string; deterministicScore: number }> } | undefined;
	return context.questions.map((question) => {
		const facts = (state?.tests ?? []).find((entry) => `test:${entry.path}` === question.id);
		return scoreResult(question, facts?.deterministicScore ?? 0);
	});
}

const CANDIDATE_TEMPLATE: JevQuestion = { id: "candidate", kind: "Score", text: "How relevant is this file to the task?", levels: [...CANDIDATE_SCORE_LEVELS] };
const SNIPPET_TEMPLATE: JevQuestion = { id: "snippet", kind: "Choice", text: "Does this hit bear on the objective?", options: SNIPPET_OPTIONS };
const SIBLING_TEMPLATE: JevQuestion = { id: "sibling", kind: "Choice", text: "Is this sibling worth reading?", options: SIBLING_OPTIONS };
const TEST_TEMPLATE: JevQuestion = { id: "test", kind: "Score", text: "Does this test exercise the changed behavior?", levels: [...CANDIDATE_SCORE_LEVELS] };

/** Registered once per process; the compiler may explore many tasks in one session. */
export function registerExplorationSites(): DecisionSite[] {
	return [
		ensureSite({
			id: EXPLORATION_CANDIDATE_SITE_ID,
			// Templates: the real batch carries one question per candidate.
			questions: [CANDIDATE_TEMPLATE],
			returnType: ["Score"],
			consequence: "normal",
			telemetryTag: EXPLORATION_CANDIDATE_SITE_ID,
			fallback: candidateFallback,
		}),
		ensureSite({
			id: EXPLORATION_SUFFICIENCY_SITE_ID,
			questions: sufficiencyQuestions("<objective>"),
			returnType: ["Choice"],
			consequence: "normal",
			telemetryTag: EXPLORATION_SUFFICIENCY_SITE_ID,
			fallback: sufficiencyFallback,
		}),
		ensureSite({
			id: EXPLORATION_SUBSYSTEM_SITE_ID,
			questions: subsystemQuestions("<objective>", ["<root>"]),
			returnType: ["Noul", "Choice"],
			consequence: "normal",
			telemetryTag: EXPLORATION_SUBSYSTEM_SITE_ID,
			fallback: subsystemFallback,
		}),
		ensureSite({
			id: EXPLORATION_SNIPPET_SITE_ID,
			questions: [SNIPPET_TEMPLATE],
			returnType: ["Choice"],
			// A wrongly dropped snippet costs correctness, so this site asks for high confidence (§50).
			consequence: "high",
			telemetryTag: EXPLORATION_SNIPPET_SITE_ID,
			fallback: snippetFallback,
		}),
		ensureSite({
			id: EXPLORATION_SIBLING_SITE_ID,
			questions: [SIBLING_TEMPLATE],
			returnType: ["Choice"],
			consequence: "normal",
			telemetryTag: EXPLORATION_SIBLING_SITE_ID,
			fallback: siblingFallback,
		}),
		ensureSite({
			id: EXPLORATION_TEST_SITE_ID,
			questions: [TEST_TEMPLATE],
			returnType: ["Score"],
			consequence: "normal",
			telemetryTag: EXPLORATION_TEST_SITE_ID,
			fallback: testFallback,
		}),
	];
}

/**
 * The deterministic branch, reached through the registry rather than beside it:
 * the site's registered fallback answers any question JEV did not.
 */
export function siteFallbackAnswers(siteId: ExplorationSiteId, questions: readonly JevQuestion[], state: unknown, reason: string): JevResult[] {
	const results = getSite(siteId).fallback({ siteId, reason, state, questions: [...questions] });
	if (!Array.isArray(results) || results.length !== questions.length) {
		throw new Error(`Exploration site "${siteId}" fallback returned ${Array.isArray(results) ? results.length : 0} answers for ${questions.length} questions.`);
	}
	return results;
}
