/**
 * PRD-051: a vendor CLI pinned in `/model` is a model in Pi's own registry.
 *
 * Pi's loop can only run models its registry holds, so a CLI pin used to take the
 * turn away from it (`input` → `handled`) and the operator lost everything that
 * loop draws: the footer's model slot, the spinner, the transcript, Esc. Here the
 * CLI is a provider whose stream runs the vendor instead of an HTTP API, so a
 * Manual turn is an ordinary Pi turn on a different model.
 *
 * Once the vendor has a session the stream sends only the last user message: the
 * vendor keeps its own conversation through its session id (`claude --resume`
 * and equivalents). Its first turn carries the transcript so far, so a switch
 * mid-session keeps the context. It uses its own tools — Pi's tool declarations
 * are ignored.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Model, type Api, type TranscriptContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { BackendRef, LeanPiConfig } from "../core/types.js";
import { isModelRole } from "../core/types.js";
import { routePins, setRoutePins } from "../compiler/pins.js";
import type { CliRunFacts } from "./harness.js";
import { BackendRegistry, runWorkerTurn } from "./registry.js";
import type { SubscriptionState } from "./subscriptions.js";

/** The `api` Pi records on every message this provider produces. */
const CLI_API = "leanpi-cli";
/** Vendors do not report a window before the first run; Claude's standard one. */
const DEFAULT_CONTEXT_WINDOW = 200_000;
/**
 * A Manual turn is real work in the vendor's own agent loop, and Esc now stops
 * it, so the ceiling is a runaway guard, not the executor's 120s attempt budget.
 */
const TURN_TIMEOUT_MS = 60 * 60_000;

export interface CliProviderDeps {
	config: LeanPiConfig;
	cwd: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Pi's provider name for a CLI backend. Never the backend's own name: Pi ships
 * built-in `opencode` and `opencode-go` providers, and registering over one
 * would replace its models.
 */
export function cliProviderName(backend: string): string {
	return `${backend}-cli`;
}

/** Where Pi's registry holds a pin: CLI pins under their own provider name. */
export function piProviderFor(pin: BackendRef): string {
	return pin.type === "external_harness" ? cliProviderName(pin.backend) : pin.backend;
}

/** A model id a vendor resolved, with the window it reported. */
export interface LearnedModel {
	id: string;
	contextWindow?: number;
}

/** `<home>/.leanpi/model-ids.json`: what each model name asked of a vendor turned out to be. */
function learnedPath(env: NodeJS.ProcessEnv): string {
	return join(env.HOME ?? homedir(), ".leanpi", "model-ids.json");
}

/**
 * Names this machine has seen resolve — `opus` → `claude-opus-5-5` — keyed by
 * the name asked for and by the full id itself. Learned from real runs, never
 * guessed: the Claude CLI has no model-list command (`cli/allocate.ts`).
 */
export function learnedModels(env: NodeJS.ProcessEnv = process.env): Record<string, LearnedModel> {
	const path = learnedPath(env);
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, LearnedModel>) : {};
	} catch {
		// A corrupt cache only costs the full ids until the next run relearns them.
		return {};
	}
}

/**
 * The model a run was asked for, among the ones it used. A full id names itself;
 * an alias (`opus`, `opus[1m]`) is the one entry whose id carries it — never
 * simply the busiest entry, which a turn of helper subagents can out-write.
 */
export function resolvedModel(asked: string, models: CliRunFacts["models"]): CliRunFacts["models"][number] | undefined {
	const exact = models.find((entry) => entry.id === asked);
	if (exact) return exact;
	const alias = asked.replace(/\[[^\]]*\]$/, "");
	const matches = models.filter((entry) => entry.id.includes(alias));
	return matches.length === 1 ? matches[0] : undefined;
}

function learnModel(env: NodeJS.ProcessEnv, asked: string, ran: LearnedModel): void {
	const known = learnedModels(env);
	const before = JSON.stringify(known);
	// Only a name that is not already a full id is an alias to remember.
	if (asked !== ran.id) known[asked] = ran;
	known[ran.id] = ran;
	if (JSON.stringify(known) === before) return;
	const path = learnedPath(env);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(known, null, 2));
}

function messageText(message: TranscriptContext["messages"][number]): string {
	if (message.role !== "user" && message.role !== "assistant") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * The prompt argv carries — one argument, which Linux caps at 128 KiB — so the
 * carried transcript keeps its newest turns within this many characters.
 * ponytail: text turns only and a size cap; pipe the prompt through stdin if a
 * switch ever needs tool output or a longer history.
 */
const CARRIED_HISTORY_CHARS = 60_000;

/** The last user message, prefixed — on a vendor's first turn — with the conversation before it. */
function objectiveOf(context: TranscriptContext, resumed: boolean): string {
	const index = context.messages.findLastIndex((message) => message.role === "user");
	if (index < 0) return "";
	const last = messageText(context.messages[index]!);
	if (resumed) return last;
	let history = context.messages
		.slice(0, index)
		.map((message) => ({ role: message.role, text: messageText(message).trim() }))
		.filter((turn) => turn.text.length > 0)
		.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`)
		.join("\n\n");
	if (history.length === 0) return last;
	if (history.length > CARRIED_HISTORY_CHARS) history = `[earlier turns omitted]\n\n${history.slice(-CARRIED_HISTORY_CHARS)}`;
	return `The conversation so far (answered by another model):\n\n${history}\n\n---\n\n${last}`;
}

function streamCli(backend: string, deps: CliProviderDeps, model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
	const fail = (reason: "aborted" | "error", text: string): void => {
		message.stopReason = reason;
		message.errorMessage = text;
		stream.push({ type: "error", reason, error: message });
		stream.end(message);
	};
	void (async () => {
		// The registry is built per turn from the live config: `/model` may have
		// added this backend after activation. Every other backend is excluded so
		// the pin, not a role's chain, decides who answers.
		const registry = new BackendRegistry(deps.config);
		const exclude = registry.backends.filter((entry) => entry.name !== backend).map((entry) => entry.name);
		const sessionId = routePins().manualSessionId;
		stream.push({ type: "start", partial: message });
		try {
			const outcome = await runWorkerTurn(
				{ objective: objectiveOf(context, sessionId !== undefined), role: "balanced", model: model.id, ...(sessionId ? { sessionId } : {}) },
				{
					registry,
					cwd: deps.cwd,
					exclude,
					timeoutMs: TURN_TIMEOUT_MS,
					...(deps.env ? { env: deps.env } : {}),
					...(options?.signal ? { signal: options.signal } : {}),
				},
			);
			// A vendor that finished just as Esc landed still owns the conversation.
			if (outcome.result?.sessionId) setRoutePins({ manualSessionId: outcome.result.sessionId });
			if (options?.signal?.aborted) return fail("aborted", "aborted");
			if (outcome.status !== "completed" || !outcome.result) {
				return fail("error", outcome.attempts.map((attempt) => `${attempt.backend}: ${attempt.reason}`).join("; ") || `${backend} did not answer`);
			}
			const run = outcome.result.run;
			const ran = run ? resolvedModel(model.id, run.models) : undefined;
			if (ran) learnModel(deps.env ?? process.env, model.id, { id: ran.id, ...(ran.contextWindow ? { contextWindow: ran.contextWindow } : {}) });
			if (run?.usage) {
				// What the footer's context share is read from.
				const { input, output, cacheRead, cacheWrite } = run.usage;
				message.usage = { ...message.usage, input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite };
			}
			const text = outcome.result.summary;
			message.content = [{ type: "text", text }];
			stream.push({ type: "text_start", contentIndex: 0, partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
		} catch (error) {
			fail("error", error instanceof Error ? error.message : String(error));
		}
	})();
	return stream;
}

/**
 * Registers one or more model ids on a CLI backend's Pi provider.
 *
 * `registerProvider` replaces a provider's whole model list, so a backend's ids
 * must be registered together — a second call for the same backend would drop
 * the first call's models.
 */
export function registerCliModels(pi: Pick<ExtensionAPI, "registerProvider">, deps: CliProviderDeps, backend: string, ids: readonly string[]): void {
	if (ids.length === 0) return;
	pi.registerProvider(cliProviderName(backend), {
		name: `${backend} CLI`,
		baseUrl: "cli://local",
		// Pi will not select a model with no credential; the vendor CLI holds the
		// real one, so this literal never leaves the process.
		apiKey: "leanpi-cli",
		api: CLI_API,
		streamSimple: (model, context, options) => streamCli(backend, deps, model, context, options),
		models: ids.map((id) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: learnedModels(deps.env)[id]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: 32_000,
		})),
	});
}

/**
 * Registers the pinned CLI model with Pi. The config's own models for that
 * backend ride along, so a `/model` pick cannot replace and drop them — a
 * subagent planning on another subscription model still finds it.
 */
export function registerCliModel(pi: Pick<ExtensionAPI, "registerProvider">, deps: CliProviderDeps, pin: BackendRef): void {
	const ids = new Set<string>([pin.model]);
	for (const [role, entry] of Object.entries(deps.config.models)) {
		if (isModelRole(role) && entry && entry.backend === pin.backend) ids.add(entry.model);
	}
	registerCliModels(pi, deps, pin.backend, [...ids]);
}

/**
 * Registers every usable subscription backend's role models as Pi providers.
 *
 * A subscription role (`strong: claude/opus`) is `external_harness`, which
 * `registerBackends` deliberately leaves out of Pi's registry — so without this
 * the only `opus` a subagent planner can see is Pi's built-in *metered*
 * `opencode/claude-*`, and a task that asks for Opus silently leaves the
 * operator's Claude subscription unused. `states` is a cheap probe (no vendor
 * spawn), so an uninstalled or signed-out vendor is never offered.
 */
export function registerSubscriptionModels(
	pi: Pick<ExtensionAPI, "registerProvider">,
	deps: CliProviderDeps,
	states: readonly SubscriptionState[],
	extra: readonly BackendRef[] = [],
): void {
	const usable = new Set(states.filter((state) => state.onPath && state.signedIn).map((state) => state.backend));
	const idsByBackend = new Map<string, Set<string>>();
	const add = (backend: string, id: string, pinned = false): void => {
		const backendEntry = deps.config.backends[backend];
		if (backendEntry?.type !== "external_harness" || backendEntry.enabled === false) return;
		// A `/model` pin is the operator's deliberate choice, registered even when
		// the probe says the vendor is unavailable — the same as `registerCliModel`.
		if (!pinned && !usable.has(backend)) return;
		const ids = idsByBackend.get(backend) ?? new Set<string>();
		ids.add(id);
		idsByBackend.set(backend, ids);
	};
	for (const [role, entry] of Object.entries(deps.config.models)) {
		if (!isModelRole(role) || !entry) continue;
		add(entry.backend, entry.model);
	}
	// A restored `/model` pin on a subscription backend is a model too (PRD-051);
	// folded in here so registering the config's set cannot replace and drop it.
	for (const pin of extra) add(pin.backend, pin.model, true);
	for (const [backend, ids] of idsByBackend) registerCliModels(pi, deps, backend, [...ids]);
}
