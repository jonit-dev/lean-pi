/**
 * A real Pi session with the permission guard installed (PRD-017).
 *
 * The harness goes through Pi's own SDK — provider registration, extension
 * factory, tool dispatch — so the guard runs on the same hook a real
 * `pi --extension` session uses. The only test-side pieces are the stub
 * backend, the confirmation stub, and the optional `trace`: instrumented
 * `execute`/file tools that record what the guard let through while still
 * delegating to the real implementation.
 */
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	createBashToolDefinition,
	createEditToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	createLocalBashOperations,
	SessionManager,
	type AgentSession,
	type BashOperations,
	type ExtensionContext,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { BASELINE_TOOL_NAMES, registerBaselineTools } from "../../src/core/tools.js";
import { installPermissionGuard, loadPermissionState, type GuardQuestion, type PermissionGuard, type PermissionState } from "../../src/permissions/index.js";
import { tempDir } from "../helpers/fixtures.js";
import type { StubStep } from "../helpers/stub-backend.js";

/** What the guard let through: one entry per executed command and per opened path. */
export interface Trace {
	commands: string[];
	paths: string[];
}

export interface GuardedSessionOptions {
	cwd: string;
	baseUrl: string;
	agentDir?: string;
	model?: string;
	/** Permission env: `XDG_CONFIG_HOME` decides which user-scope store is read. */
	env?: NodeJS.ProcessEnv;
	state?: PermissionState;
	confirm?: (question: GuardQuestion, ctx: ExtensionContext) => boolean | Promise<boolean>;
	applySpawnEnv?: boolean;
	onOutput?: (redacted: string) => void;
	/** Boot without installing the guard: the bypass control for every denial. */
	installGuard?: boolean;
	/** Bind a real extension UI context so `ask` reaches Pi's own confirmation prompt. */
	ui?: { confirm(title: string, message: string): boolean | Promise<boolean>; prompts?: Array<{ title: string; message: string }> };
	/** Records executed commands and opened paths without replacing the real tools. */
	trace?: Trace;
	/** Stub capability tools (MCP servers, subagent spawns) registered as Pi tools. */
	extraTools?: ToolDefinition[];
	tools?: string[];
}

export interface GuardedSession {
	session: AgentSession;
	state: PermissionState;
	guard?: PermissionGuard;
	dispose(): void;
}

export const STUB_MODEL = "stub-model";
export const STUB_PROVIDER = "stub";

function recordingOperations(trace: Trace): BashOperations {
	const local = createLocalBashOperations();
	return {
		exec: (command, cwd, options) => {
			trace.commands.push(command);
			return local.exec(command, cwd, options);
		},
	};
}

/** Wrap a baseline tool so its execution is recorded; the real definition still runs. */
function traced(name: "read" | "search" | "edit" | "write", cwd: string, trace: Trace): ToolDefinition {
	const definition = (
		name === "read"
			? createReadToolDefinition
			: name === "search"
				? createGrepToolDefinition
				: name === "edit"
					? createEditToolDefinition
					: createWriteToolDefinition
	)(cwd) as unknown as ToolDefinition & { execute: (id: string, args: Record<string, unknown>, ...rest: unknown[]) => unknown };
	const execute = definition.execute.bind(definition);
	return {
		...definition,
		name,
		label: name,
		execute: (id: string, args: Record<string, unknown>, ...rest: unknown[]) => {
			const path = args.path ?? args.file ?? args.file_path;
			if (typeof path === "string") trace.paths.push(path);
			return execute(id, args, ...rest);
		},
	} as unknown as ToolDefinition;
}

function registerRecordingExecute(pi: { registerTool(tool: ToolDefinition): void }, cwd: string, trace: Trace): void {
	const definition = createBashToolDefinition(cwd, { operations: recordingOperations(trace) }) as unknown as ToolDefinition;
	pi.registerTool({ ...definition, name: "execute", label: "execute" });
}

/** Boot a session whose only extension installs the baseline tools and the guard. */
export async function bootGuardedSession(options: GuardedSessionOptions): Promise<GuardedSession> {
	const state = options.state ?? loadPermissionState(options.cwd, options.env ?? process.env);
	const trace = options.trace;
	let guard: PermissionGuard | undefined;
	const agentDir = options.agentDir ?? tempDir("leanpi-agent-");

	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir,
		resourceLoaderOptions: {
			extensionFactories: [
				(pi) => {
					pi.registerProvider(STUB_PROVIDER, {
						name: STUB_PROVIDER,
						baseUrl: options.baseUrl,
						apiKey: "sk-stub",
						api: "openai-completions",
						models: [
							{
								id: STUB_MODEL,
								name: STUB_MODEL,
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128_000,
								maxTokens: 8_192,
							},
						],
					});
					registerBaselineTools(pi, options.cwd);
					for (const tool of options.extraTools ?? []) pi.registerTool(tool);
					if (trace) {
						for (const name of ["read", "search", "edit", "write"] as const) pi.registerTool(traced(name, options.cwd, trace));
					}
					if (options.installGuard === false) {
						if (trace || options.applySpawnEnv === false) registerRecordingExecute(pi, options.cwd, trace ?? { commands: [], paths: [] });
						return;
					}
					guard = installPermissionGuard(pi, {
						cwd: options.cwd,
						state,
						env: options.env ?? process.env,
						...(options.confirm ? { confirm: (question, ctx) => options.confirm!(question, ctx) } : {}),
						...(options.applySpawnEnv === undefined ? {} : { applySpawnEnv: options.applySpawnEnv }),
						...(options.onOutput ? { onOutput: options.onOutput } : {}),
						...(trace ? { operations: recordingOperations(trace) } : {}),
					});
					// The guard installed no execute tool (spawn env switched off); keep a recording one in play.
					if (trace && options.applySpawnEnv === false) registerRecordingExecute(pi, options.cwd, trace);
				},
			],
		},
	});

	const model = services.modelRegistry.find(STUB_PROVIDER, options.model ?? STUB_MODEL);
	if (!model) throw new Error("stub model is not registered");
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(),
		model,
		noTools: "builtin",
		tools: options.tools ?? [...BASELINE_TOOL_NAMES, ...(options.extraTools ?? []).map((tool) => tool.name)],
	});
	if (options.ui) {
		const ui = options.ui;
		await session.bindExtensions({
			uiContext: {
				confirm: async (title: string, message: string) => {
					ui.prompts?.push({ title, message });
					return ui.confirm(title, message);
				},
			} as unknown as ExtensionUIContext,
		});
	}

	return { session, state, ...(guard ? { guard } : {}), dispose: () => session.dispose() };
}

/** Every tool message Pi sent back to the model, concatenated. */
export function toolMessages(stub: { requests: Array<{ body: Record<string, unknown> }> }): string {
	return stub.requests
		.flatMap((request) => (request.body.messages ?? []) as Array<{ role?: string; content?: unknown }>)
		.filter((message) => message.role === "tool")
		.map((message) => JSON.stringify(message.content))
		.join("\n");
}

/** The last step is always a plain completion, so the session ends the turn. */
export function drive(steps: StubStep[]): StubStep[] {
	return [...steps, { text: "done" }];
}

/** One tool call step. */
export function call(name: string, args: Record<string, unknown>): StubStep {
	return { toolCalls: [{ name, args }] };
}
