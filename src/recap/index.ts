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
	sessionManager?: { getEntries?(): readonly unknown[] };
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

export interface RecapController {
	/** Whether automatic generation is on for this session. */
	isEnabled(): boolean;
	/** `/recap on|off`: session-scoped, never written to config. */
	setEnabled(value: boolean): void;
	/** Generate, show and persist a recap for this turn. */
	recapTurn(ctx: RecapHost, input: RecapTurnInput): Promise<string | undefined>;
	/** `/recap`: regenerate from the last turn's ask and answer, through a live host. */
	regenerate(ctx: RecapHost): Promise<string | undefined>;
	/** Re-display the newest persisted recap; no model call. */
	restore(ctx: RecapHost): void;
	/** Clear the widget and invalidate any in-flight call. */
	clear(ctx: RecapHost): void;
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
	for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
		const message = (entry as { type?: unknown; message?: { role?: unknown } }).message;
		if ((entry as { type?: unknown }).type !== "message" || message?.role !== "user") continue;
		const text = messageText(message as never).trim();
		if (text.length > 0) return text;
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

	const show = (ctx: RecapHost, recap: string): void => {
		ctx.ui.setWidget?.(LEANPI_RECAP_WIDGET_KEY, recapWidget(recap, process.stdout.columns));
	};

	const turn = async (ctx: RecapHost, input: RecapTurnInput): Promise<string | undefined> => {
		// No generation at all when it is off, when there is nowhere to draw, or
		// when the role resolves to nothing — each is a reason not to spend.
		if (!enabled) return undefined;
		if (ctx.hasUI === false) return undefined;
		if (ctx.ui.setWidget === undefined) return undefined;
		const role = config.recap.role;
		let ref: BackendRef;
		try {
			ref = resolveRole(config, role);
		} catch {
			return undefined;
		}
		// Bump before the await: a second call (or a cleared widget) makes this
		// one's answer stale, and a stale answer must not overwrite the screen.
		const current = ++runId;
		lastTurn = input;
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
			// A failed call is skipped silently and the previous recap kept.
			return undefined;
		}
		if (current !== runId) return undefined;
		const parsed = raw === undefined ? undefined : parseRecapResponse(raw);
		if (parsed === undefined) return undefined;
		show(ctx, parsed.recap);
		pi.appendEntry(RECAP_ENTRY_TYPE, { version: RECAP_VERSION, recap: parsed.recap, ...(parsed.title === undefined ? {} : { title: parsed.title }) });
		// The title is asked for once. A session that already has a name keeps it,
		// and the flag stops a regenerated first recap from renaming twice.
		if (wantTitle && parsed.title !== undefined) {
			titleSet = true;
			pi.setSessionName(parsed.title);
		}
		return parsed.recap;
	};

	return {
		isEnabled: () => enabled,
		setEnabled: (value) => {
			enabled = value;
		},

		recapTurn: turn,

		async regenerate(ctx) {
			if (lastTurn === undefined) return undefined;
			return turn(ctx, lastTurn);
		},

		restore(ctx) {
			// A new session in the same activation may have no name: the previous
			// session's title flag must not stop it from ever being named.
			if (sessionNameOf(pi) === undefined) titleSet = false;
			const entries = ctx.sessionManager?.getEntries?.() ?? [];
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
				if (entry.type !== "custom" || entry.customType !== RECAP_ENTRY_TYPE) continue;
				const recap = (entry.data as { recap?: unknown } | undefined)?.recap;
				if (typeof recap === "string" && recap.trim().length > 0) {
					show(ctx, recap);
					return;
				}
			}
		},

		clear(ctx) {
			// The bump is the invalidation: an in-flight call must not repaint a
			// widget the new turn has already cleared.
			runId += 1;
			ctx.ui.setWidget?.(LEANPI_RECAP_WIDGET_KEY, undefined);
		},
	};
}
