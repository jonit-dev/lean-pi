/**
 * The run accumulator (PRD-015 Phase 1).
 *
 * Created at run start, fed by whoever observes a fact: a backend reports its
 * call usage (PRD-008's `BackendInvocation` sink), the executor's tool layer
 * bumps `tool_calls`/`file_reads`, the retry loop bumps `retries`/`escalations`,
 * the context engine bumps `compactions`, and PRD-002's resolved decisions are
 * projected as `jev_decisions[]` rows. A plain closure with bumps — no event
 * bus, no observer registry.
 *
 * Usage accumulates across *every* attempt of a run, so retry cost is already
 * inside `api_usd`; `retries` only records how many there were.
 */
import type { BackendInvocation, Billing } from "../backends/worker.js";
import type { DecisionLog, DecisionRow } from "../jev/log.js";
import type { SiteTelemetryRow } from "../compiler/contract.js";
import type { BackendType, ModelRole } from "../core/types.js";
import type { JevAnswer, JevDecisionRow, RunExecution, RunUsage } from "./record.js";

/** Tokens a single backend call consumed. Only the breakdown a backend can report. */
export interface CallUsage {
	/** Non-cached input tokens. */
	inputTokens?: number;
	cachedInputTokens?: number;
	/**
	 * Input tokens written into the provider's prompt cache. A separate rate on
	 * every vendor's card (Anthropic reports it as its own `cacheWrite` field),
	 * so it cannot be folded into `cachedInputTokens` without mispricing it.
	 */
	cacheWriteTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
	/** Coarse total when no breakdown exists (PRD-008's `BackendInvocation.tokens`). */
	tokens?: number;
	/** Requests drawn from a subscription pool by this call. */
	subscriptionUsage?: number;
}

/** The identity of the worker a call ran on (PRD-008). */
export interface BackendCall {
	backend: string;
	model: string;
	/** §25's discriminant: `native` (LeanPi owns the loop) or `external_harness`. */
	type: BackendType;
	role: ModelRole;
	/** FR-055's billing class; defaults from `type` when the caller omits it. */
	billing?: Billing;
	quotaClass?: string;
	usage: CallUsage;
	/** ISO timestamp of the call; defaults to now. */
	timestamp?: string;
	exitCode?: number | null;
}

/** Either PRD-004's per-site telemetry row or PRD-002's decision-log row. */
export type JevDecisionInput = SiteTelemetryRow | DecisionRow;

export interface RunCollector {
	readonly taskId: string;
	readonly sessionId: string;
	/** One model/backend call; folds its usage into the run totals. */
	add(call: BackendCall): void;
	/** One row per site invocation reported by PRD-002; Σ tokens becomes `usage.jev_tokens`. */
	recordJevDecision(row: JevDecisionInput): void;
	/** Explicit wall time; a run that never reports it falls back to elapsed time. */
	addWallMs(ms: number): void;
	addLocalGpuSeconds(seconds: number): void;
	noteToolCall(count?: number): void;
	/** Counts the read, and a repeated read of a path already read in this run. */
	noteFileRead(path: string): void;
	noteRetry(count?: number): void;
	noteEscalation(count?: number): void;
	noteCompaction(count?: number): void;
	/** Observed use, against the contract's disclosed set (ROADMAP §56). */
	useSkill(name: string): void;
	useMcp(name: string): void;
	usage(): RunUsage;
	execution(): RunExecution;
	calls(): readonly BackendCall[];
	decisions(): readonly JevDecisionRow[];
	usedSkills(): readonly string[];
	usedMcps(): readonly string[];
	/** True exactly once: the run has already written its record (emission is idempotent). */
	markEmitted(): boolean;
	emitted(): boolean;
}

const EXECUTOR_ROLES: Record<string, true> = { quick: true, balanced: true, strong: true, specialist: true };
const REVIEWER_ROLES: Record<string, true> = { review_quick: true, review_strong: true };

/**
 * PRD-008's invocation record as PRD-015's call row. The registry reports what
 * the run actually spent — one record per attempt, success or failure — and this
 * is the only place that projection lives, so a caller cannot restate it.
 */
export function callOfInvocation(record: BackendInvocation): BackendCall {
	return {
		backend: record.backend,
		model: record.model ?? record.catalogModelId ?? record.backend,
		// `billingOf` derives the billing class from the backend's own type, so the
		// reverse is exact: a subscription call is an external harness, everything
		// else runs in LeanPi's own loop.
		type: record.billing === "subscription" ? "external_harness" : "native",
		role: record.role,
		billing: record.billing,
		...(record.quotaClass ? { quotaClass: record.quotaClass } : {}),
		usage: record.usage ?? (record.tokens === undefined ? {} : { tokens: record.tokens }),
	};
}

/** Feet one invocation into the run's accumulator: the call, and its wall time. */
export function feedInvocation(collector: RunCollector, record: BackendInvocation): void {
	collector.add(callOfInvocation(record));
	collector.addWallMs(record.wallMs);
}

/**
 * The `AssistantMessage` fields this projection reads (`@earendil-works/pi-ai`).
 * `provider`/`model` stay `unknown`: a restored session line is JSON, so the
 * identity is checked before it becomes a rate-card key.
 */
interface UsageMessage {
	provider?: unknown;
	model?: unknown;
	usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; reasoning?: number };
	content?: unknown;
}

/**
 * Pi's own loop as PRD-015 calls: one call per message that carried usage, plus
 * the tool calls those messages asked for.
 *
 * When Pi owns the loop nothing feeds the run's collector while the turn runs —
 * the extension sees the loop's messages, not the provider's responses — so this
 * projection is how that path's spend (and its tool count) reaches the record.
 */
export function callsFromMessages(
	messages: readonly unknown[],
	ref: { backend: string; model: string },
): { calls: BackendCall[]; toolCalls: number } {
	const calls: BackendCall[] = [];
	let toolCalls = 0;
	for (const message of messages) {
		// Pi's own `AgentMessage`, which this signature took as `unknown[]` before
		// there was a Pi type to import; the field reads below check what they use.
		const assistant = message as UsageMessage;
		const usage = assistant.usage;
		if (usage) {
			calls.push({
				// Pi stamps every assistant message with the provider and model that
				// served it, and `registerProvider(name, …)` registers each backend
				// under its own name, so a message's `provider` *is* the backend name
				// and `model` is the key the rate card is written against. `ref` is
				// captured once at turn start: reading it for every message bills a
				// turn that switched models entirely to whatever was bound first, so
				// the message's own identity wins and `ref` is only the fallback for a
				// message that carries none.
				backend: typeof assistant.provider === "string" && assistant.provider.length > 0 ? assistant.provider : ref.backend,
				model: typeof assistant.model === "string" && assistant.model.length > 0 ? assistant.model : ref.model,
				type: "native",
				role: "balanced",
				usage: {
					inputTokens: usage.input ?? 0,
					cachedInputTokens: usage.cacheRead ?? 0,
					cacheWriteTokens: usage.cacheWrite ?? 0,
					// pi-ai documents `Usage.reasoning` as a subset of `Usage.output`
					// while `priceCall` bills `reasoningTokens` on top of `outputTokens`,
					// so this row carries the non-reasoning remainder — the same split
					// `bench/adapters.ts` makes for its synthetic call. Passing Pi's
					// `output` whole charged every reasoning token twice.
					outputTokens: Math.max(0, (usage.output ?? 0) - (usage.reasoning ?? 0)),
					reasoningTokens: usage.reasoning ?? 0,
				},
			});
		}
		const content = assistant.content;
		if (Array.isArray(content)) {
			for (const part of content) if (part !== null && typeof part === "object" && "type" in part && part.type === "toolCall") toolCalls += 1;
		}
	}
	return { calls, toolCalls };
}

/** The executor/reviewer a run actually billed, read off its calls rather than restated. */
export function billedRefs(
	calls: readonly BackendCall[],
): { executor: BackendCall | null; reviewer: BackendCall | null } {
	const lastOf = (roles: Record<string, true>): BackendCall | null => {
		const matching = calls.filter((call) => roles[call.role] === true);
		return matching.length > 0 ? (matching[matching.length - 1] as BackendCall) : null;
	};
	return { executor: lastOf(EXECUTOR_ROLES), reviewer: lastOf(REVIEWER_ROLES) };
}

/** FR-055's class for a call; a caller that omits it gets the §25 discriminant's default. */
export function billingOf(call: BackendCall): Billing {
	if (call.billing) return call.billing;
	return call.type === "external_harness" ? "subscription" : "metered";
}

function answerOf(row: DecisionRow): JevAnswer {
	const values: Array<string | number | null> = row.answers.map((answer) => answer.value);
	if (values.length === 0) return null;
	return values.length === 1 ? (values[0] as string | number | null) : values;
}

/** Project a decision-log row or a compiler telemetry row into the record's row shape. */
export function projectJevDecision(row: JevDecisionInput): JevDecisionRow {
	if ("siteId" in row) {
		return {
			site_id: row.siteId,
			answer: answerOf(row),
			confidence: row.confidence,
			fallback_used: row.fallbackUsed,
			tokens: row.tokens.inputTokens + row.tokens.outputTokens,
		};
	}
	return {
		site_id: row.site_id,
		answer: row.answer,
		confidence: row.confidence,
		fallback_used: row.fallback_used,
		tokens: row.tokens.inputTokens + row.tokens.outputTokens,
	};
}

export function createRunCollector(init: { taskId: string; sessionId: string }): RunCollector {
	const startedMs = Date.now();
	const totals: RunUsage = {
		input_tokens: 0,
		cached_input_tokens: 0,
		output_tokens: 0,
		reasoning_tokens: 0,
		jev_tokens: 0,
		local_gpu_seconds: 0,
		external_harness_calls: 0,
		subscription_usage: 0,
	};
	const counters: RunExecution = {
		wall_ms: 0,
		tool_calls: 0,
		file_reads: 0,
		repeated_reads: 0,
		retries: 0,
		escalations: 0,
		compactions: 0,
	};
	const callList: BackendCall[] = [];
	const decisionRows: JevDecisionRow[] = [];
	const readPaths = new Set<string>();
	const skillsUsed = new Set<string>();
	const mcpsUsed = new Set<string>();
	let explicitWallMs = 0;
	let emitted = false;

	return {
		taskId: init.taskId,
		sessionId: init.sessionId,
		add(call) {
			callList.push(call);
			const usage = call.usage;
			// A coarse total has no bucket of its own, so it lands in non-cached input
			// rather than being dropped; every richer field is reported by the backend.
			totals.input_tokens += usage.inputTokens ?? usage.tokens ?? 0;
			totals.cached_input_tokens += usage.cachedInputTokens ?? 0;
			totals.output_tokens += usage.outputTokens ?? 0;
			totals.reasoning_tokens += usage.reasoningTokens ?? 0;
			totals.subscription_usage += usage.subscriptionUsage ?? (billingOf(call) === "subscription" ? 1 : 0);
			if (call.type === "external_harness") totals.external_harness_calls += 1;
		},
		recordJevDecision(row) {
			const projected = projectJevDecision(row);
			decisionRows.push(projected);
			totals.jev_tokens += projected.tokens;
		},
		addWallMs(ms) {
			explicitWallMs += ms;
		},
		addLocalGpuSeconds(seconds) {
			totals.local_gpu_seconds += seconds;
		},
		noteToolCall(count = 1) {
			counters.tool_calls += count;
		},
		noteFileRead(path) {
			counters.file_reads += 1;
			if (readPaths.has(path)) counters.repeated_reads += 1;
			else readPaths.add(path);
		},
		noteRetry(count = 1) {
			counters.retries += count;
		},
		noteEscalation(count = 1) {
			counters.escalations += count;
		},
		noteCompaction(count = 1) {
			counters.compactions += count;
		},
		useSkill(name) {
			skillsUsed.add(name);
		},
		useMcp(name) {
			mcpsUsed.add(name);
		},
		usage: () => ({ ...totals }),
		execution: () => ({ ...counters, wall_ms: explicitWallMs > 0 ? explicitWallMs : Date.now() - startedMs }),
		calls: () => callList,
		decisions: () => decisionRows,
		usedSkills: () => [...skillsUsed],
		usedMcps: () => [...mcpsUsed],
		markEmitted() {
			if (emitted) return false;
			emitted = true;
			return true;
		},
		emitted: () => emitted,
	};
}

/**
 * The decision ledger, wired to whichever run is in flight.
 *
 * Every JEV site appends its row to the ledger, and `recordJevDecision` was
 * called from the bench harness and nowhere else — so a real session wrote
 * `.leanpi/decisions.jsonl` beside a run record that said `jev_tokens: 0`. On
 * the audited session that hid 292k tokens of control-plane spend from `/cost`
 * and from the goal budget that reads it. Decorating the log bills both from the
 * same write, so the record and the ledger cannot drift apart.
 *
 * The collector is resolved per append, not captured: one log serves the whole
 * session and the run it belongs to changes every turn.
 */
export function billingDecisionLog(log: DecisionLog, collector: () => RunCollector | undefined): DecisionLog {
	return {
		...log,
		append(row) {
			log.append(row);
			collector()?.recordJevDecision(row);
		},
	};
}
