/**
 * Turn recap and session title (PRD-036).
 *
 * A long session leaves no answer to "what was I doing in this terminal?". The
 * answer is one sentence of intent — goal, state, next action — plus a title
 * that survives the session. Everything else the recap shows is data LeanPi
 * already holds: the deterministic half is `renderTurnOutcome`'s notify, and
 * this module adds only the sentence a model has to write.
 *
 * The model sees a fixed-shape brief (`brief.ts`), never the transcript, so a
 * long session costs the same as a short one. The call is one `runWorkerTurn`
 * packet — no tools, a two-turn ceiling, a 4s timeout — so its spend lands in the
 * same telemetry the user already reads with `/status`, rather than bypassing it
 * through a provider completion that records nothing.
 */
import type { BackendRef, LeanPiConfig, ModelRole } from "../core/types.js";
import { resolveRole } from "../core/roles.js";
import { BackendRegistry, runWorkerTurn } from "../backends/index.js";
import {
	appendRun,
	createRunCollector,
	feedInvocation,
	priceRun,
	resolveCostConfig,
	type RunCollector,
	type RunTelemetry,
} from "../telemetry/index.js";
import type { ExecutorClass } from "../compiler/contract.js";
import { messageText } from "../commands/context.js";
import { LEANPI_RECAP_WIDGET_KEY, recapWidget, type RecapWidgetHost } from "../cli/recap-widget.js";
import { buildRecapBrief } from "./brief.js";
import { parseRecapResponse } from "./parse.js";

/** Pi's custom-entry type for the persisted recap; outside the LLM context by contract. */
export const RECAP_ENTRY_TYPE = "leanpi:recap";

/** The persisted entry's schema version, so a future change can be read back. */
export const RECAP_VERSION = 1;

/** The whole call's ceiling: a recap that cannot answer in 4s is not worth a retry. */
export const RECAP_TIMEOUT_MS = 4_000;

/** The `input`/`agent_start`/`agent_settled` surface the controller needs from Pi. */
export interface RecapHost extends RecapWidgetHost {
	hasUI?: boolean;
	/** Where the persisted recap is read back from on `session_start`. */
	sessionManager?: { getBranch?(): readonly unknown[] };
}

/** Pi's extension surface the recap writes through: the title and the persisted entry. */
export interface RecapPi {
	setSessionName(name: string): void;
	getSessionName(): string | undefined;
	appendEntry(customType: string, data?: unknown): void;
}

/** One recap call, as the runner sees it. */
export interface RecapRequest {
	/** The assembled brief (`buildRecapBrief`), never the transcript. */
	brief: string;
	role: ModelRole;
	/** The concrete model the role resolved to, when one did. */
	model: string | undefined;
	timeoutMs: number;
}

/** Test seam: replaces the one-shot worker call; resolves the raw model text. */
export type RecapRunner = (request: RecapRequest) => Promise<string | undefined>;

export interface RecapTurnInput {
	/** This turn's ask: the user message that started it. */
	ask: string;
	/** What the turn did: `renderTurnOutcome` output, or the last assistant text. */
	did: string;
}

export interface RecapDeps {
	config: LeanPiConfig;
	cwd: string;
	sessionId: string;
	/** Pi's extension surface: the title and the persisted entry are written here. */
	pi: RecapPi;
	/** Test seam: replaces the real `runWorkerTurn` call. */
	run?: RecapRunner;
	/** The session's goal (its first user message); read from the Pi session when absent. */
	goal?: (ctx: RecapHost) => string | undefined;
	/** Titles of the todo items still open, read at call time. */
	openWork?: () => readonly string[];
}

/** Why `/recap` could not generate: each is a different truthful message. */
export type RecapUnavailableReason = "off" | "no_ui" | "no_role" | "superseded";

/**
 * What `/recap` asked for and what it got. `regenerate` reports *why* it could
 * not produce a sentence, so the command can distinguish a true no-turn from a
 * generation that failed or a recap that is off.
 */
export type RecapRegeneration =
	| { status: "ok"; recap: string }
	/** No current turn, so the newest successful recap was replayed from cache. */
	| { status: "cached"; recap: string }
	/** There was a turn to redo, but the call or its parse failed. */
	| { status: "failed" }
	| { status: "no_turn" }
	/** Automatic generation is off, the surface cannot draw, or no backend resolves the role. */
	| { status: "unavailable"; reason: RecapUnavailableReason };

export interface RecapController {
	/** Whether automatic generation is on for this session. */
	isEnabled(): boolean;
	/** `/recap on|off`: session-scoped, never written to config. */
	setEnabled(value: boolean): void;
	/** Generate, show and persist a recap for this turn. */
	recapTurn(ctx: RecapHost, input: RecapTurnInput): Promise<string | undefined>;
	/** `/recap`: regenerate from the last turn's ask and answer, through a live host. */
	regenerate(ctx: RecapHost): Promise<RecapRegeneration>;
	/** Re-display the newest persisted recap; no model call. */
	restore(ctx: RecapHost): void;
	/** New prompt: hide the widget and invalidate an in-flight call, keeping the last turn. */
	clear(ctx: RecapHost): void;
	/** Session boundary: hide the widget, drop the previous session's turn and cache, invalidate in-flight calls. */
	reset(ctx: RecapHost): void;
}

const EXECUTOR_CLASSES: readonly ExecutorClass[] = ["quick", "balanced", "strong", "specialist"];

/** The recap is a quick one-shot; a role outside the executor classes bills as `quick`. */
function executorClassOf(role: ModelRole): ExecutorClass {
	return EXECUTOR_CLASSES.includes(role as ExecutorClass) ? (role as ExecutorClass) : "quick";
}

/**
 * The recap's own telemetry row. A recap is not a turn, so it gets its own run
 * rather than being folded into one: `/status` sums the session's runs, and
 * without this the extra model call per turn would be invisible in the cost the
 * user reads. `calls` stays empty like the bench's synthetic rows — the priced
 * total is what the store aggregates.
 */
function emitRecapRun(
	config: LeanPiConfig,
	cwd: string,
	sessionId: string,
	role: ModelRole,
	collector: RunCollector,
	outcome: { status: "completed" | "blocked" },
): void {
	const calls = [...collector.calls()];
	if (calls.length === 0) return;
	const cost = resolveCostConfig(config);
	const usage = collector.usage();
	const execution = collector.execution();
	const backend = calls[0];
	const record: RunTelemetry = {
		task_id: collector.taskId,
		session_id: sessionId,
		route: { complexity: "LOW", executor_class: executorClassOf(role), reviewer_class: "none", reasoning: "low" },
		prd_used: null,
		executor_backend: backend.backend,
		executor_model: backend.model,
		reviewer_backend: null,
		reviewer_model: null,
		usage,
		cost: priceRun({ calls, usage, wallMs: execution.wall_ms }, cost),
		execution,
		result: { verification: "not_run", proof_gate: "not_run", reviewer: "not_run", success: outcome.status === "completed" },
		capabilities: { skills_disclosed: [], skills_used: [], mcps_disclosed: [], mcps_used: [] },
		jev_decisions: [],
		calls: [],
	};
	appendRun(cwd, record, cost);
}

/** The real one-shot call: a fresh pool, one packet, a 4s ceiling, no retries beyond the role chain. */
function defaultRunner(config: LeanPiConfig, cwd: string, sessionId: string): RecapRunner {
	return async ({ brief, role, model, timeoutMs }) => {
		const collector = createRunCollector({ taskId: `recap:${sessionId}`, sessionId });
		const registry = new BackendRegistry(config, { onInvocation: (record) => feedInvocation(collector, record) });
		const outcome = await runWorkerTurn(
			{
				objective: "Summarize this turn for the session recap.",
				role,
				prompt: brief,
				// No tools, one answer. `budget: 2`, not 1: `runNative` aborts at
				// `turn_end` when `turns >= budget` *and the session is still streaming*,
				// so a budget equal to the natural turn count kills the answer it just
				// produced and the outcome comes back `blocked`. With no tools the loop
				// is one turn, so 2 never trips.
				allowedTools: [],
				budget: 2,
				...(model === undefined ? {} : { model }),
			},
			{ registry, cwd, timeoutMs },
		);
		emitRecapRun(config, cwd, sessionId, role, collector, outcome);
		return outcome.status === "completed" ? outcome.result?.summary : undefined;
	};
}

/** The session's own name, or `undefined` when Pi has none set. */
function sessionNameOf(pi: RecapPi): string | undefined {
	const name = pi.getSessionName()?.trim() ?? "";
	return name.length === 0 ? undefined : name;
}

/**
 * The session's first user message, read from Pi's own session — never LeanPi's
 * `SessionManager`, which on the Pi-driven path holds none of the real session.
 */
function firstUserMessage(ctx: RecapHost): string | undefined {
	for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
		const message = (entry as { type?: unknown; message?: { role?: unknown } }).message;
		if ((entry as { type?: unknown }).type !== "message" || message?.role !== "user") continue;
		const text = messageText(message as never).trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

/** The optional `ask`/`did` the persisted recap entry carries alongside the sentence. */
function inputOf(data: { ask?: unknown; did?: unknown } | undefined): RecapTurnInput | undefined {
	const ask = data?.ask;
	const did = data?.did;
	if (typeof ask !== "string" || ask.trim().length === 0) return undefined;
	if (typeof did !== "string" || did.trim().length === 0) return undefined;
	return { ask, did };
}

/**
 * An assistant message that actually answered. `messageText` also renders
 * thinking and tool calls, so the content must carry a non-empty text block,
 * and a tool-use/progress/error/aborted stop is not a completed answer.
 */
export function isCompletedAssistant(message: unknown): boolean {
	const stop = (message as { stopReason?: unknown }).stopReason;
	if (stop === "toolUse" || stop === "error" || stop === "aborted" || stop === "pending" || stop === "deferred") return false;
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return content.some((part) => {
		const value = part as { type?: unknown; text?: unknown };
		return value.type === "text" && typeof value.text === "string" && value.text.trim().length > 0;
	});
}

/**
 * The newest completed user/assistant pair on the active branch: the assistant
 * answer that ends a turn and the user message that asked for it. A trailing
 * unanswered user message and a tool-only/progress/error assistant message are
 * skipped, never invented into a turn.
 */
function latestCompletedTurn(entries: readonly unknown[]): { input: RecapTurnInput; index: number } | undefined {
	let did: string | undefined;
	let answeredAt = -1;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: unknown; message?: unknown };
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown } | undefined;
		if (did === undefined) {
			if (message?.role !== "assistant" || !isCompletedAssistant(message)) continue;
			const text = messageText(message as never).trim();
			if (text.length > 0) {
				did = text;
				answeredAt = index;
			}
			continue;
		}
		if (message?.role !== "user") continue;
		const ask = messageText(message as never).trim();
		if (ask.length > 0) return { input: { ask, did }, index: answeredAt };
	}
	return undefined;
}

export function createRecap(deps: RecapDeps): RecapController {
	const config = deps.config;
	const pi = deps.pi;
	const run = deps.run ?? defaultRunner(config, deps.cwd, deps.sessionId);
	// Session-scoped, not module-scoped: a process that boots several sessions
	// (the bench boots one per task) must not inherit the previous one's state.
	let runId = 0;
	let enabled = config.recap.enabled;
	let titleSet = false;
	// The last turn's ask and answer, so `/recap` can regenerate without one.
	let lastTurn: RecapTurnInput | undefined;
	// The newest successful or restored recap. It is what `/recap` replays when
	// there is no current turn: a resume or a turn whose recap call failed must
	// still be able to show what the session was doing, without a model call.
	let cache: string | undefined;

	const show = (ctx: RecapHost, recap: string): void => {
		ctx.ui.setWidget?.(LEANPI_RECAP_WIDGET_KEY, recapWidget(recap, process.stdout.columns));
	};

	/** The internal outcome of one generation attempt; the public API maps it. */
	type TurnOutcome = { kind: "ok"; recap: string } | { kind: "failed" } | { kind: "skipped"; reason: RecapUnavailableReason };

	const turn = async (ctx: RecapHost, input: RecapTurnInput): Promise<TurnOutcome> => {
		// No generation at all when it is off, when there is nowhere to draw, or
		// when the role resolves to nothing — each is a reason not to spend, and
		// each names itself so the manual command can be truthful about which.
		if (!enabled) return { kind: "skipped", reason: "off" };
		if (ctx.hasUI === false) return { kind: "skipped", reason: "no_ui" };
		if (ctx.ui.setWidget === undefined) return { kind: "skipped", reason: "no_ui" };
		const role = config.recap.role;
		let ref: BackendRef;
		try {
			ref = resolveRole(config, role);
		} catch {
			return { kind: "skipped", reason: "no_role" };
		}
		// Bump before the await: a second call (or a cleared widget) makes this
		// one's answer stale, and a stale answer must not overwrite the screen.
		const current = ++runId;
		const wantTitle = !titleSet && sessionNameOf(pi) === undefined;
		const goal = deps.goal ? deps.goal(ctx) : firstUserMessage(ctx);
		const openWork = deps.openWork?.();
		const brief = buildRecapBrief({
			...(goal === undefined ? {} : { goal }),
			ask: input.ask,
			did: input.did,
			...(openWork === undefined ? {} : { openWork }),
			wantTitle,
		});
		let raw: string | undefined;
		try {
			raw = await run({ brief, role, model: ref.model, timeoutMs: RECAP_TIMEOUT_MS });
		} catch {
			// A failed call keeps the previous recap; the caller decides whether to
			// report it. The automatic path stays silent, `/recap` reports it.
			return { kind: "failed" };
		}
		if (current !== runId) return { kind: "skipped", reason: "superseded" };
		const parsed = raw === undefined ? undefined : parseRecapResponse(raw);
		if (parsed === undefined) return { kind: "failed" };
		show(ctx, parsed.recap);
		cache = parsed.recap;
		// The successful entry carries the turn it answered, so a resume can both
		// replay the sentence and know which turn produced it.
		pi.appendEntry(RECAP_ENTRY_TYPE, {
			version: RECAP_VERSION,
			ask: input.ask,
			did: input.did,
			recap: parsed.recap,
			...(parsed.title === undefined ? {} : { title: parsed.title }),
		});
		// The title is asked for once. A session that already has a name keeps it,
		// and the flag stops a regenerated first recap from renaming twice.
		if (wantTitle && parsed.title !== undefined) {
			titleSet = true;
			pi.setSessionName(parsed.title);
		}
		return { kind: "ok", recap: parsed.recap };
	};

	return {
		isEnabled: () => enabled,
		setEnabled: (value) => {
			enabled = value;
		},

		async recapTurn(ctx, input) {
			// Persist the turn's ask/did before any generation attempt: a recap
			// that is off, unavailable or failed must still leave the turn
			// recoverable on resume or by a later manual `/recap`. External
			// harness turns never enter Pi's transcript, so this entry is the
			// only durable record of them.
			lastTurn = input;
			pi.appendEntry(RECAP_ENTRY_TYPE, { version: RECAP_VERSION, ask: input.ask, did: input.did });
			const outcome = await turn(ctx, input);
			return outcome.kind === "ok" ? outcome.recap : undefined;
		},

		async regenerate(ctx) {
			// `/recap` never bypasses the off switch: with generation off there is
			// nothing to regenerate, cached or not.
			if (!enabled) return { status: "unavailable", reason: "off" };
			if (lastTurn !== undefined) {
				const outcome = await turn(ctx, lastTurn);
				if (outcome.kind === "ok") return { status: "ok", recap: outcome.recap };
				if (outcome.kind === "failed") return { status: "failed" };
				return { status: "unavailable", reason: outcome.reason };
			}
			// No current turn: replay the newest recap rather than spending on a
			// second generation of the same session state.
			if (cache !== undefined) {
				show(ctx, cache);
				return { status: "cached", recap: cache };
			}
			return { status: "no_turn" };
		},

		restore(ctx) {
			// A new session in the same activation may have no name: the previous
			// session's title flag must not stop it from ever being named.
			if (sessionNameOf(pi) === undefined) titleSet = false;
			// The active branch's ancestry, not every branch in the append-only log:
			// a newer recap on a sibling branch is not this branch's answer.
			const entries = ctx.sessionManager?.getBranch?.() ?? [];
			const completed = latestCompletedTurn(entries);
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				// Older saved entries cannot hide later completed native work.
				if (completed !== undefined && completed.index > index) break;
				const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
				if (entry.type !== "custom" || entry.customType !== RECAP_ENTRY_TYPE) continue;
				const data = entry.data as { recap?: unknown; ask?: unknown; did?: unknown } | undefined;
				const recap = data?.recap;
				if (typeof recap === "string" && recap.trim().length > 0) {
					show(ctx, recap);
					cache = recap;
					return;
				}
				const input = inputOf(data);
				if (input !== undefined) {
					// A newer input-only entry is a turn whose recap did not happen.
					// Seed the retry and stop: an older recap would answer for a turn
					// the session has already moved past.
					lastTurn = input;
					cache = undefined;
					return;
				}
			}
			// No saved entry newer than this completed native turn. Restore only
			// its input; a manual `/recap` generates the sentence.
			if (completed !== undefined) {
				lastTurn = completed.input;
				cache = undefined;
			}
		},

		clear(ctx) {
			// The bump is the invalidation: an in-flight call must not repaint a
			// widget the new turn has already cleared. The last turn and the cache
			// survive: this is a hide, not a session boundary.
			runId += 1;
			ctx.ui.setWidget?.(LEANPI_RECAP_WIDGET_KEY, undefined);
		},

		reset(ctx) {
			// A session boundary (`/new`, `/resume`, `/fork`): the previous
			// session's turn and cache must not answer for the next one, and its
			// in-flight generation must not repaint after the switch.
			runId += 1;
			lastTurn = undefined;
			cache = undefined;
			ctx.ui.setWidget?.(LEANPI_RECAP_WIDGET_KEY, undefined);
		},
	};
}
