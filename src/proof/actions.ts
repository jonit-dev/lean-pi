/**
 * The one enum→action table (PRD-010 Phase 2, FR-017/FR-126).
 *
 * JEV answers with a category and writes no prose about what to do; this table is
 * the only mapping from that category to something the turn can actually run.
 * It is an exhaustive `Record<ProofGapCategory, …>`, so adding a member to §38's
 * enum fails to compile until its executor is named here.
 *
 * `unavailableReason` is how a member with no executor in this MVP is kept
 * distinct from `NONE`: it resolves to `BLOCKED` carrying the reason, never to a
 * silent "nothing to do".
 */
import type { ProofGapCategory } from "./questions.js";

/** Who runs the action: a PRD-009 verifier, PRD-011's reviewer lane, or a lane outside this module. */
export type ProofActionExecutor = "verifier" | "review" | "owner" | "context" | "none";

export interface ProofAction {
	executor: ProofActionExecutor;
	/** The verifier kind, review level or lane the executor dispatches to; `null` when there is none. */
	target: string | null;
	/** One line naming the concrete action. Never model prose: the table is static. */
	detail: string;
	/** Relative cost, so `recover` spends the cheapest action on the highest-severity gap. */
	cost: number;
	/** Set only when no executor exists for the category in this MVP. */
	unavailableReason?: string;
}

/**
 * The §38 enum's single mapping. Nothing else in `src/proof/` turns a category
 * into an action. The verifier targets are PRD-009's canonical kinds
 * (`verify/descriptors.ts`); `runtime_smoke` and `browser_test` are the two
 * PRD-022 registers, so an unwired facility surfaces as a `not_run` record
 * rather than as silence.
 */
export const GAP_ACTIONS: Record<ProofGapCategory, ProofAction> = {
	NONE: { executor: "none", target: null, detail: "no evidence gap named", cost: 0 },
	TARGETED_TEST_REQUIRED: { executor: "verifier", target: "targeted_test", detail: "run the criterion's targeted test", cost: 1 },
	TYPECHECK_REQUIRED: { executor: "verifier", target: "typecheck", detail: "run the typecheck", cost: 1 },
	BUILD_REQUIRED: { executor: "verifier", target: "build", detail: "run the build", cost: 2 },
	RUNTIME_TEST_REQUIRED: { executor: "verifier", target: "runtime_smoke", detail: "run the runtime smoke check", cost: 2 },
	REGRESSION_TEST_REQUIRED: { executor: "verifier", target: "full_suite", detail: "run the full suite", cost: 3 },
	UI_VERIFICATION_REQUIRED: { executor: "verifier", target: "browser_test", detail: "run the browser verification", cost: 3 },
	DIFF_INSPECTION_REQUIRED: {
		executor: "none",
		target: null,
		detail: "inspect the diff for the criterion's unevidenced path",
		cost: 1,
		unavailableReason: "no diff-inspection executor is registered in this MVP",
	},
	REVIEW_REQUIRED: { executor: "review", target: "QUICK_REVIEW", detail: "run the reviewer lane at QUICK_REVIEW", cost: 1 },
	USER_CONFIRMATION_REQUIRED: {
		executor: "owner",
		target: "user_confirmation",
		detail: "ask the owner to confirm the criterion",
		cost: 1,
	},
	MORE_CONTEXT_REQUIRED: {
		executor: "context",
		target: "context_retrieval",
		detail: "retrieve more context for the criterion",
		cost: 1,
	},
};

/**
 * The inverse of the verifier half of the table, used by the gap site's fallback
 * to name a category for a required kind that has no fresh passing record.
 * `undefined` for a kind no category covers (e.g. `git_status`), which the
 * fallback resolves conservatively rather than guessing.
 */
export function categoryForVerifierKind(kind: string): ProofGapCategory | undefined {
	for (const category of Object.keys(GAP_ACTIONS) as ProofGapCategory[]) {
		const action = GAP_ACTIONS[category];
		if (action.executor === "verifier" && action.target === kind) return category;
	}
	return undefined;
}
