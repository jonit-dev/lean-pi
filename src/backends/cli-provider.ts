/**
 * PRD-051: a vendor CLI pinned in `/model` is a model in Pi's own registry.
 *
 * Pi's loop can only run models its registry holds, so a CLI pin used to take the
 * turn away from it (`input` → `handled`) and the operator lost everything that
 * loop draws: the footer's model slot, the spinner, the transcript, Esc. Here the
 * CLI is a provider whose stream runs the vendor instead of an HTTP API, so a
 * Manual turn is an ordinary Pi turn on a different model.
 *
 * The stream answers the transcript's last user message and nothing else: the
 * vendor keeps its own conversation through its session id (`claude --resume`
 * and equivalents), and uses its own tools — Pi's tool declarations are ignored.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Model, type Api, type TranscriptContext, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { BackendRef, LeanPiConfig } from "../core/types.js";
import { routePins, setRoutePins } from "../compiler/pins.js";
import type { CliRunFacts } from "./harness.js";
import { BackendRegistry, runWorkerTurn } from "./registry.js";

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

function lastUserText(context: TranscriptContext): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	}
	return "";
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
				{ objective: lastUserText(context), role: "balanced", model: model.id, ...(sessionId ? { sessionId } : {}) },
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
 * Registers the pinned CLI model with Pi, replacing that provider's previous
 * model: a pin is one model at a time. The caller then `setModel`s it.
 */
export function registerCliModel(pi: Pick<ExtensionAPI, "registerProvider">, deps: CliProviderDeps, pin: BackendRef): void {
	pi.registerProvider(cliProviderName(pin.backend), {
		name: `${pin.backend} CLI`,
		baseUrl: "cli://local",
		// Pi will not select a model with no credential; the vendor CLI holds the
		// real one, so this literal never leaves the process.
		apiKey: "leanpi-cli",
		api: CLI_API,
		streamSimple: (model, context, options) => streamCli(pin.backend, deps, model, context, options),
		models: [
			{
				id: pin.model,
				name: pin.model,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: learnedModels(deps.env)[pin.model]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
				maxTokens: 32_000,
			},
		],
	});
}
