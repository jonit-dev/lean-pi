/**
 * Deterministic ranking and its two JEV overlays (PRD-023 Phase 1 and 2, §6.4, §50).
 *
 * The fallback is the shipped ordering: `matchCount / sqrt(bytes)`, boosted by
 * proximity to the changed files and by `likely_modules` membership — what a
 * competent engineer would do with no model at all. JEV only reorders and
 * thresholds this list, and a path JEV returns that is not in the deterministic
 * candidate set is discarded as malformed here rather than merely discouraged:
 * `overlayScores` cannot add a candidate, so "JEV imagined a file" is
 * structurally impossible.
 */
import type { Candidate, GrepHit } from "./gather.js";
import { snippetTextOf } from "./gather.js";

/** The atomic rubric behind site 1 and site 6; the wire's score is an index into it. */
export const CANDIDATE_SCORE_LEVELS: readonly string[] = ["irrelevant", "tangential", "relevant", "essential"];

export interface RankFacts {
	likelyModules: readonly string[];
	changedFiles: readonly string[];
}

export interface RankedCandidate {
	candidate: Candidate;
	/** The score the selection is ordered by (JEV's when it answered, else the rule's). */
	score: number;
	/** The rule's own score, kept so a JEV tie never loses the deterministic order. */
	deterministicScore: number;
	source: "jev" | "fallback";
}

export interface Snippet {
	id: string;
	path: string;
	/** The raw grep/LSP output, byte-for-byte; this is what a drop must preserve. */
	text: string;
	bytes: number;
	sourceRef: string;
	/** The owning file's rank score, so the stage-4 rule can be answered from state alone. */
	fileScore: number;
}

export function candidateQuestionId(path: string): string {
	return `candidate:${path}`;
}

export function snippetQuestionId(path: string): string {
	return `snippet:${path}`;
}

/** Score → the wire's level index, and back. Monotone, so encoding can never invert an order. */
export function scoreToLevel(score: number): number {
	const clamped = Math.min(Math.max(score, 0), 1);
	return Math.round(clamped * (CANDIDATE_SCORE_LEVELS.length - 1));
}

export function levelToScore(level: number): number {
	const clamped = Math.min(Math.max(level, 0), CANDIDATE_SCORE_LEVELS.length - 1);
	return clamped / (CANDIDATE_SCORE_LEVELS.length - 1);
}

/** The rule's raw score: matches normalized by size, boosted by proximity, module and symbol evidence. */
export function deterministicScore(candidate: Candidate, facts: RankFacts): number {
	const unit = candidate.matchCount / Math.sqrt(Math.max(candidate.bytes, 1));
	const proximity = 1 / (1 + candidate.distanceToChangedFiles);
	const moduleHit = facts.likelyModules.some((module) => candidate.path === module || candidate.path.startsWith(`${module.replace(/\/$/, "")}/`)) ? 1 : 0;
	const symbol = candidate.symbolHits > 0 ? 1 : 0;
	return unit * (1 + 0.5 * proximity + 0.3 * moduleHit + 0.2 * symbol);
}

/** Normalize the rule's scores to 0..1 within the round's own candidate set. */
export function rankCandidates(candidates: readonly Candidate[], facts: RankFacts): RankedCandidate[] {
	const raw = candidates.map((candidate) => ({ candidate, raw: deterministicScore(candidate, facts) }));
	const max = raw.reduce((best, entry) => Math.max(best, entry.raw), 0);
	return raw
		.map((entry): RankedCandidate => {
			const score = max > 0 ? entry.raw / max : 0;
			return { candidate: entry.candidate, score, deterministicScore: score, source: "fallback" };
		})
		.sort(sortRanked);
}

function sortRanked(left: RankedCandidate, right: RankedCandidate): number {
	return (
		right.score - left.score ||
		right.deterministicScore - left.deterministicScore ||
		left.candidate.path.localeCompare(right.candidate.path)
	);
}

/**
 * Layer JEV's per-candidate scores over the deterministic order. A score for a
 * path outside the candidate set is returned as `malformed` and ignored — the
 * selection is a prefix of the deterministic set, always.
 */
export function overlayScores(
	ranked: readonly RankedCandidate[],
	scores: ReadonlyMap<string, number>,
): { ranked: RankedCandidate[]; malformed: string[] } {
	const known = new Set(ranked.map((entry) => entry.candidate.path));
	const malformed = [...scores.keys()].filter((path) => !known.has(path)).sort();
	const overlaid = ranked.map((entry): RankedCandidate => {
		const score = scores.get(entry.candidate.path);
		if (score === undefined) return entry;
		return { ...entry, score, source: "jev" };
	});
	return { ranked: overlaid.sort(sortRanked), malformed };
}

/** One file's matched lines as the harness produced them, plus the block's raw bytes. */
export function buildSnippet(hit: GrepHit, fileScore: number): Snippet {
	const text = snippetTextOf(hit);
	return {
		id: snippetQuestionId(hit.path),
		path: hit.path,
		text,
		bytes: Buffer.byteLength(text, "utf8"),
		sourceRef: `grep:${hit.path}`,
		fileScore,
	};
}

/** The stage-4 rule: a file above the rank threshold qualifies its snippets for context. */
export function snippetVerdict(fileScore: number, threshold: number): "KEEP" | "DROP" {
	return fileScore >= threshold ? "KEEP" : "DROP";
}

/**
 * Split a snippet at the inline cap, on a line boundary. The head is what the
 * executor sees; the tail is stored and referenced, so the cap removes bytes
 * from context without removing the fact. When no whole line fits, nothing is
 * inlined and the whole block becomes a reference.
 */
export function capSnippet(text: string, capBytes: number): { head: string; tail: string } {
	if (Buffer.byteLength(text, "utf8") <= capBytes) return { head: text, tail: "" };
	const prefix = Buffer.from(text, "utf8").subarray(0, capBytes).toString("utf8");
	const cut = prefix.lastIndexOf("\n");
	if (cut <= 0) return { head: "", tail: text };
	return { head: prefix.slice(0, cut), tail: text.slice(cut + 1) };
}
