/**
 * The goal pairing and the one decision site (PRD-025 Phases 3–4, ROADMAP §42/§43).
 *
 * `remainingWork()` is a pure function over the list — no evidence reads, no gate
 * calls, no session access — because everything it needs was decided by the
 * transitions. PRD-013 owns every stop condition; this module hands it a
 * predicate and a blocker list and nothing else:
 *
 * - non-empty `actionable` → useful work remains, the engine continues;
 * - empty `actionable` with a non-empty `blocked` → the engine returns `BLOCKED`
 *   naming those `blockedReason`s;
 * - both empty → no signal from the list, so the engine's own evaluation runs
 *   and a drained list reaches `GOAL_MET` through its existing path.
 */
import type { ExecutionComplexity } from "../compiler/contract.js";
import type { JevClient } from "../jev/client.js";
import { accept } from "../jev/confidence.js";
import { ensureSite } from "../jev/registry.js";
import type { ChoiceQuestion, JevQuestion, JevResult } from "../jev/types.js";
import { remainingWork, type RemainingWork, type TodoItem } from "./state.js";

export { remainingWork } from "./state.js";
export type { RemainingWork } from "./state.js";

/** What PRD-013's boundary needs: whether to continue, and who is blocking. */
export interface BoundaryTodoInput {
	usefulWorkRemains: boolean;
	blockers: string[];
}

export function boundaryTodoInput(list: readonly TodoItem[]): BoundaryTodoInput {
	const { actionable, blocked } = remainingWork(list);
	return {
		usefulWorkRemains: actionable.length > 0,
		blockers: blocked.map((item) => `${item.id}: ${item.blockedReason ?? "unspecified"}`),
	};
}

export const TODO_NEEDED_SITE_ID = "todo.needed";
export const TODO_NEEDED_QUESTION_ID = "todo_needed";

/** Consequence `low`, which is also the site's registered class: a wrong answer costs convenience, never a verdict. */
export const TODO_NEEDED_QUESTION: ChoiceQuestion = {
	id: TODO_NEEDED_QUESTION_ID,
	kind: "Choice",
	text: "Does <request> require several distinct, separately verifiable steps?",
	options: { yes: "several distinct steps must each be verified", no: "one step, or steps that cannot be verified separately" },
};

export interface TodoNeededInput {
	request: string;
	complexity: ExecutionComplexity;
	/** A PRD is active, so the list is derived and warranted regardless of complexity. */
	prdActive: boolean;
}

/** §49 fallback: the contract's complexity, or an active PRD, decides — never a model call. */
export function todoNeededFallback(input: TodoNeededInput): boolean {
	return input.prdActive || input.complexity === "MEDIUM" || input.complexity === "HIGH";
}

export interface TodoNeededDecision {
	needed: boolean;
	fallbackUsed: boolean;
	reason: string;
}

/**
 * Register `todo.needed`. Idempotent, and the fallback is non-null and
 * deterministic (§49): PRD-002's log, PRD-015's telemetry and PRD-016's `/route`
 * pick the site up with no further work here.
 */
export function registerTodoSites(): void {
	ensureSite({
		id: TODO_NEEDED_SITE_ID,
		questions: [TODO_NEEDED_QUESTION],
		returnType: ["Choice"],
		consequence: "low",
		telemetryTag: TODO_NEEDED_SITE_ID,
		fallback: ({ state }): JevResult[] => {
			const input = state as Partial<TodoNeededInput>;
			const needed = todoNeededFallback({
				request: typeof input.request === "string" ? input.request : "",
				complexity: (input.complexity ?? "LOW") as ExecutionComplexity,
				prdActive: input.prdActive === true,
			});
			return [{ kind: "Choice", questionId: TODO_NEEDED_QUESTION_ID, choice: needed ? "yes" : "no", probabilities: {}, confidence: 0 }];
		},
	});
}

/**
 * Ask the site. Even with JEV disabled the call goes through the client so the
 * decision log carries the row (`fallback_used: true`); there is no second code
 * path that could drift from the registered fallback.
 */
export async function decideTodoNeeded(
	input: TodoNeededInput,
	client?: Pick<JevClient, "ask" | "fallbackCount">,
): Promise<TodoNeededDecision> {
	registerTodoSites();
	const fallback = todoNeededFallback(input);
	if (!client) return { needed: fallback, fallbackUsed: true, reason: "no JEV client; deterministic fallback" };

	const before = client.fallbackCount();
	let results: JevResult[] | undefined;
	try {
		results = await client.ask(TODO_NEEDED_SITE_ID, [TODO_NEEDED_QUESTION] as JevQuestion[], {
			request: input.request,
			complexity: input.complexity,
			prdActive: input.prdActive,
		});
	} catch {
		results = undefined;
	}
	if (results === undefined || client.fallbackCount() > before) {
		return { needed: fallback, fallbackUsed: true, reason: "JEV disabled or unreachable; deterministic fallback" };
	}
	const answer = results.find((result) => result.questionId === TODO_NEEDED_QUESTION_ID);
	if (answer?.kind !== "Choice" || !accept(answer, "low") || (answer.choice !== "yes" && answer.choice !== "no")) {
		return { needed: fallback, fallbackUsed: true, reason: "no usable answer above the low-consequence floor" };
	}
	return { needed: answer.choice === "yes", fallbackUsed: false, reason: "JEV answered" };
}
