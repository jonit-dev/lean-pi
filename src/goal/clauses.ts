/**
 * Goal text → clauses (PRD-013 Phase 2, FR-132/FR-134).
 *
 * Deliberately dumb, because ROADMAP §6.4 makes inference the last resort: a
 * clause is machine-decidable when it names a verification kind the evidence
 * store already tracks, or when it carries a PRD acceptance-criterion id —
 * which PRD-010's proof gate settles without a model. Everything else is
 * semantic, and asking JEV about it is *correct*, just more expensive. No
 * grammar, no NLP, no classifier, no condition DSL.
 *
 * A fragment that carries a criterion id is a criterion clause and its prose is
 * a label: this is what lets a PRD-derived goal ("all required acceptance
 * criteria have sufficient fresh evidence (AC-1, AC-2)") parse to exactly the
 * criteria it quantifies over, with no stray semantic clause left behind.
 */

/** ROADMAP §42's machine vocabulary: the words that name a verifier kind. */
const KIND_HINTS: Record<string, string> = {
	test: "targeted_test",
	tests: "targeted_test",
	targeted_test: "targeted_test",
	affected_tests: "targeted_test",
	suite: "full_suite",
	full_suite: "full_suite",
	typecheck: "typecheck",
	compile: "typecheck",
	lint: "lint",
	build: "build",
	runtime: "runtime_smoke",
	runtime_smoke: "runtime_smoke",
	smoke: "runtime_smoke",
	cli: "cli_invocation",
	cli_invocation: "cli_invocation",
	browser: "browser_test",
	browser_test: "browser_test",
	screenshot: "screenshot_compare",
	screenshot_compare: "screenshot_compare",
	git_status: "git_status",
};

/** The PRD criterion id PRD-012's state keys on (`AC-7`, `AC-1.2`). */
const CRITERION_ID = /\bAC-\d+(?:\.\d+)?\b/;

export type GoalClauseKind = "machine" | "semantic";

export interface GoalClause {
	/** Stable within a goal: the criterion id, the required kind(s), or `semantic:<n>`. */
	id: string;
	text: string;
	kind: GoalClauseKind;
	/** Verification kinds this clause needs a fresh `pass` for; empty for a criterion or semantic clause. */
	kinds: string[];
	/** The PRD acceptance-criterion id this clause is keyed by, when it names one. */
	criterion: string | null;
}

/** Words a clause is scanned for, with `-` folded to `_` so `runtime-smoke` reads as `runtime_smoke`. */
function wordsOf(fragment: string): string[] {
	return fragment
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter((word) => word.length > 0);
}

function unique<T>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

/**
 * Split one goal into clauses on `and`/`,`/`;`. Fragments are not re-joined:
 * a clause is as coarse as the user wrote it, which is the same granularity the
 * deterministic pass and the single atomic JEV question work at.
 */
export function splitClauses(text: string): GoalClause[] {
	const clauses: GoalClause[] = [];
	for (const raw of text.split(/\s+and\s+|[,;]/)) {
		const fragment = raw.trim().replace(/[()]+$/g, "").trim();
		if (fragment.length === 0) continue;

		const ids = unique(fragment.match(new RegExp(CRITERION_ID.source, "g")) ?? []);
		if (ids.length > 0) {
			for (const id of ids) {
				clauses.push({ id, text: fragment, kind: "machine", kinds: [], criterion: id });
			}
			continue;
		}

		const kinds = unique(
			wordsOf(fragment)
				.map((word) => KIND_HINTS[word])
				.filter((kind): kind is string => kind !== undefined),
		);
		clauses.push(
			kinds.length > 0
				? { id: kinds.join("+"), text: fragment, kind: "machine", kinds, criterion: null }
				: { id: `semantic:${clauses.length}`, text: fragment, kind: "semantic", kinds: [], criterion: null },
		);
	}
	return clauses;
}
