/**
 * The `rtk.reduction_policy` decision site (PRD-019 Phase 2, ROADMAP §49).
 *
 * ★★☆☆☆ is binding on the design: the deterministic output-class rule is the
 * shipped decision and JEV is only an optional override inside the ambiguous
 * band, with the site off by default (`rtk.jev_policy: false`). The fallback is
 * non-null and answers the same rule, so a disabled site, an unreachable JEV
 * client and a below-threshold answer are indistinguishable in behavior — which
 * is what AC-5 asserts from both sides.
 */
import type { FallbackContext } from "../jev/registry.js";
import { ensureSite } from "../jev/registry.js";
import type { JevQuestion, JevResult } from "../jev/types.js";
import { decideReduction, type RtkConfig, type OutputClass } from "./policy.js";

export const RTK_SITE_ID = "rtk.reduction_policy";

export const RTK_POLICY_QUESTION_ID = "rtk_reduce";

/** The two choices the wire contract carries; the rule's vocabulary, not a second one. */
export const RTK_POLICY_OPTIONS = ["reduce", "keep_raw"] as const;

export type RtkPolicyChoice = (typeof RTK_POLICY_OPTIONS)[number];

export type RtkPolicyState = OutputClass & Pick<RtkConfig, "min_bytes" | "min_lines" | "ambiguous_band_bytes">;

/** The facts the question text names, carried as `state` so the fallback can answer from them alone. */
export function rtkPolicyState(output: OutputClass, config: RtkConfig): RtkPolicyState {
	return {
		...output,
		min_bytes: config.min_bytes,
		min_lines: config.min_lines,
		ambiguous_band_bytes: config.ambiguous_band_bytes,
	};
}

export function rtkPolicyQuestion(): JevQuestion {
	return {
		id: RTK_POLICY_QUESTION_ID,
		kind: "Choice",
		text: "Given this tool output (kind, bytes, lines, structured), is reducing it more likely to lower total task cost than to cause a re-read?",
		options: {
			reduce: "the output is a log whose gist survives summarization; a re-read is unlikely",
			keep_raw: "the output is reference material or too small to pay for a summary",
		},
	};
}

/** The rule's answer, derived from the question's own state — the site's documented fallback. */
export function ruleChoiceOf(state: unknown): RtkPolicyChoice {
	const facts = state as Partial<RtkPolicyState> | undefined;
	if (!facts || typeof facts.bytes !== "number" || typeof facts.min_bytes !== "number") return "keep_raw";
	return decideReduction(
		{
			kind: facts.kind ?? "other",
			bytes: facts.bytes,
			lines: facts.lines ?? 0,
			structured: facts.structured ?? true,
		},
		{
			min_bytes: facts.min_bytes,
			min_lines: facts.min_lines ?? 0,
			ambiguous_band_bytes: facts.ambiguous_band_bytes ?? [facts.min_bytes, facts.min_bytes],
		},
	).decision;
}

/** Idempotent: registered once per process, like every other site in LeanPi. */
export function registerRtkSite(): void {
	ensureSite({
		id: RTK_SITE_ID,
		questions: [rtkPolicyQuestion()],
		returnType: ["Choice"],
		consequence: "low",
		telemetryTag: RTK_SITE_ID,
		fallback: ({ state }: FallbackContext): JevResult[] => [
			{ kind: "Choice", questionId: RTK_POLICY_QUESTION_ID, choice: ruleChoiceOf(state), probabilities: {}, confidence: 0 },
		],
	});
}
