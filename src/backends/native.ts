/**
 * The native model backend (PRD-008 Phase 2, ROADMAP §23).
 *
 * LeanPi owns the Pi agent loop here — model turn, tool call, model turn — over
 * the configured provider (a metered API, a Pi custom provider or a local
 * server). The result is the same `WorkerResult` an external harness returns, so
 * the executor never branches on `type`; a provider error is a typed failure,
 * never a throw that unwinds the turn.
 */
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { apiKeyFor } from "../core/config.js";
import { BASELINE_TOOL_NAMES, registerBaselineTools } from "../core/tools.js";
import { changeSnapshot, changedPathsSince } from "../runtime/git.js";
import type { RegisteredBackend } from "./registry.js";
import { modelFor, type WorkerOutcome, type WorkerTaskPacket } from "./worker.js";

/** Default loop ceiling when the packet carries no budget. */
export const DEFAULT_NATIVE_BUDGET = 8;

export interface RunNativeDeps {
	cwd: string;
	agentDir?: string;
	/** Wall-clock ceiling for the whole loop; absent means no ceiling. */
	timeoutMs?: number;
	/** Environment the provider credential is resolved from; `process.env` when absent. */
	env?: NodeJS.ProcessEnv;
}

/** Why a native loop stopped. The order of the checks is the priority order. */
export type NativeStop = "provider_failure" | "deadline" | "budget" | "completed";

/**
 * How a stopped loop is classified.
 *
 * A provider error is a failure *even when the loop already emitted text and
 * changed files*: a partial turn is not a completed attempt, and treating it as
 * one is how a silent failure becomes a claimed success. That is why the
 * transcript plays no part in this decision. A stop we caused ourselves — the
 * wall-clock ceiling, the turn budget — is reported as such, because those
 * aborts surface as an error message too and "the provider failed" would send
 * the registry off to another backend for no reason.
 */
export function nativeStop(facts: { promptError: boolean; providerError: boolean; timedOut: boolean; exceeded: boolean }): NativeStop {
	if (facts.promptError) return "provider_failure";
	if (facts.timedOut) return "deadline";
	if (facts.exceeded) return "budget";
	return facts.providerError ? "provider_failure" : "completed";
}

interface TranscriptEntry {
	role?: string;
	content?: unknown;
	errorMessage?: string;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type?: string; text?: string } => part !== null && typeof part === "object")
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n")
		.trim();
}

function lastAssistantText(messages: readonly TranscriptEntry[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as TranscriptEntry;
		if (message.role !== "assistant") continue;
		const text = textOf(message.content);
		if (text.length > 0) return text;
	}
	return "";
}

/**
 * Run the Pi agent loop for one bounded packet. The packet's budget is a hard
 * stopping condition: the loop is aborted once the model exceeds it, and the
 * result is reported blocked rather than as a completed change.
 */
export async function runNative(backend: RegisteredBackend, packet: WorkerTaskPacket, deps: RunNativeDeps): Promise<WorkerOutcome> {
	const modelId = packet.model ?? modelFor(backend, packet.role);
	if (!modelId) {
		return { status: "failed", failure: "model", reason: `backend "${backend.name}" declares no model for role "${packet.role}"` };
	}
	const before = changeSnapshot(deps.cwd);
	/** The turn's own change set from worktree state; unknown when git cannot answer. */
	const changeFields = (): { changedFiles: string[]; changedFilesUnknown?: boolean } => {
		const paths = before === null ? null : changedPathsSince(before, deps.cwd);
		return paths === null ? { changedFiles: [], changedFilesUnknown: true } : { changedFiles: paths };
	};
	const budget = packet.budget ?? DEFAULT_NATIVE_BUDGET;

	let services;
	try {
		services = await createAgentSessionServices({
			cwd: deps.cwd,
			...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						// The packet's tools are §44's vocabulary, so the same five
						// definitions the session uses are what the loop offers.
						registerBaselineTools(pi, deps.cwd);
						if (backend.baseUrl) {
							pi.registerProvider(backend.provider, {
								name: backend.displayName,
								baseUrl: backend.baseUrl,
								// A bare env-var name is resolved (or omitted) the same way the
								// interactive session resolves it; never sent as a literal key.
								...(apiKeyFor(backend.apiKey, deps.env ?? process.env) ?? {}),
								api: backend.api ?? "openai-completions",
								models: [
									{
										id: modelId,
										name: modelId,
										reasoning: true,
										input: ["text"],
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
										contextWindow: 128_000,
										maxTokens: 8_192,
									},
								],
							});
						}
					},
				],
			},
		});
	} catch (error) {
		return { status: "failed", failure: "provider", reason: (error as Error).message };
	}

	const model = services.modelRuntime.getModel(backend.provider, modelId);
	if (!model) {
		return {
			status: "failed",
			failure: "model",
			reason: `model ${backend.provider}/${modelId} is not registered — set backends.${backend.name}.baseUrl or backends.${backend.name}.model`,
		};
	}

	let session: AgentSession;
	try {
		({ session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model,
			noTools: "builtin",
			tools: [...(packet.allowedTools ?? BASELINE_TOOL_NAMES)],
		}));
	} catch (error) {
		return { status: "failed", failure: "provider", reason: (error as Error).message };
	}

	let turns = 0;
	let exceeded = false;
	let timedOut = false;
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "turn_end") return;
		turns += 1;
		if (turns >= budget && session.isStreaming) {
			exceeded = true;
			session.agent.abort();
		}
	});
	// The wall-clock ceiling (PRD-008): the budget bounds the loop's turns, a
	// provider or loop that stalls bounds nothing, so a caller that declares a
	// deadline gets the same abort the budget uses. The attempt's usage is still
	// read and reported below — a killed attempt has spent money.
	const deadlineMs = deps.timeoutMs;
	const timer = deadlineMs ? setTimeout(() => { timedOut = true; session.agent.abort(); }, deadlineMs) : undefined;

	let promptError: Error | null = null;
	try {
		await session.prompt(packet.prompt ?? packet.objective);
	} catch (error) {
		promptError = error as Error;
	} finally {
		unsubscribe();
		clearTimeout(timer);
	}

	const stats = session.getSessionStats();
	const messages = session.state.messages as unknown as TranscriptEntry[];
	const providerError = session.state.errorMessage;
	const summary = lastAssistantText(messages);
	const raw = {
		backend: backend.name,
		provider: backend.provider,
		model: modelId,
		turns,
		tokens: stats.tokens.total,
		// The breakdown Pi already counted, so the run's record prices input,
		// cache reads and output at their own rates instead of folding all of it
		// into one uncached bucket (PRD-015).
		usage: {
			inputTokens: stats.tokens.input,
			cachedInputTokens: stats.tokens.cacheRead,
			cacheWriteTokens: stats.tokens.cacheWrite,
			outputTokens: stats.tokens.output,
			// Pi's stats carry no reasoning split and `output` already includes
			// reasoning, so an invented split would double-count it.
			reasoningTokens: 0,
		},
		exitCode: 0,
	};
	session.dispose();

	const stop = nativeStop({ promptError: promptError !== null, providerError: Boolean(providerError), timedOut, exceeded });
	if (stop === "provider_failure") {
		return {
			status: "failed",
			failure: "provider",
			reason: promptError?.message ?? providerError ?? "the provider failed",
			sessionId: stats.sessionId,
			tokens: stats.tokens.total,
			usage: raw.usage,
		};
	}
	if (stop === "deadline") {
		return {
			status: "blocked",
			summary: `wall-clock ceiling of ${Math.round((deadlineMs ?? 0) / 1000)} s reached before the task completed`,
			...changeFields(),
			sessionId: stats.sessionId,
			raw,
		};
	}
	if (stop === "budget") {
		return {
			status: "blocked",
			summary: `budget of ${budget} turns exhausted before the task completed`,
			...changeFields(),
			sessionId: stats.sessionId,
			raw,
		};
	}
	return {
		status: "ok",
		summary: summary.length > 0 ? summary : `native run on ${backend.name}`,
		...changeFields(),
		sessionId: stats.sessionId,
		raw,
	};
}
