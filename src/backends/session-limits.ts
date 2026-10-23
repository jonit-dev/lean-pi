/**
 * Session-scoped provider health.
 *
 * Pi's own loop owns the session model on a native config: LeanPi's executor
 * lane never runs there, so the worker registry's cooldown (PRD-008) never sees
 * the 402/429 that ends the turn. This is the missing memory — the failure a
 * turn reported, carried to the next turn so role resolution can walk
 * `ROLE_FALLBACK_CHAINS` past the backend that just refused.
 *
 * A user interrupt is not a provider failure. Pi reports a cancelled run as
 * `stopReason:"aborted"`; abort error text alone does not establish its cause.
 * Neither explicit cancellation nor an unclassified abort error marks a
 * provider limited.
 */

export type AssistantFailureKind = "limit" | "auth";

export interface AssistantFailure {
	kind: AssistantFailureKind;
	/** The provider's own words, kept for the notification. */
	reason: string;
}

/** A quota/credit refusal. `429` and `402` are the two providers in the logs use. */
const LIMIT = /\b(?:402|429)\b|insufficient (?:account )?funds|usage limit|rate[ -]?limit/i;
/** An auth/entitlement refusal: the backend is reachable but will not serve this key. */
const AUTH = /\b(?:401|403)\b|invalid api key|free tier/i;
/** Abort wording alone identifies neither cancellation nor a provider limit. */
const ABORT = /operation was aborted|request aborted|aborted by user/i;

/** What Pi's loop did with the turn: the loop's own outcome, apart from any gate. */
export type AssistantOutcome = "completed" | "aborted" | "error" | "toolUse" | "pending" | "deferred";

/**
 * The loop's outcome for an assistant message. Distinct from
 * `classifyAssistantFailure`, which names the provider fault: here a 429 is
 * just an `error`, and a cancelled run is `aborted`. The host's stopReason
 * carries cancellation provenance; the same error text can come from a provider.
 */
export function assistantOutcome(message: { stopReason?: unknown; errorMessage?: unknown }): AssistantOutcome {
	const stop = message.stopReason;
	if (stop === "aborted") return "aborted";
	if (stop === "error") return "error";
	if (stop === "toolUse" || stop === "pending" || stop === "deferred") return stop;
	return "completed";
}

/**
 * The provider failure an assistant message reports, or null. Only `error`
 * messages qualify — a `stop` or `toolUse` turn is not a failure, and an
 * interrupt is the operator's, not the provider's.
 */
export function classifyAssistantFailure(message: { stopReason?: unknown; errorMessage?: unknown }): AssistantFailure | null {
	const text = typeof message.errorMessage === "string" ? message.errorMessage : "";
	if (message.stopReason === "aborted" || ABORT.test(text)) return null;
	if (message.stopReason !== "error") return null;
	if (LIMIT.test(text)) return { kind: "limit", reason: text.trim() };
	if (AUTH.test(text)) return { kind: "auth", reason: text.trim() };
	return null;
}

export interface SessionLimitsOptions {
	cooldownMs?: number;
	now?: () => number;
}

/** The default cooldown: long enough to skip a burst of prompts, short enough that a 5-hour window recovers. */
export const DEFAULT_LIMIT_COOLDOWN_MS = 5 * 60_000;

/** Backends that refused this session, and until when. */
export class SessionLimits {
	private readonly until = new Map<string, number>();
	private readonly cooldownMs: number;
	private readonly now: () => number;

	constructor(options: SessionLimitsOptions = {}) {
		this.cooldownMs = options.cooldownMs ?? DEFAULT_LIMIT_COOLDOWN_MS;
		this.now = options.now ?? Date.now;
	}

	/** The backend failed with a limit; keep it out of selection for the cooldown. */
	mark(backend: string): void {
		this.until.set(backend, this.now() + this.cooldownMs);
	}

	isLimited(backend: string): boolean {
		const until = this.until.get(backend);
		if (until === undefined) return false;
		if (until <= this.now()) {
			this.until.delete(backend);
			return false;
		}
		return true;
	}

	clear(): void {
		this.until.clear();
	}
}
