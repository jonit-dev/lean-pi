/**
 * The `lsp.usefulness` decision site (PRD-018, ROADMAP §49).
 *
 * ★★★☆☆ is binding on the design: the deterministic table is primary and JEV is
 * only the tie-breaker, reached solely when project configuration, language
 * availability, task type and the FR-094 override have all failed to separate
 * the candidates. The fallback is non-null and always cheap: the cheapest tied
 * candidate, so LSP works identically with JEV enabled and disabled.
 */
import { ensureSite } from "../jev/registry.js";
import type { JevQuestion, JevResult } from "../jev/types.js";
import { cheapestMode, LSP_MODES, type LspMode } from "./mode.js";

export const LSP_SITE_ID = "lsp.usefulness";

export const LSP_MODE_QUESTION_ID = "lsp_mode";

/** The rubric behind each candidate; the question's option keys are the modes. */
export const LSP_MODE_RUBRIC: Record<LspMode, string> = {
	LSP_OFF: "not worth a resident server: the change set or the task type cannot pay for it",
	LSP_DIAGNOSTICS: "worth a resident server for a diagnostics stream",
	LSP_NAVIGATION: "worth a resident server for navigation (definition, references, symbols)",
	LSP_FULL: "worth a resident server for both streams",
};

/** One Choice question, restricted to the candidates the table could not separate. */
export function lspUsefulnessQuestions(candidates: readonly LspMode[]): JevQuestion[] {
	return [
		{
			id: LSP_MODE_QUESTION_ID,
			kind: "Choice",
			text: "Given the changed-language set and the task summary, which LSP mode is worth its cost for this task?",
			options: Object.fromEntries(candidates.map((mode) => [mode, LSP_MODE_RUBRIC[mode]])),
		},
	];
}

/** The documented deterministic fallback: cheapest tied candidate, `LSP_OFF` when unusable. */
export function cheapestTiedCandidate(state: unknown): LspMode {
	const candidates = (state as { candidates?: unknown } | undefined)?.candidates;
	if (!Array.isArray(candidates)) return "LSP_OFF";
	const tied = candidates.filter((value): value is LspMode => typeof value === "string" && (LSP_MODES as readonly string[]).includes(value));
	return tied.length === 0 ? "LSP_OFF" : cheapestMode(tied);
}

/** Registered once per process; the compiler may compile many tasks. */
export function registerLspSite(): void {
	ensureSite({
		id: LSP_SITE_ID,
		questions: lspUsefulnessQuestions(LSP_MODES),
		returnType: ["Choice"],
		consequence: "low",
		telemetryTag: LSP_SITE_ID,
		fallback: ({ state }): JevResult[] => [
			{ kind: "Choice", questionId: LSP_MODE_QUESTION_ID, choice: cheapestTiedCandidate(state), probabilities: {}, confidence: 0 },
		],
	});
}
