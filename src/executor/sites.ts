/**
 * The two retry-loop decision sites (PRD-007 Phase 3, §33 + §49).
 *
 * Both have a non-null deterministic fallback, and neither can raise a budget:
 * `classifyFailure` only chooses *what* the next attempt changes, and
 * `retryUseful` can only stop the loop earlier than the ceiling, never later.
 */
import type { JevClient } from "../jev/client.js";
import { accept } from "../jev/confidence.js";
import { ensureSite } from "../jev/registry.js";
import type { JevQuestion, JevResult } from "../jev/types.js";
import type { FailureInput, RetryRecord } from "./retry.js";

export const FAILURE_SITE_ID = "executor.failure_classification";
export const RETRY_SITE_ID = "executor.retry_usefulness";

export const FAILURE_CATEGORIES = ["syntax", "assertion", "environment", "dependency", "likely_logic_bug"] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/** Above this the loop retries; at or below it the turn ends early. */
export const RETRY_USEFULNESS_THRESHOLD = 2;

export const FAILURE_QUESTION: JevQuestion = {
	id: "failure_category",
	kind: "Choice",
	text: "Which category best describes this failure?",
	options: {
		syntax: "the code does not parse or typecheck",
		assertion: "a test assertion failed",
		environment: "the environment, host or backend could not run the check",
		dependency: "a dependency could not be resolved or installed",
		likely_logic_bug: "the code runs but behaves incorrectly",
	},
};

export const RETRY_QUESTION: JevQuestion = {
	id: "retry_useful",
	kind: "Score",
	text: "Given this failure history and the evidence gathered, is another attempt with this strategy likely to change the outcome?",
	levels: ["certainly not", "unlikely", "plausible", "likely"],
};

/** The §49 rule table: verifier kind plus diagnostic text, no model required. */
export function failureCategoryRule(failure: FailureInput): FailureCategory {
	const text = `${failure.kind} ${failure.detail}`.toLowerCase();
	if (/enoent|spawn|econnrefused|network|command not found|timed out|exit 127/.test(text)) return "environment";
	if (/cannot find module|unmet peer|resolve|install failed|missing dependency/.test(text)) return "dependency";
	if (/typecheck|parse|ts\d{4}|syntaxerror|unexpected token|build/.test(text)) return "syntax";
	if (/assert|expected|test|spec/.test(text)) return "assertion";
	return "likely_logic_bug";
}

export function registerRetrySites(): void {
	ensureSite({
		id: FAILURE_SITE_ID,
		questions: [FAILURE_QUESTION],
		returnType: ["Choice"],
		consequence: "low",
		telemetryTag: FAILURE_SITE_ID,
		fallback: (): JevResult[] => [{ kind: "Choice", questionId: FAILURE_QUESTION.id, choice: "likely_logic_bug", probabilities: {}, confidence: 0 }],
	});
	ensureSite({
		id: RETRY_SITE_ID,
		questions: [RETRY_QUESTION],
		returnType: ["Score"],
		consequence: "normal",
		telemetryTag: RETRY_SITE_ID,
		// The bare §33 policy already decided `retry`; the fallback agrees with it.
		fallback: (): JevResult[] => [{ kind: "Score", questionId: RETRY_QUESTION.id, score: RETRY_USEFULNESS_THRESHOLD + 1, legend: {}, confidence: 0 }],
	});
}

export type JevSeam = Pick<JevClient, "ask" | "fallbackCount">;

export interface SiteAnswer<T> {
	value: T;
	fallbackUsed: boolean;
}

export async function classifyFailure(options: { client?: JevSeam; failure: FailureInput }): Promise<SiteAnswer<FailureCategory>> {
	registerRetrySites();
	const deterministic = failureCategoryRule(options.failure);
	const client = options.client;
	if (!client) return { value: deterministic, fallbackUsed: true };
	const before = client.fallbackCount();
	try {
		const [answer] = await client.ask(FAILURE_SITE_ID, [FAILURE_QUESTION], { failure: options.failure });
		const known = answer?.kind === "Choice" && (FAILURE_CATEGORIES as readonly string[]).includes(answer.choice);
		if (client.fallbackCount() > before || !answer || !known || !accept(answer, "low")) return { value: deterministic, fallbackUsed: true };
		return { value: answer.choice as FailureCategory, fallbackUsed: false };
	} catch {
		return { value: deterministic, fallbackUsed: true };
	}
}

export async function retryUseful(options: {
	client?: JevSeam;
	history: readonly RetryRecord[];
	failure: FailureInput;
	strategy: string;
}): Promise<SiteAnswer<boolean>> {
	registerRetrySites();
	const client = options.client;
	if (!client) return { value: true, fallbackUsed: true };
	const before = client.fallbackCount();
	try {
		const [answer] = await client.ask(RETRY_SITE_ID, [RETRY_QUESTION], {
			history: options.history,
			failure: options.failure,
			strategy: options.strategy,
		});
		if (client.fallbackCount() > before || !answer || answer.kind !== "Score" || !accept(answer, "normal")) return { value: true, fallbackUsed: true };
		return { value: answer.score > RETRY_USEFULNESS_THRESHOLD, fallbackUsed: false };
	} catch {
		return { value: true, fallbackUsed: true };
	}
}
