/**
 * The escalation gate (PRD-007 Phase 4, ROADMAP §34).
 *
 * JEV may classify the escalation category; **application code performs the
 * escalation**. Every category that re-enters the attempt loop spends one unit
 * of the single `limits.execution_attempts` total, so no classification can
 * extend a turn — the termination proof does not depend on which ladder ran.
 */
import type { JevClient } from "../jev/client.js";
import { accept } from "../jev/confidence.js";
import { ensureSite } from "../jev/registry.js";
import type { JevQuestion, JevResult } from "../jev/types.js";
import type { ModelRole } from "../core/types.js";
import type { EscalationCategory } from "../routing/defaults.js";
import { stepRole } from "./retry.js";

export const ESCALATION_SITE_ID = "executor.escalation_reason";
export const CLARIFICATION_SITE_ID = "executor.user_clarification_need";

/** The eight §34 categories, as values; the type is owned by `routing/defaults.ts`. */
export const ESCALATION_CATEGORIES: readonly EscalationCategory[] = [
	"GET_MORE_CONTEXT",
	"ENABLE_CAPABILITY",
	"INCREASE_REASONING",
	"SWITCH_MODEL",
	"SWITCH_BACKEND",
	"STRONG_REVIEW",
	"USER_INPUT",
	"STOP_BLOCKED",
] as const;

export type { EscalationCategory };

export const ESCALATION_QUESTION: JevQuestion = {
	id: "escalation_category",
	kind: "Choice",
	text: "What is the blocking deficiency that the next attempt must address?",
	options: {
		GET_MORE_CONTEXT: "the executor lacks relevant context",
		ENABLE_CAPABILITY: "a capability it does not currently have is required",
		INCREASE_REASONING: "more reasoning effort on the same model is required",
		SWITCH_MODEL: "a stronger model is required",
		SWITCH_BACKEND: "a different backend is required",
		STRONG_REVIEW: "a strong review of the current state is required",
		USER_INPUT: "the request is ambiguous and guessing risks the wrong outcome",
		STOP_BLOCKED: "no further attempt is justified",
	},
};

export const CLARIFICATION_QUESTION: JevQuestion = {
	id: "clarify",
	kind: "Choice",
	text: "Is this ambiguity material enough that guessing risks the wrong outcome?",
	options: { ask: "ask the user", proceed: "proceed with the stated assumption" },
};

/** The deterministic ladder: one `SWITCH_MODEL`, then `STOP_BLOCKED` (§49). */
export function fallbackCategory(history: readonly { strategy: string }[]): EscalationCategory {
	return history.some((record) => record.strategy === "escalate") ? "STOP_BLOCKED" : "SWITCH_MODEL";
}

export function registerExecutorSites(): void {
	ensureSite({
		id: ESCALATION_SITE_ID,
		questions: [ESCALATION_QUESTION],
		returnType: ["Choice"],
		consequence: "normal",
		telemetryTag: ESCALATION_SITE_ID,
		fallback: (): JevResult[] => [{ kind: "Choice", questionId: ESCALATION_QUESTION.id, choice: "SWITCH_MODEL", probabilities: {}, confidence: 0 }],
	});
	ensureSite({
		id: CLARIFICATION_SITE_ID,
		questions: [CLARIFICATION_QUESTION],
		returnType: ["Choice"],
		consequence: "normal",
		telemetryTag: CLARIFICATION_SITE_ID,
		// The fallback does not ask: proceeding with a recorded assumption keeps the
		// turn moving, and a failed attempt still ends blocked.
		fallback: (): JevResult[] => [{ kind: "Choice", questionId: CLARIFICATION_QUESTION.id, choice: "proceed", probabilities: {}, confidence: 0 }],
	});
}

export interface EscalationInput {
	client?: Pick<JevClient, "ask" | "fallbackCount">;
	/** The compact failure history — never the transcript. */
	history: ReadonlyArray<{ strategy: string; failureSignature: string | null; model: string; backend: string }>;
	role: ModelRole;
	/** The compact last failure — kind and normalized detail, never a transcript. */
	failure?: { kind: string; detail: string };
}

export interface EscalationDecision {
	category: EscalationCategory;
	fallbackUsed: boolean;
}

export async function classifyEscalation({ client, history, role, failure }: EscalationInput): Promise<EscalationDecision> {
	registerExecutorSites();
	const deterministic = fallbackCategory(history);
	if (!client) return { category: deterministic, fallbackUsed: true };

	const before = client.fallbackCount();
	let results: JevResult[];
	try {
		results = await client.ask(ESCALATION_SITE_ID, [ESCALATION_QUESTION], { history, role, ...(failure ? { failure } : {}) });
	} catch {
		return { category: deterministic, fallbackUsed: true };
	}
	const [answer] = results;
	const known =
		answer?.kind === "Choice" && (ESCALATION_CATEGORIES as readonly string[]).includes(answer.choice);
	if (client.fallbackCount() > before || !answer || !known || !accept(answer, "normal")) {
		return { category: deterministic, fallbackUsed: true };
	}
	return { category: answer.choice as EscalationCategory, fallbackUsed: false };
}

/**
 * What a continuing category changes about the *next* invocation. The gate
 * cannot see the attempt that failed, so a directive names the change while the
 * lane supplies the attempt-specific detail — which files moved, what the
 * failure said, which backend's effort parameter is in play. A category whose
 * only effect was its own label would let the loop re-send the packet it just
 * failed on.
 */
export interface EscalationDirective {
	/** What the next attempt must do differently; the lane appends the failure detail. */
	instruction: string;
	/** Add the files the failed attempt changed to the next packet's `files`. */
	widenContext?: boolean;
	/** Raise the next packet's effort, under the backend's own `effort_param` name. */
	raiseEffort?: boolean;
	/** Run a strong review of the current state before the next attempt. */
	strongReview?: boolean;
	/** Name the tool set the next attempt may use. */
	nameTools?: boolean;
}

export interface EscalationAction {
	category: EscalationCategory;
	/** The role the next attempt runs on; unchanged for categories that keep it. */
	role: ModelRole;
	/** True when the action re-enters the attempt loop and therefore spends an attempt. */
	continues: boolean;
	/** Set for `SWITCH_BACKEND`: the backend that produced the last attempt, excluded next. */
	excludeBackend?: string;
	/** Set for the categories whose only lever is what the packet carries; `SWITCH_MODEL` and `SWITCH_BACKEND` change `role`/`excludeBackend` instead. */
	directive?: EscalationDirective;
	reason: string;
}

/**
 * Perform the classified action. `escalate` allocates nothing: it returns the
 * action, and the lane re-enters the loop through `nextAttempt`, which is where
 * the attempt and escalation counters move.
 */
export function escalate(category: EscalationCategory, context: { role: ModelRole; lastBackend?: string }): EscalationAction {
	switch (category) {
		case "SWITCH_MODEL":
			return { category, role: stepRole(context.role), continues: true, reason: "stepping the role ladder (FR-067)" };
		case "INCREASE_REASONING":
			return {
				category,
				role: context.role,
				continues: true,
				reason: "raising reasoning effort on the current role",
				directive: { instruction: "reason harder about the same change before answering", raiseEffort: true },
			};
		case "SWITCH_BACKEND":
			return {
				category,
				role: context.role,
				continues: true,
				...(context.lastBackend ? { excludeBackend: context.lastBackend } : {}),
				reason: "moving to the next enabled backend",
			};
		case "GET_MORE_CONTEXT":
			return {
				category,
				role: context.role,
				continues: true,
				reason: "widening the selected context",
				directive: { instruction: "the previous attempt lacked context it needed; use the widened files", widenContext: true },
			};
		case "ENABLE_CAPABILITY":
			return {
				category,
				role: context.role,
				continues: true,
				reason: "enabling one named capability",
				directive: { instruction: "use the capability the previous attempt lacked", nameTools: true },
			};
		case "STRONG_REVIEW":
			return {
				category,
				role: context.role,
				continues: true,
				reason: "handing off to a strong review",
				directive: { instruction: "act on the strong review's findings before retrying", strongReview: true },
			};
		case "USER_INPUT":
			return { category, role: context.role, continues: false, reason: "the request needs a user decision" };
		case "STOP_BLOCKED":
			return { category, role: context.role, continues: false, reason: "no further attempt is justified" };
	}
}

export interface ClarificationInput {
	client?: Pick<JevClient, "ask" | "fallbackCount">;
	objective: string;
	failure?: { kind: string; detail: string };
}

/** `true` only when JEV says the ambiguity is material; otherwise proceed. */
export async function needsClarification({ client, objective, failure }: ClarificationInput): Promise<boolean> {
	registerExecutorSites();
	if (!client) return false;
	const before = client.fallbackCount();
	try {
		const [answer] = await client.ask(CLARIFICATION_SITE_ID, [CLARIFICATION_QUESTION], { objective, ...(failure ? { failure } : {}) });
		if (client.fallbackCount() > before || !answer || answer.kind !== "Choice") return false;
		return answer.choice === "ask" && accept(answer, "normal");
	} catch {
		return false;
	}
}
