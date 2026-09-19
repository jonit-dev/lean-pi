/**
 * The native model backend (PRD-008 Phase 2, ROADMAP §23).
 *
 * LeanPi owns the Pi agent loop here — model turn, tool call, model turn — over
 * the configured provider (a metered API, a Pi custom provider or a local
 * server). The result is the same `WorkerResult` an external harness returns, so
 * the executor never branches on `type`; a provider error is a typed failure,
 * never a throw that unwinds the turn.
 */
import type { AgentSession, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@mariozechner/pi-coding-agent";
import { BASELINE_TOOL_NAMES, registerBaselineTools } from "../core/tools.js";
import type { RegisteredBackend } from "./registry.js";
import { changedFilesSince, modelFor, snapshotFiles, type WorkerOutcome, type WorkerTaskPacket } from "./worker.js";

/** Default loop ceiling when the packet carries no budget. */
export const DEFAULT_NATIVE_BUDGET = 8;

export interface RunNativeDeps {
	cwd: string;
	agentDir?: string;
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
	const files = packet.files ?? [];
	const before = snapshotFiles(deps.cwd, files);
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
								apiKey: backend.apiKey ?? "LEANPI_BACKEND_API_KEY",
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

	const model = services.modelRegistry.find(backend.provider, modelId);
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
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "turn_end") return;
		turns += 1;
		if (turns >= budget && session.isStreaming) {
			exceeded = true;
			session.agent.abort();
		}
	});

	let promptError: Error | null = null;
	try {
		await session.prompt(packet.prompt ?? packet.objective);
	} catch (error) {
		promptError = error as Error;
	} finally {
		unsubscribe();
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
		exitCode: 0,
	};
	session.dispose();

	if (promptError) {
		return {
			status: "failed",
			failure: "provider",
			reason: promptError.message,
			sessionId: stats.sessionId,
			tokens: stats.tokens.total,
		};
	}
	if (exceeded) {
		return {
			status: "blocked",
			summary: `budget of ${budget} turns exhausted before the task completed`,
			changedFiles: changedFilesSince(before, deps.cwd, files),
			sessionId: stats.sessionId,
			raw,
		};
	}
	if (providerError && summary.length === 0) {
		return {
			status: "failed",
			failure: "provider",
			reason: providerError,
			sessionId: stats.sessionId,
			tokens: stats.tokens.total,
		};
	}
	return {
		status: "ok",
		summary: summary.length > 0 ? summary : `native run on ${backend.name}`,
		changedFiles: changedFilesSince(before, deps.cwd, files),
		sessionId: stats.sessionId,
		raw,
	};
}
