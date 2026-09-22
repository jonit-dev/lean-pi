/**
 * LeanPi extension entry point (PRD-001).
 *
 * LeanPi is a Pi extension package, not a new harness: `activate(pi)` registers
 * the role→backend providers, the five baseline tools and the STATIC prefix on
 * the executor request path, and `createLeanPiSession()` is the programmatic
 * form of the same path so tests exercise production code rather than a fixture.
 *
 * The default export attaches LeanPi and its bundled delegation package.
 */
import type { AgentSession, ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentSessionFromServices, createAgentSessionServices, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	getActivePrefix,
	isTurnInFlight,
	registerLane as registerTurnLane,
	runLanes,
	thinkingLevelFor,
	type Lane,
	type TurnContext,
	type TurnInput,
} from "./commands/session.js";
import { commandRegistry, type CommandContext, type CommandRegistry } from "./commands/registry.js";
import { registerJevCommands } from "./commands/jev.js";
import { registerThinkingFoldCommand } from "./commands/thinking-fold.js";
import { registerSubagentsLimitCommand } from "./commands/subagents-limit.js";
import { apiKeyFor, ConfigError, loadConfig, toPiConfigValue, writeSkillsState } from "./core/config.js";
import { buildStaticPrefix } from "./core/instructions/prefix.js";
import { LEANPI_EXTENSION_NAME, LEANPI_VERSION } from "./core/package-info.js";
import { clearCapabilityProviders, registerCapabilityProvider, setCompilerContext } from "./compiler/index.js";
import { clearRoutePins } from "./compiler/pins.js";
import { installPermissionGuard, loadPermissionState, registerPermissionsCommand } from "./permissions/index.js";
import { registerCostCommand } from "./telemetry/index.js";
import { registerMcpCommand, registerMcpDisclosure } from "./mcp/index.js";
import { createSessionHost, registerCommandSurface, PRD_OWNED_COMMANDS } from "./commands/index.js";
import { ensureGitIgnored, registerRuntimeVerifiers, worktreePermissionPrompt } from "./runtime/index.js";
import type { WorktreePermissionRequest } from "./runtime/index.js";
import type { BrowserFacility } from "./runtime/browser.js";
import { ownsExecutionLoop, registerTurnLanesIfOwned, setLaneCollector } from "./commands/turn-lanes.js";
import type { ExecutionContract } from "./compiler/contract.js";
import {
	callsFromMessages,
	createRunCollector,
	emitRunTelemetry,
	failedRunResult,
	resolveCostConfig,
	runTurnWithTelemetry,
	type RunCollector,
	type RunVerdict,
} from "./telemetry/index.js";
import { createArtifactStore, type ArtifactStore } from "./context/artifacts.js";
import type { WorkingStateSources } from "./context/working-state.js";
import { reduceToolOutput } from "./rtk/index.js";
import {
	gateFromProofResult,
	itemsOf,
	registerTodoCommands,
	registerTodoTool,
	type TodoCarrier,
	type TodoGate,
} from "./todo/index.js";
import { createGoalStore, goalTextSource, isRunningHere, registerGoalCommands, sessionCost } from "./goal/index.js";
import { registerReviewCommand, type ReviewCommandDeps } from "./review/index.js";
import { createLspProvider } from "./lsp/index.js";
import { LSP_TOOL_NAMES, registerLspTools } from "./lsp/tools.js";
import { createPrdAuthor, registerPrdCommandsLazily } from "./prd/dispatch.js";
import { readPrdState } from "./prd/state.js";
import { aggregate } from "./verify/aggregate.js";
import type { EvidenceRecord } from "./verify/evidence.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultRuntimeSkillRoots, defaultSkillRoots, scanSkills, createSkillControl, withoutSkillCatalog, type SkillRecord } from "./capabilities/skills.js";
import { bundledRoot } from "./skills/pack.js";
import { selectSkills } from "./capabilities/skill-select.js";
import { registerSkillsCommands } from "./commands/skills.js";
import { registerVerifyCommand } from "./commands/verify.js";
import { resolveRole } from "./core/roles.js";
import { LEANPI_STATUS_KEY, statusLine } from "./cli/statusline.js";
import { LEANPI_TODO_WIDGET_KEY, todoWidget, type TodoWidgetHost } from "./cli/todo-widget.js";
import { createRecap, type RecapController, type RecapRunner } from "./recap/index.js";
import { messageText } from "./commands/context.js";
import { outcomeLevel, renderTurnOutcome, type TurnJev } from "./cli/outcome.js";
import { BASELINE_TOOL_NAMES, YIELDED_TOOL_NAMES, compactUiAttached, registerBaselineTools } from "./core/tools.js";
import { jevWarning } from "./cli/bootstrap.js";
import { resolveCredential } from "./jev/credentials.js";
import { createJevClient, type JevClient } from "./jev/client.js";
import { createDecisionLog, decisionLogPath } from "./jev/log.js";
import type { CredentialEnv } from "./jev/credentials.js";
import { isModelRole, type LeanPiConfig, type ModelRole } from "./core/types.js";
import { SUBAGENT_ACTIVE_TOOL_NAMES, SUBAGENT_PARENT_TOOL_NAMES, prepareSubagents, subagentsFactory, type CapturedLimit } from "./subagents/index.js";

/**
 * The host's `ask` channel for an isolated worktree, built from Pi's own UI.
 * `undefined` when no prompt is reachable, so an `ask` posture refuses exactly as
 * PRD-017's guard does without a UI.
 */
function uiWorktreeConfirm(ctx: { hasUI: boolean; ui: { confirm(title: string, message: string): Promise<boolean> } }): ((request: WorktreePermissionRequest) => Promise<boolean>) | undefined {
	if (!ctx.hasUI || typeof ctx.ui.confirm !== "function") return undefined;
	const confirm = ctx.ui.confirm.bind(ctx.ui);
	return (request) => confirm("LeanPi worktree request", worktreePermissionPrompt(request));
}

export interface ActivateOptions {
	config?: LeanPiConfig;
	cwd?: string;
	/** Environment the credential store and `JEV_API_KEY` are read from. */
	env?: CredentialEnv;
	/** Command registry `/jev` registers into; PRD-016 extends the default one. */
	commands?: CommandRegistry;
	/** JEV transport seam: tests point the client at a stub endpoint. */
	jevTransport?: import("./jev/client.js").JevTransport;
	/** Recap seam: tests replace the one-shot recap call so no model is reached. */
	recapRunner?: RecapRunner;
	/**
	 * PRD-022's browser adapter. The installed Pi SDK exposes no browser, so the
	 * host that owns one injects it here; it travels per verification context to
	 * the browser/screenshot runners. Absent leaves them `unavailable`.
	 */
	browserFacility?: BrowserFacility | null;
}

/** What a booted LeanPi session exposes to its own lanes. */
export interface LeanPiActivation {
	readonly name: typeof LEANPI_EXTENSION_NAME;
	readonly version: string;
	readonly cwd: string;
	readonly config: LeanPiConfig;
	/** The five baseline tool names registered with the session (§44). */
	readonly tools: string[];
	/** Ordered lane registry used by the per-turn entry point. */
	registerLane(lane: Lane): void;
	/**
	 * The per-turn fan-in: the entry point hands each finished turn's context back
	 * so the command surfaces and the todo gate read the turn that just ran. Called
	 * by both entry points — the interactive hook and `createLeanPiSession()`.
	 */
	observeTurn(context: TurnContext): void;
	/** The session's todo list (PRD-025): the state `/todo` writes and prompts carry. */
	readonly todo: TodoCarrier;
	/** PRD-014's working-state sources, read live by every assembled prompt. */
	readonly workingStateSources: WorkingStateSources;
	/** The JEV control plane, handed to lanes by reference — never a tool. */
	readonly jev: JevClient;
	/**
	 * PRD-041: record the limit `subagentsFactory` captured for this session so
	 * `/subagents-limit` shows the value this session attached with. Called by
	 * the attach entries after `activate`; absent (bare activation) leaves the
	 * command reading the agent dir alone.
	 */
	noteSubagentCapture?(captured: CapturedLimit): void;
}

/** Register one Pi provider per `native` backend; every role on it becomes selectable. */
function registerBackends(pi: ExtensionAPI, config: LeanPiConfig, env: NodeJS.ProcessEnv = process.env): void {
	const modelsByBackend = new Map<string, Set<string>>();
	for (const [role, entry] of Object.entries(config.models)) {
		// Only role keys bind a model; `models.specialists` (FR-047) binds a role.
		if (!isModelRole(role) || !entry) continue;
		const set = modelsByBackend.get(entry.backend) ?? new Set<string>();
		set.add(entry.model);
		modelsByBackend.set(entry.backend, set);
	}

	for (const [name, backend] of Object.entries(config.backends)) {
		if (backend.type !== "native" || backend.enabled === false) continue;
		const declared = modelsByBackend.get(name);
		if (!declared || declared.size === 0) continue;
		if (typeof backend.baseUrl !== "string" || backend.baseUrl.length === 0) {
			throw new ConfigError("baseUrl is required for native backends", `backends.${name}`);
		}
		// Providers that require a routing header (OpenCode Go wants
		// `x-opencode-session`) are reachable without a code change: Pi resolves each
		// value through the same rule it uses for the key, and
		// `toPiConfigValue()` reconciles that rule with LeanPi's env-name syntax.
		const headers = backend.headers;
		const declaredHeaders = headers !== null && typeof headers === "object" && !Array.isArray(headers) ? headers : null;
		// Pi detects a vendor's dialect from the provider id and base URL, and this
		// provider is registered under the operator's own name for it, so an
		// endpoint that does not speak OpenAI's `reasoning_effort` has to say so.
		// Without the declaration Pi sends no thinking control at all and the model
		// thinks at the server's default on every call.
		const compat = backend.compat !== null && typeof backend.compat === "object" && !Array.isArray(backend.compat) ? (backend.compat as ProviderModelConfig["compat"]) : undefined;
		pi.registerProvider(name, {
			name: backend.name ?? name,
			baseUrl: backend.baseUrl,
			// Only when the config names one *and* the machine can supply it. The
			// old default — the literal `LEANPI_BACKEND_API_KEY` — is not an env var
			// anywhere, so `toPiConfigValue` passed the name through as the key and
			// the provider answered `401 Invalid API key`. The same happens to a
			// declared `apiKey: SOME_VAR` in a shell that does not export it.
			// Registering no key instead lets Pi use the credential it holds for
			// that provider, and if it holds none the error is Pi's own auth
			// message rather than a 401 about a key nobody set.
			...(apiKeyFor(backend.apiKey, env) ?? {}),
			api: backend.api ?? "openai-completions",
			...(declaredHeaders === null
				? {}
				: { headers: Object.fromEntries(Object.entries(declaredHeaders).map(([key, value]) => [key, typeof value === "string" ? toPiConfigValue(value) : value])) }),
			models: [...declared].map((id) => ({
				id,
				name: id,
				reasoning: backend.reasoning === true,
				...(compat === undefined ? {} : { compat }),
				input: (backend.input as ("text" | "image")[] | undefined) ?? ["text"],
				cost: (backend.cost as { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined) ?? {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: (backend.contextWindow as number | undefined) ?? 128_000,
				maxTokens: (backend.maxTokens as number | undefined) ?? 8_192,
			})),
		});
	}
}

/**
 * Prepend the turn's assembled context to the request Pi is about to send. The
 * STATIC prefix always heads the message list, so its bytes are cacheable and
 * byte-stable across tasks in a session (§22).
 */
function installExecutorPrefix(pi: ExtensionAPI, fallbackPrefix: () => string): void {
	pi.on("before_provider_request", (event) => {
		const text = getActivePrefix() || fallbackPrefix();
		if (text.length === 0) return;
		const payload = event.payload as { messages?: Array<{ role?: string; content?: unknown }> } | undefined;
		const messages = payload?.messages;
		if (!Array.isArray(messages) || messages.length === 0) return;
		const [first] = messages;
		if (first.role === "system" && typeof first.content === "string") {
			first.content = `${text}\n\n${first.content}`;
			return;
		}
		messages.unshift({ role: "system", content: text });
	});
}

/**
 * The tool-output boundary (PRD-014 AC-1, PRD-019 FR-110–113): every tool result
 * passes through PRD-019's reducer, which captures the raw bytes into PRD-014's
 * artifact store first and then decides, per the configured mode, whether the
 * executor sees the raw text or a bounded summary ending in the `artifact://`
 * reference. This is the hook PRD-019's consumer flow names; the reducer is the
 * only caller of `capture()` on this path, so nothing is stored twice.
 */
function installToolOutputPipeline(
	pi: ExtensionAPI,
	deps: { artifacts: ArtifactStore; cwd: string; config: LeanPiConfig; jev: Pick<JevClient, "ask" | "fallbackCount"> & Partial<Pick<JevClient, "getMode">> },
): void {
	pi.on("tool_result", async (event) => {
		const text = event.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		if (text.length === 0) return undefined;
		const reduced = await reduceToolOutput(
			{ output: text, kind: event.toolName, sourceRef: `${event.toolName}:${event.toolCallId}` },
			{ store: deps.artifacts, config: deps.config, cwd: deps.cwd, jev: deps.jev },
		);
		if (reduced.text === text) return undefined;
		// The non-text parts keep their position; only the text channel is reduced.
		const rest = event.content.filter((part) => part.type !== "text");
		return { content: [{ type: "text" as const, text: reduced.text }, ...rest] };
	});
}

/**
 * The §52 verdict a turn's own outcome supports. It claims exactly what the turn
 * produced: PRD-009's aggregate for verification, PRD-010's decision when the
 * gate ran, PRD-011's level/verdict when a reviewer ran. A turn that compiled no
 * contract claims nothing, which is why `success` requires the executor to have
 * finished and any proof gate that did run to have passed.
 */
function verdictOf(context: TurnContext): RunVerdict {
	const executor = context.executor;
	const review = executor?.review;
	return {
		verification: executor ? aggregate(executor.evidence) : "not_run",
		proof_gate: context.proof?.decision ?? "not_run",
		reviewer: review === undefined || review.skipped ? "not_run" : (review.verdict?.decision ?? "not_run"),
		success: executor?.status === "completed" && (context.proof === undefined || context.proof.decision === "PASS"),
	};
}

/**
 * PRD-014's working-state sources, wired to the state this activation actually
 * holds: the goal the user set, the active PRD's criteria, what the last turn
 * changed and what failed, and the items the todo list has not closed. Every
 * field reads live state, so a `/goal`, `/todo` or `/prd` between two turns
 * changes the next prompt without anything being copied at activation time.
 */
function workingStateSourcesFor(state: {
	cwd: string;
	todo: TodoCarrier;
	lastContext: () => TurnContext | undefined;
	/** Only this session's goal steers this session's turns. */
	sessionId?: string;
}): WorkingStateSources {
	const goalStore = createGoalStore(state.cwd);
	const evidence = (): readonly EvidenceRecord[] => state.lastContext()?.executor?.evidence ?? [];
	return {
		goal: goalTextSource(goalStore, state.sessionId),
		acceptance: () => readPrdState(state.cwd)?.criteria.map((criterion) => `${criterion.id}: ${criterion.text}`) ?? [],
		filesTouched: () => state.lastContext()?.executor?.changedFiles ?? [],
		failingEvidence: () => {
			const record = evidence().find((entry) => entry.status !== "pass");
			return record ? { summary: `${record.kind} ${record.status} (${record.scope})`, workspaceHash: record.workspaceHash } : null;
		},
		verificationByKind: () => Object.fromEntries(evidence().map((record) => [record.kind, record.status])),
		attempts: () => state.lastContext()?.executor?.invocations.length ?? 0,
		unresolved: () =>
			itemsOf(state.todo)
				.filter((item) => item.status !== "done" && item.status !== "dropped")
				.map((item) => `${item.id}: ${item.text}`),
	};
}

/**
 * The expand affordance PRD-014 AC-2 requires. Once the tool-output pipeline
 * replaces a large result with a compact record, the only way back to the bytes
 * is a reference read — this tool is that read, and without it every
 * `artifact://` an executor sees would be unrecoverable from the session.
 * Registered next to the baseline surface, so it is present whenever the
 * pipeline can produce a reference.
 */
export const ARTIFACT_TOOL_NAME = "artifact";

function installArtifactTool(pi: ExtensionAPI, artifacts: ArtifactStore): void {
	pi.registerTool({
		name: ARTIFACT_TOOL_NAME,
		label: ARTIFACT_TOOL_NAME,
		description: "Read the full bytes behind an `artifact://` reference a compacted tool result left behind.",
		parameters: Type.Object({ ref: Type.String({ description: "An `artifact://<kind>/<id>` reference." }) }),
		execute: async (_id, params) => {
			const ref = String((params as { ref?: unknown }).ref ?? "");
			try {
				return { content: [{ type: "text" as const, text: artifacts.expand(ref).toString("utf8") }], details: { ref } };
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `${ref} is not stored: ${error instanceof Error ? error.message : String(error)}` }],
					details: { ref },
				};
			}
		},
	});
}

/**
 * Put LeanPi's registry on the user's `/` key.
 *
 * One Pi command per registered LeanPi command, dispatched through the same
 * registry `/help` renders, so there is still exactly one dispatcher and no
 * second copy of any handler.
 *
 * Pi resolves extension commands *before* its own (`agent-session.prompt`), so
 * a bridged name Pi also ships would silently replace Pi's. No registered name
 * collides: LeanPi's deterministic reduction is `/compact-refs`, not
 * `/compact`.
 *
 * The live session facts travel on `CommandContext.session` rather than through
 * the surface's session host: Pi hands extensions a *read-only* manager per
 * invocation, while the host holds LeanPi's own manager, and a command that
 * reported the latter's empty history as the session's was the source of
 * `/context`'s invented totals.
 */
function bridgeCommands(pi: ExtensionAPI, commands: CommandRegistry, cwd: string, after: (ctx: TodoWidgetHost) => void): void {
	for (const command of commands.entries()) {
		pi.registerCommand(command.name, {
			description: command.summary.length > 0 ? command.summary : command.usage,
			handler: async (args, ctx) => {
				const usage = ctx.getContextUsage();
				const result = await commands.dispatch(`${command.name} ${args}`, {
					cwd,
					...(ctx.hasUI ? { prompt: (message: string) => ctx.ui.input(message) } : {}),
					// Guarded on the method, not on `hasUI`: a mode can have a UI and
					// still not draw overlays, and `/model` has a printed listing for
					// exactly that case.
					...(ctx.hasUI && ctx.ui.custom ? { custom: ctx.ui.custom.bind(ctx.ui) as CommandContext["custom"] } : {}),
					notify: (message: string) => ctx.ui.notify(message, "info"),
					// `/recap`'s whole output is a widget; the host it draws on travels with
					// the invocation, because only Pi's live context can set it.
					...(ctx.hasUI ? { recapHost: { ui: ctx.ui, hasUI: ctx.hasUI, sessionManager: ctx.sessionManager } } : {}),
					session: {
						id: ctx.sessionManager.getSessionId(),
						contextTokens: usage?.tokens ?? null,
						contextWindow: usage?.contextWindow ?? 0,
						...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
						...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
					},
				});
				ctx.ui.notify(result.text, result.ok ? "info" : "error");
				// A command that starts work sends its own prompt. Without this
				// `/goal <task>` only wrote the goal file and the session sat idle
				// until the user typed again.
				if (result.start) {
					pi.sendUserMessage(result.start, ctx.isIdle() ? {} : { deliverAs: "followUp" });
				}
				// `/todo` and `/goal` both write the list; the widget above the editor
				// is a snapshot, so it is re-rendered once every command has run.
				after(ctx);
			},
		});
	}
}

/**
 * `/clear` is the word users reach for when they mean `/new`. Pi ships the
 * session replacement under `/new` but not the alias, so this calls Pi's own
 * `ctx.newSession()` — the same runtime call `/new` makes — rather than a
 * weaker re-implementation. It is registered straight onto Pi and stays out of
 * LeanPi's registry on purpose: `/help` lists LeanPi's surface, this is Pi's
 * session action.
 */
function registerClearAlias(pi: ExtensionAPI): void {
	pi.registerCommand("clear", {
		description: "Start a new session (same as /new)",
		handler: async (_args, ctx) => {
			// Terminal: after replacement the old `ctx` is stale, so the handler
			// must not touch it again (Pi's session-replacement footgun).
			await ctx.newSession();
		},
	});
}

export function activate(pi: ExtensionAPI, options: ActivateOptions = {}): LeanPiActivation {
	// Pi's extension API has no cwd at load time, so the loader-driven path
	// resolves it from the process. `LEANPI_CWD` is the documented override for
	// launching Pi from outside the project it should configure.
	const cwd = options.cwd ?? process.env.LEANPI_CWD ?? process.cwd();
	// LeanPi's own state (sessions, artifacts, telemetry, decisions) lands under
	// `.leanpi/`, and the freshness hash now sees every untracked path — so a
	// store written between verification and the gate used to invalidate the
	// evidence it had just produced. Excluding the directory here, at the
	// session boundary before any store exists, keeps LeanPi's output out of the
	// workspace it is measuring. Project source the operator edits is untouched.
	ensureGitIgnored(cwd, ".leanpi");
	// One environment for credentials, the permission store and the guard: the
	// credential view is a strict subset of `ProcessEnv`'s shape.
	const env = (options.env ?? process.env) as NodeJS.ProcessEnv & CredentialEnv;
	// The default registry is process-wide, so a second activation in one process
	// (a test file boots several sessions; Pi's loader re-enters) replaces the
	// previous session's commands instead of colliding with them — the same
	// replace-not-stack rule the capability providers follow below. An injected
	// registry belongs to its caller and is left untouched.
	if (options.commands === undefined) {
		for (const name of commandRegistry.list()) commandRegistry.unregister(name);
	}
	const commands = options.commands ?? commandRegistry;
	const config = options.config ?? loadConfig(cwd, {}, env);
	registerBackends(pi, config, env);
	const tools = registerBaselineTools(pi, cwd, compactUiAttached() ? YIELDED_TOOL_NAMES : []);
	// PRD-018: the seven LSP tools are registered once and stay inactive until a
	// turn's compiled mode exposes its group (§15: never on by default). The mode
	// is applied per turn in `runTurn`.
	registerLspTools(pi, { root: cwd, config, env });
	installExecutorPrefix(pi, () => buildStaticPrefix(config));

	// Permission guard (PRD-017): installed after the baseline tools so the
	// guarded `execute` wins the name, and registered before any lane can run.
	// The guard reads only path-ish variables from `env`, which is the same
	// credential environment the rest of the session resolves against.
	// The role map travels with the session: a session booted on an injected
	// config (the bench, the SDK) runs in a directory that has no
	// `leanpi.config.yaml`, and re-reading one there would fail on the
	// "no model roles configured" check for a file the caller never used.
	const permissions = loadPermissionState(cwd, env as NodeJS.ProcessEnv, { models: config.models, backends: config.backends });
	// One session manager for the whole activation: the command surface points at
	// it and the artifact store keys its directory off its id, so a record and the
	// bytes it references can never belong to two different sessions.
	const manager = SessionManager.create(cwd, join(cwd, ".leanpi", "sessions"));
	const artifacts = createArtifactStore({
		sessionDir: join(cwd, ".leanpi", "artifacts", manager.getSessionId()),
		thresholdBytes: config.context.artifact_threshold_bytes,
	});
	installArtifactTool(pi, artifacts);
	// The redaction channel only fires when a secret was actually redacted (PRD-017);
	// the general capture path is the tool-output pipeline below, which sees the
	// already-redacted text because it runs after this handler.
	installPermissionGuard(pi, {
		cwd,
		state: permissions,
		env,
		// The same resolution the JEV client uses, read at the moment a result
		// arrives: a key that lives only in the project's `.env` never enters
		// `process.env`, so this is the redactor's only sight of its value.
		credential: () => ({ name: "JEV_API_KEY", value: resolveCredential(config, env, cwd).key }),
		onOutput: (redacted) => {
			try {
				artifacts.capture({ output: redacted, kind: "tool_output", sourceRef: "guard" });
			} catch {
				// A store failure must never turn a tool result into an error.
			}
		},
	});
	registerPermissionsCommand(commands, { cwd, state: permissions, env });
	// Cost telemetry (PRD-015): `/cost` reads the same store `/status` will read,
	// over the same session id every record this activation writes is stamped
	// with — without it the command read every run in the store and called the
	// sum "session total".
	registerCostCommand(commands, { cwd, sessionId: manager.getSessionId() });
	// MCP disclosure (PRD-006): `/mcp` plus the provider that fills
	// `capabilities.mcps`; registered after the provider reset above. The provider
	// reads the same runtime the command built, so a mid-session `/mcp disable` is
	// visible to the next compile.
	const mcpRuntime = registerMcpCommand(commands, { cwd, config, home: homedir(), env });
	const jev = createJevClient({
		config,
		cwd,
		log: createDecisionLog(decisionLogPath(cwd)),
		env,
		...(options.jevTransport ? { transport: options.jevTransport } : {}),
	});
	// `leanpi --no-jev` is the operator saying "run the degraded harness". The
	// launcher only skipped the startup credential check, so a machine that had a
	// key resolved one anyway and every site still called the control plane: the
	// flag changed nothing about the session it was passed to. `disabled` is the
	// mode every site already understands — each one resolves by its documented
	// fallback and nothing is sent.
	if (env.LEANPI_NO_JEV === "1") jev.setMode("disabled");
	// The compiler uses the session's JEV client: one control plane per process,
	// handed by reference rather than re-created per lane.
	setCompilerContext({ client: jev, config, cwd });

	// Skill disclosure (PRD-005): one registry, one selection function, one
	// command surface. The provider fills `capabilities.skills` inside compileTask.
	// Providers are process-global and bound to this session's JEV client, so the
	// session being activated replaces the previous one's set rather than stacking.
	clearCapabilityProviders();
	const trustedProject = config.permissions.trust.trusted;
	const skillRoots = config.capabilities.skillRoots.length > 0
		? [
				...config.capabilities.skillRoots.map((path) => ({ path, class: path.includes(".claude/plugins") ? ("plugin" as const) : ("user" as const) })),
				// The bundled pack is always last, even when the user configures
				// roots explicitly: PRD-026's floor must not be configurable away by
				// omission, only by disabling individual skills.
				{ path: bundledRoot(), class: "bundled" as const },
			]
		// SURF-4: the loader strips declared roots for an untrusted project, so
		// falling back to the raw defaults put `<cwd>/.claude/skills` back on the
		// surface. Keep user/plugin/bundled roots; a project-local root only when
		// the project is trusted.
		: defaultRuntimeSkillRoots(cwd, trustedProject, env.HOME ?? homedir());
	const scan = () => scanSkills(cwd, { roots: skillRoots });
	const skillRecords = scan();
	const skillControl = createSkillControl(config.skills.state, (state) => writeSkillsState(cwd, state));
	registerSkillsCommands(commands, { records: skillRecords, control: skillControl, reload: scan });
	// Runtime and UI verifiers (PRD-022): registering them turns the four kinds
	// PRD-009 left open into real verifier entries rather than `not_run`.
	registerRuntimeVerifiers();

	// The command and session surface (PRD-016). The surface is kept, not
	// discarded: the turn fan-in below feeds it the compiled contract, and the
	// Pi bridge at the end of this function is what puts these handlers on the
	// user's `/` key. The host's manager is LeanPi's own — Pi's live one is
	// read-only and arrives per command invocation, so the bridge hands the
	// commands Pi's session facts through `CommandContext.session` instead.
	// The recap controller is created below, once the todo carrier it reads exists;
	// `/recap` reads it lazily so the command can be registered here with the rest.
	let recapController: RecapController | undefined;
	const surface = registerCommandSurface(commands, {
		cwd,
		config,
		host: createSessionHost({ cwd, manager }),
		jev,
		cost: resolveCostConfig(config),
		env,
		recap: () => recapController,
	});

	// The three capability providers that fill the contract's slots (PRD-004's
	// single registration point, called after the reset above so one activation
	// cannot stack on another's): skills (PRD-005), MCP (PRD-006) and LSP
	// (PRD-018). RTK declares no provider — the deterministic reducer is wired at
	// the tool-output boundary below, where tool output actually exists.
	registerCapabilityProvider({
		kind: "skills",
		supply: async (draft) => {
			const selection = await selectSkills({
				records: scan(),
				control: skillControl,
				request: draft.task.user_request,
				config,
				client: jev,
				// A body belongs in the one-shot executor prompt the compiled path
				// builds. With Pi's own loop as the executor the disclosed block sits
				// in the cacheable prefix of every provider call, and three bodies
				// there cost about what Pi's whole skill catalog did — so that path
				// gets the pointer: name, what it is for, where to read it.
				...(ownsExecutionLoop(config) ? {} : { loadBody: (record: SkillRecord) => `${record.description}\nFull skill: ${record.source.path}` }),
			});
			return selection.skills;
		},
	});
	registerMcpDisclosure({ cwd, config, home: homedir(), client: jev, catalog: () => mcpRuntime.catalog() });
	registerCapabilityProvider(createLspProvider({ config, root: cwd, env }));
	// PRD-019 at PRD-014's boundary: capture every tool result into the artifact
	// store, then hand the executor the reduced or raw text the configured mode
	// decides. The RtkConfig's default mode is the measurement-gated one, so this
	// is a capture path first and a reduction path only where that mode allows.
	installToolOutputPipeline(pi, { artifacts, cwd, config, jev });

	// The command surfaces PRD-016 does not own. Each of these was implemented and
	// reachable only from tests before: `/todo` (PRD-025), `/goal` (PRD-013),
	// `/review` (PRD-011) and `/prd` (PRD-012). Their per-turn inputs arrive through
	// `observeTurn` below, so a registered handler reads the turn that just ran
	// rather than a snapshot of activation time.
	const todoCarrier: TodoCarrier = {};
	let todoGate: TodoGate | undefined;
	const reviewDeps: ReviewCommandDeps = { cwd, config, artifacts };
	// The same replace-not-stack rule the owned twelve follow: a second activation
	// in one process supersedes these handlers instead of colliding with them.
	for (const name of PRD_OWNED_COMMANDS) if (commands.has(name)) commands.unregister(name);
	registerTodoCommands(commands, {
		cwd,
		state: todoCarrier,
		gate: { verdict: (criterionId) => todoGate?.verdict(criterionId) },
		prd: () => readPrdState(cwd),
	});
	// The list, on screen instead of behind `/todo`: one row per item above the
	// editor, for as long as the session has a list. Refreshed wherever the list
	// can change — a command, a `todo_add` call, the end of a turn — because Pi's
	// widget slot holds a snapshot, not a live view of the carrier.
	const showTodo = (ctx: TodoWidgetHost): void => {
		// The terminal's own width: a clipped row is one row, a wrapped one is two.
		ctx.ui.setWidget?.(LEANPI_TODO_WIDGET_KEY, todoWidget(itemsOf(todoCarrier), process.stdout.columns));
	};
	pi.on("tool_execution_end", (_event, ctx) => showTodo(ctx));
	registerGoalCommands(commands, { cwd, config, prd: () => readPrdState(cwd), sessionId: manager.getSessionId() });
	// PRD-025's executor-facing `todo_add`. Whether a call appends is the
	// executor's own call: the tool is on the surface, and the list only costs
	// bytes once it has items.
	registerTodoTool(pi, {
		state: todoCarrier,
		gate: () => todoGate,
	});
	registerReviewCommand(commands, reviewDeps);
	// The evidence path for the native loop (§23): Pi's own loop is the executor
	// there, so nothing verifies its work and nothing gates it. This is how the
	// user asks for the same decision an executor-lane turn is held to.
	registerVerifyCommand(commands, {
		cwd,
		config,
		artifacts,
		jev,
		contract: () => lastContext?.contract,
		// Explicit `null` when the session supplied no adapter: an independent
		// session must not inherit another caller's process-global facility.
		browserFacility: options.browserFacility ?? null,
	});
	registerPrdCommandsLazily(commands, {
		cwd,
		config,
		artifactStore: artifacts,
		jev,
		// The two dependencies `/prd create` was missing. Without the author the
		// command refused every invocation; without the objective the status
		// line's own invitation made the user retype the turn that triggered it.
		author: createPrdAuthor({ cwd, registry: surface.backends, env }),
		defaultObjective: () => lastContext?.turn.text,
	});
	// The shared entry point captures upstream's limit after LeanPi registers.
	let capturedSubagentLimit: CapturedLimit | undefined;
	registerSubagentsLimitCommand(commands, () => capturedSubagentLimit);

	// The run that is still open: a compiled turn's collector and context, held from
	// `before_agent_start` until `agent_end` reports what the loop spent.
	let pendingRun: { collector: RunCollector; context: TurnContext } | undefined;

	// The per-turn fan-in: lanes write the turn's compiled state onto the context,
	// the entry points hand it back here, and the command surfaces, the working
	// state and the todo gate read it. Nothing else stores per-turn state here.
	let lastContext: TurnContext | undefined;
	const workingStateSources = workingStateSourcesFor({ cwd, todo: todoCarrier, lastContext: () => lastContext, sessionId: manager.getSessionId() });

	// The turn recap (PRD-036): one sentence of intent per turn, plus a session
	// title, drawn from state LeanPi already holds. Its open-work slot is the same
	// todo list the prompt carries, read live rather than copied at activation.
	const recap = createRecap({
		config,
		cwd,
		sessionId: manager.getSessionId(),
		pi,
		...(options.recapRunner ? { run: options.recapRunner } : {}),
		openWork: () =>
			itemsOf(todoCarrier)
				.filter((item) => item.status !== "done" && item.status !== "dropped")
				.map((item) => item.text),
	});
	recapController = recap;
	// The Pi-driven path's last settled turn: `agent_end` holds what the loop
	// produced, and `agent_settled` — after Pi's own telemetry sink — writes it.
	let settledTurn: { ask: string; did: string } | undefined;

	// The facts the status line carries that no contract holds: what the session
	// has spent so far, whether a goal is running, how full the context is, and
	// whether a backend is known-unusable. All read at render time — a goal set or
	// stopped between turns must change the next line, and so must a probe.
	const statusGoalStore = createGoalStore(cwd);
	const statusExtras = (ctx: { getContextUsage: () => { percent: number | null } | undefined }): {
		cost: number;
		goal?: string;
		contextPercent?: number;
		degraded?: string;
	} => {
		const goal = statusGoalStore.load();
		// Pi's own number, not a second estimate of it: `tokens` is null right after
		// a compaction, and `percent` is null with it, which is the one case the
		// footer must stay silent rather than report a plausible figure.
		const percent = ctx.getContextUsage()?.percent;
		// The probe cache is `/doctor`'s and starts empty, so this says nothing on a
		// session where nobody probed. Session-wide rather than per-role: a backend
		// the operator has bound anywhere is one they are about to route to.
		const unusable = [...surface.probes.entries()].find(([, probe]) => probe.status !== "ok");
		return {
			cost: sessionCost(cwd, manager.getSessionId(), resolveCostConfig(config)),
			...(isRunningHere(goal, manager.getSessionId()) ? { goal: (goal as { text: string }).text } : {}),
			...(percent === null || percent === undefined ? {} : { contextPercent: percent }),
			...(unusable ? { degraded: `${unusable[0]} ${unusable[1].status}` } : {}),
		};
	};
	const observeTurn = (context: TurnContext): void => {
		lastContext = context;
		// `/route`, `/status` and `/model` read the contract off the surface, and
		// nothing fed it before: every one of them reported "no contract compiled
		// yet" for the whole session, however many turns had been compiled.
		if (context.contract) surface.recordContract(context.contract);
		// A new proof result replaces the previous one; a turn without one keeps the
		// last verdict rather than silently clearing the todo gate.
		if (context.proof) todoGate = gateFromProofResult(context.proof);
		const invocation = context.executor?.invocations[context.executor.invocations.length - 1];
		reviewDeps.contract = context.contract;
		reviewDeps.evidence = context.executor?.evidence;
		reviewDeps.executor = invocation ? { backend: invocation.backend, model: null } : undefined;
		reviewDeps.recordedLevel = () => context.executor?.review.level;
	};

	// The compiler → executor chain (PRD-004 → PRD-007): the compiler lane puts a
	// contract on the turn context and the executor lane is its only consumer.
	registerTurnLanesIfOwned({
		cwd,
		config,
		jev,
		artifacts,
		todos: todoCarrier,
		sessionId: manager.getSessionId(),
		skills: { records: scan, control: skillControl },
		env,
		// Same reason as `/verify`: the lane's facility is this session's, never a
		// global another caller left behind.
		browserFacility: options.browserFacility ?? null,
	});

	registerJevCommands(commands, { client: jev, env });
	// The reasoning display (folded by default); the launcher reads what this stores.
	registerThinkingFoldCommand(commands, env);

	// First run without a resolved key warns exactly once; the harness keeps
	// running on deterministic fallback. A session that starts on a session Pi
	// switched to (`/new`, `/resume`, `/fork`) keeps the extension but not the
	// previous session's pins: the route overrides and the recorded contract
	// belonged to the conversation that just went away.
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") {
			surface.resetSessionState();
			clearRoutePins();
			// A switch invalidates the previous session's turn, cache and in-flight
			// generation *before* the new session's persisted recap is restored: the
			// old session's input must not answer `/recap` for the new one.
			recap.reset(ctx);
		}
		// The recap survives the session: the newest persisted one is shown again
		// on resume without a model call. Reading it first means a session that
		// cannot warn still shows what it was doing.
		recap.restore(ctx);
		if (!ctx.hasUI) return;
		// Asking for a credential the session is configured never to use is the
		// warning equivalent of the `--no-jev` bug above.
		if (jev.getMode() === "disabled") return;
		if (resolveCredential(config, env, cwd).key !== null) return;
		// A run launched through `leanpi` already printed these lines under the
		// banner; the flag keeps the user from reading them twice.
		if (env.LEANPI_JEV_WARNED === "1") return;
		const warning = jevWarning("not configured");
		if (warning) ctx.ui.notify(warning.join("\n"), "warning");
	});

	// Pi's `navigateTree` moves the active leaf to another branch. The recap on
	// screen belongs to the branch that was active: reset drops the previous
	// branch's turn/cache and invalidates its in-flight generation, then restore
	// reads the recap on the branch just navigated to. Without this the old
	// branch's recap stays on screen and answers a manual `/recap`.
	pi.on("session_tree", (_event, ctx) => {
		recap.reset(ctx);
		recap.restore(ctx);
	});

	// The turn, when LeanPi owns the loop (PRD-007 on an external-harness
	// configuration).
	//
	// Before this, the executor lane ran inside `before_agent_start`: it spawned
	// the vendor, verified, reviewed and gated — and then returned, so Pi's own
	// loop answered the same prompt a second time with a second model. The user
	// paid twice, saw only Pi's answer, and the proof gate had run against a
	// workspace another model was about to edit. `action: "handled"` is Pi's own
	// way for an extension to *be* the turn, so the work and the answer are the
	// same event.
	//
	// Native configurations return early: there Pi's loop is the executor by
	// design (§23) and `before_agent_start` below is where the turn is compiled.
	pi.on("input", async (event, ctx) => {
		// A new prompt invalidates the previous turn's recap before anything runs.
		recap.clear(ctx);
		// The recap for this prompt is written below; Pi's loop is not the path here.
		settledTurn = undefined;
		if (!ownsExecutionLoop(config)) return;
		// `runTurn()` drives the lanes itself; this hook must not run them again
		// for the prompt that entry point is about to send.
		if (isTurnInFlight()) return;
		const collector = createRunCollector({ taskId: event.text.slice(0, 64), sessionId: manager.getSessionId() });
		setLaneCollector(collector);
		// A vendor turn is tens of seconds with nothing on screen. The status line
		// is the only progress surface Pi gives an extension that is not itself
		// streaming, so the lanes report their phase into it.
		const progress = (phase: string): void => ctx.ui.setStatus(LEANPI_STATUS_KEY, `LeanPi: ${phase}`);
		// Counters are cumulative for the session; the turn's share is the delta.
		const jevBefore = { answered: jev.answeredCount(), fellBack: jev.fallbackCount() };
		const turnJev = (): TurnJev => ({
			answered: jev.answeredCount() - jevBefore.answered,
			fellBack: jev.fallbackCount() - jevBefore.fellBack,
			enabled: jev.getMode() !== "disabled",
		});
		progress("compiling the task");
		// The partial context is reachable from the catch below so a lane that
		// throws still bills the fail-closed gate's spend. It is built *inside* the
		// try so a throw while building it (an unresolved role) still reaches the
		// finally that clears this run's collector.
		let context: TurnContext | undefined;
		try {
			context = {
				turn: { text: event.text },
				role: "balanced",
				cwd,
				config,
				modelRef: resolveRole(config, "balanced"),
				skills: [],
				todo: todoCarrier,
				workingStateSources,
				// The interactive path's own prompt channel: Pi's `confirm` is only
				// reachable while the turn is in flight, so it rides the context.
				worktreeConfirm: uiWorktreeConfirm(ctx),
				prefix: "",
				onProgress: progress,
			};
			await runLanes({ text: event.text }, context);
			observeTurn(context);
			if (context.contract) {
				ctx.ui.setStatus(
					LEANPI_STATUS_KEY,
					statusLine({
						config,
						contract: context.contract,
						...statusExtras(ctx),
						color: true,
					}),
				);
			} else {
				ctx.ui.setStatus(LEANPI_STATUS_KEY, undefined);
			}
			const outcome = renderTurnOutcome(context, turnJev());
			ctx.ui.notify(outcome, outcomeLevel(context));
			if (context.contract) {
				emitRunTelemetry(collector, context.contract, verdictOf(context), {
					cwd,
					cost: resolveCostConfig(config),
					...(context.executor?.route_cost ? { routeCost: context.executor.route_cost } : {}),
				});
			}
			// The recap's "what the turn did" slot is the report the user just read:
			// the deterministic half already exists, so only the sentence is bought.
			await recap.recapTurn(ctx, { ask: event.text, did: outcome });
		} catch (error) {
			// The lanes threw after compiling. The turn failed, but the worker and
			// reviewer that already ran are real spend: emit one failed record from
			// the collector that captured them, then rethrow the original error.
			if (context?.contract) {
				try {
					emitRunTelemetry(collector, context.contract, failedRunResult(), {
						cwd,
						cost: resolveCostConfig(config),
						...(context.executor?.route_cost ? { routeCost: context.executor.route_cost } : {}),
					});
				} catch {
					// Accounting must never replace the turn's own failure.
				}
			}
			throw error;
		} finally {
			setLaneCollector(undefined);
		}
		return { action: "handled" as const };
	});

	// In the interactive `pi --extension` flow the user's prompt reaches Pi, not
	// `runTurn()`, so the lane phase runs here — exactly once per turn, and never
	// a second time when the prompt itself came from `runTurn()`. The turn's
	// context is handed to the same fan-in the programmatic path uses, and a turn
	// that compiled a contract writes its §52 record here: this path owns no
	// session object, so the verdict is read off the executor's own outcome.
	pi.on("before_agent_start", async (event, ctx) => {
		if (isTurnInFlight()) return;
		// PRD-015's accumulator is created before the lanes run, not after: the
		// executor lane's backend calls are what the record has to carry, and they
		// are spent while the lane runs.
		const collector = createRunCollector({ taskId: event.prompt.slice(0, 64), sessionId: manager.getSessionId() });
		setLaneCollector(collector);
		const context = await runLanes(
			{ text: event.prompt },
			{
				turn: { text: event.prompt },
				role: "balanced",
				cwd,
				config,
				modelRef: resolveRole(config, "balanced"),
				skills: [],
				todo: todoCarrier,
				workingStateSources,
				prefix: "",
			},
		);
		observeTurn(context);
		// The compiled route is this turn's spend decision here too, and here Pi's
		// own loop is the executor: the session's model and thinking level are the
		// only things the classification can change. `setModel` is skipped when Pi
		// has no authenticated model for the class (an external-harness role), and
		// the level is clamped to the model's own capabilities by the host.
		const owns = ownsExecutionLoop(config);
		// What Pi will actually run this turn, when Pi is the one running it.
		let installed: string | undefined;
		// The level the session ends the handler at, which is what the footer must
		// name: the compiled effort only when it was applied.
		let effort: ThinkingLevel | undefined;
		if (context.contract && !owns) {
			const ref = resolveRole(config, context.contract.routing.executor_class);
			const model = ctx.modelRegistry.find(ref.backend, ref.model);
			// `setModel` answers whether it took the model. Ignoring that answer
			// let the footer name a model the session had refused.
			if (model && (await pi.setModel(model))) installed = `${ref.backend}/${ref.model}`;
			// The operator's ceiling applies on every path (`thinkingLevelFor`), not
			// only the programmatic one: `backends.<name>.thinkingLevel: off` is the
			// one spending switch there is, and this handler used to raise straight
			// past it to whatever the classifier compiled.
			effort = thinkingLevelFor(config, installed === undefined ? (ctx.model?.provider ?? ref.backend) : ref.backend, context.contract.reasoning.effort);
			if (effort !== undefined) pi.setThinkingLevel(effort);
		}
		// "Tell me your goal, I figure out the rest" is only trustworthy if the
		// figuring is visible: the footer carries what this turn routed to, how
		// hard it was told to think, and what it was classified as.
		//
		// `installed` is the model Pi was *given*, which is not always the one the
		// contract asked for: an `external_harness` class has no entry in Pi's
		// registry, or `setModel` refused it, and Pi keeps running the session
		// model. Naming the contract's choice there would report a route that did
		// not happen — the one failure this line exists to prevent. The session's
		// *actual* model is `ctx.model`; `sessionModelFor(config)` was a second
		// guess at it from the config, and disagreed whenever the user had
		// switched models by hand.
		if (context.contract) {
			const running = owns || installed !== undefined ? undefined : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "pi's own model";
			ctx.ui.setStatus(
				LEANPI_STATUS_KEY,
				statusLine({
					config,
					contract: context.contract,
					...statusExtras(ctx),
					color: true,
					...(running === undefined ? {} : { model: running }),
					...(effort === undefined ? {} : { effort }),
				}),
			);
		}
		// Pi's blanket catalog, for any entry that still assembles one: the
		// `leanpi` launcher passes `--no-skills` and `createLeanPiSession` sets
		// `skillsOverride`, but a user running `pi --extension` by hand gets Pi's
		// discovery, and that is 82,343 bytes of the system prompt of every
		// request (~20.6k tokens) duplicating disclosure LeanPi already did.
		const systemPrompt = withoutSkillCatalog(event.systemPrompt);
		if (context.contract) {
			// The record is written at `agent_end`, not here: with Pi's own loop as
			// the executor this handler returns *before* the loop spends anything, so
			// emitting now would write a zeroed row for every native turn. The holder
			// keeps the run open until the loop reports what it used.
			pendingRun = { collector, context };
		} else {
			setLaneCollector(undefined);
		}
		return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
	});

	// A new run invalidates the previous recap on screen; the widget is cleared
	// rather than left looking like this turn's answer.
	pi.on("agent_start", (_event, ctx) => {
		recap.clear(ctx);
	});

	// PRD-015's sink for the path Pi itself drives: one call per assistant message
	// the loop produced, plus the tool calls it made, then exactly one record.
	pi.on("agent_end", (event, ctx) => {
		showTodo(ctx);
		// What `agent_settled` will recap: the loop's last ask and its answer. They
		// exist here; `agent_settled` fires after Pi's own telemetry sink has already
		// written this turn's record.
		const reversed = [...event.messages].reverse();
		const lastUser = reversed.find((message) => message.role === "user");
		const lastAssistant = reversed.find((message) => message.role === "assistant");
		settledTurn =
			lastUser === undefined || lastAssistant === undefined ? undefined : { ask: messageText(lastUser), did: messageText(lastAssistant) };
		const run = pendingRun;
		pendingRun = undefined;
		setLaneCollector(undefined);
		if (!run) return;
		const spend = callsFromMessages(event.messages, run.context.modelRef);
		for (const call of spend.calls) run.collector.add(call);
		run.collector.noteToolCall(spend.toolCalls);
		// The paths, so `file_reads`/`repeated_reads` are a measurement rather than a
		// constant zero: the collector collapses the repeats the model asked for.
		for (const path of spend.fileReads) run.collector.noteFileRead(path);
		emitRunTelemetry(run.collector, run.context.contract as ExecutionContract, verdictOf(run.context), {
			cwd,
			cost: resolveCostConfig(config),
			...(run.context.executor?.route_cost ? { routeCost: run.context.executor.route_cost } : {}),
		});
	});

	// PRD-036's Pi-side trigger: after the run has fully settled. `agent_end` is
	// taken by the telemetry sink above and fires mid-settle, so the recap waits.
	pi.on("agent_settled", async (_event, ctx) => {
		const turn = settledTurn;
		settledTurn = undefined;
		if (!turn) return;
		await recap.recapTurn(ctx, turn);
	});

	// The bridge PRD-016 was missing. Every command above registered into
	// LeanPi's own registry, which nothing in the interactive session reads: in
	// the TUI `/doctor`, `/route`, `/jev`, `/permissions`, `/todo` and the rest
	// were not commands at all, and the text fell through to the model as a
	// prompt. The permission guard's own recovery instruction ("run
	// `/permissions set <capability> ask`") named one of them.
	//
	// The result is printed with `ui.notify`, not `pi.sendMessage`: a custom
	// message would enter the LLM context and every later request in the session
	// would carry the output of every command the user ran.
	bridgeCommands(pi, commands, cwd, showTodo);
	registerClearAlias(pi);

	return {
		name: LEANPI_EXTENSION_NAME,
		version: LEANPI_VERSION,
		cwd,
		config,
		tools,
		jev,
		observeTurn,
		todo: todoCarrier,
		workingStateSources,
		registerLane(lane) {
			registerTurnLane(lane);
		},
		noteSubagentCapture(captured) {
			capturedSubagentLimit = captured;
		},
	};
}

/** Both the interactive extension and SDK use this complete attachment. */
export default function attach(pi: ExtensionAPI, options: ActivateOptions = {}): LeanPiActivation {
	const activation = activate(pi, options);
	const captured = subagentsFactory(pi);
	if (captured) activation.noteSubagentCapture?.(captured);
	return activation;
}

export interface CreateLeanPiSessionOptions {
	cwd?: string;
	agentDir?: string;
	/** Reuse a SettingsManager so upstream resource discovery matches the session's own loader. */
	settingsManager?: SettingsManager;
	config?: LeanPiConfig;
	sessionManager?: SessionManager;
	env?: CredentialEnv;
	commands?: CommandRegistry;
	jevTransport?: import("./jev/client.js").JevTransport;
	/** Injected so a test can answer the first-run prompt without a TUI. */
	uiInput?: (message: string) => Promise<string | undefined>;
	/** Overrides the model chosen for the initial turn, e.g. for `/model`. */
	model?: string | { provider: string; model: string };
	/** PRD-022's browser adapter for this session; see `ActivateOptions.browserFacility`. */
	browserFacility?: BrowserFacility | null;
	/** PRD-017's `ask` channel for an isolated worktree; absent means an `ask` posture refuses. */
	worktreeConfirm?: (request: WorktreePermissionRequest) => boolean | Promise<boolean>;
}

export interface LeanPiSession {
	session: AgentSession;
	activation: LeanPiActivation;
	/** The JEV control plane for this session. */
	jev: JevClient;
	/** Command registry `/jev` registered into. */
	commands: CommandRegistry;
	/** Registration identity the session reports (AC-1). */
	leanpi: { name: string; version: string };
	runTurn(turn: TurnInput | string): Promise<TurnContext>;
	/** Resolves a role through the platform registry; throws when unconfigured. */
	modelFor(role: ModelRole): { provider: string; model: string };
}

/**
 * Boot LeanPi through the real Pi SDK. The extension is installed as an
 * extension factory so the production `activate()` runs inside the session
 * rather than being called by the test.
 */
export async function createLeanPiSession(options: CreateLeanPiSessionOptions = {}): Promise<LeanPiSession> {
	const cwd = options.cwd ?? process.cwd();
	// Upstream's global settings use getAgentDir independently of this SDK path.
	const agentDir = options.agentDir ?? getAgentDir();
	// One manager for resource discovery and the session's own loader: Pi's
	// canonical-path merge then dedupes LeanPi's selected upstream entry against
	// any copy the same settings already expose.
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const subagents = await prepareSubagents({ cwd, agentDir, settingsManager });
	let activation: LeanPiActivation | undefined;
	// The session's extension API, kept so the active-tool set can be built from
	// the tools that actually registered (the package's parent tools included)
	// rather than a blanket activation of names the package may not expose.
	let extensionApi: ExtensionAPI | undefined;
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager,
		resourceLoaderOptions: {
			// Upstream is attached as a real resource path, so Pi loads it once and
			// dedupes it by canonical path against the operator's own copy.
			additionalExtensionPaths: [subagents.entry],
			// LeanPi owns skill disclosure (PRD-005): the contract's skill slots are
			// filled by `selectSkills`, so Pi's blanket `<available_skills>` block is
			// duplicate surface — and it is not small. Measured on this machine it
			// was 82,343 bytes of an 87,932-byte system prompt (~20.6k tokens), in
			// every request of every turn. The same reasoning as `noTools:
			// "builtin"` below: LeanPi supplies the surface, so Pi should not also
			// supply its own.
			skillsOverride: (base) => ({ skills: [], diagnostics: base.diagnostics }),
			extensionFactories: [
				(pi: ExtensionAPI) => {
					extensionApi = pi;
					activation = attach(pi, {
						cwd,
						config: options.config,
						env: options.env,
						commands: options.commands,
						jevTransport: options.jevTransport,
						...(options.browserFacility !== undefined ? { browserFacility: options.browserFacility } : {}),
					});
				},
			],
		},
	});
	if (!activation) {
		const loadErrors = services.resourceLoader.getExtensions().errors.map((failure) => `${failure.path}: ${failure.error}`);
		const diagnostics = services.diagnostics.filter((entry) => entry.type === "error").map((entry) => entry.message);
		throw new Error(`LeanPi extension did not load${[...loadErrors, ...diagnostics].length > 0 ? `: ${[...loadErrors, ...diagnostics].join("; ")}` : ""}`);
	}
	const loaded: LeanPiActivation = activation;

	const ref = options.model
		? typeof options.model === "string"
			? { provider: options.model.split("/")[0] ?? "", model: options.model.split("/")[1] ?? "" }
			: options.model
		: (() => {
				const resolved = resolveRole(loaded.config, "balanced");
				return { provider: resolved.backend, model: resolved.model };
			})();
	// An external-only configuration runs every executor role through an external
	// harness, so Pi's own loop never serves a request and the balanced role has
	// no model in Pi's runtime. Boot without one rather than inventing a native
	// role to hold the session open. An explicit `model` override, or a config
	// that does route execution through Pi, still has to name a registered model.
	const model = services.modelRuntime.getModel(ref.provider, ref.model);
	if (!model && (options.model !== undefined || !ownsExecutionLoop(loaded.config))) {
		throw new Error(
			`Model ${ref.provider}/${ref.model} is not registered. Configure "backends.${ref.provider}.baseUrl" in leanpi.config.yaml.`,
		);
	}

	const sessionManager = options.sessionManager ?? SessionManager.inMemory();
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model,
		noTools: "builtin",
		// The allowlist admits the LSP tools and the pi-subagents parent tools to
		// the registry; the mode, applied per turn by `runTurn`, decides which LSP
		// tools are active, and the subagents factory decides which parent tools are.
		// They start inactive (§15), exactly as the LSP tool tests boot their session.
		tools: [...BASELINE_TOOL_NAMES, ...LSP_TOOL_NAMES, ARTIFACT_TOOL_NAME, ...SUBAGENT_PARENT_TOOL_NAMES],
	});
	// The five baseline names plus the expand affordance, plus the pi-subagents
	// parent tools that are actually registered: a package tool absent from this
	// session is never activated, and the LSP tools stay inactive until a turn's
	// mode selects its group.
	const registered = new Set((extensionApi?.getAllTools() ?? []).map((tool) => tool.name));
	const activeSubagents = SUBAGENT_ACTIVE_TOOL_NAMES.filter((name) => registered.has(name));
	session.setActiveToolsByName([...BASELINE_TOOL_NAMES, ARTIFACT_TOOL_NAME, ...activeSubagents]);

	// One §52 record per turn that compiled a contract: the seam runs the real
	// `runTurn()`, hands the context to the activation's fan-in, and prices the
	// turn from the collector the run accumulated into. A turn with no contract
	// (native executor roles) writes nothing here — it was not a compiled run.
	const sessionId = sessionManager.getSessionId();
	return {
		session,
		activation: loaded,
		jev: loaded.jev,
		commands: options.commands ?? commandRegistry,
		leanpi: { name: LEANPI_EXTENSION_NAME, version: LEANPI_VERSION },
		runTurn: (turn) => {
			const input = typeof turn === "string" ? { text: turn } : turn;
			// One accumulator per run, set before the lanes execute so the executor
			// lane's invocations land in the same record this call emits.
			const collector = createRunCollector({ taskId: input.text.slice(0, 64), sessionId });
			setLaneCollector(collector);
			return runTurnWithTelemetry(
				input,
				{
					config: loaded.config,
					cwd,
					session,
					runtime: services.modelRuntime,
					todo: loaded.todo,
					workingStateSources: loaded.workingStateSources,
					...(options.worktreeConfirm ? { worktreeConfirm: options.worktreeConfirm } : {}),
					onContext: (context) => loaded.observeTurn(context),
				},
				{
					collector,
					verdict: (context) => verdictOf(context),
					cost: resolveCostConfig(loaded.config),
				},
			).finally(() => setLaneCollector(undefined));
		},
		modelFor(role) {
			const roleRef = resolveRole(loaded.config, role);
			return { provider: roleRef.backend, model: roleRef.model };
		},
	};
}

export {
	buildStaticPrefix,
	PONYTAIL_MARKER,
	PONYTAIL_VERSION,
	PREFIX_MAX_BYTES,
	readVendoredPonytail,
} from "./core/instructions/prefix.js";
export { ConfigError, CONFIG_FILENAME, configPathFor, loadConfig, toPiConfigValue, writeSkillsState } from "./core/config.js";
export { resolveRole, ROLE_FALLBACK_CHAINS, UnresolvedRoleError } from "./core/roles.js";
export { BASELINE_TOOL_NAMES, YIELDED_TOOL_NAMES, baselineToolDefinitions, compactUiAttached, registerBaselineTools } from "./core/tools.js";
export {
	clearLanes,
	getActivePrefix,
	listLanes,
	registerLane,
	registerOwnedLanes,
	runLanes,
	runTurn,
	setActivePrefix,
	type Lane,
	type TurnContext,
	type TurnDeps,
	type TurnInput,
} from "./commands/session.js";
export { LEANPI_EXTENSION_NAME, LEANPI_VERSION, PACKAGE_ROOT } from "./core/package-info.js";
export {
	clearCapabilityProviders,
	compileRecordOf,
	compileTask,
	getCompilerContext,
	registerCapabilityProvider,
	setCompilerContext,
	type CompilerContext,
} from "./compiler/index.js";
export { classifyExecution, classifyReviewRisk, deriveRequiredCapability, heuristicBand, reviewRiskFromSignals, reviewRiskSignals } from "./compiler/classify.js";
export { gateSignals, GATE_SITE_ID, heuristicGate, runGate } from "./compiler/gate.js";
export { applyDeviations, matrixDefault, REVIEWER_BY_RISK, ROUTING_MATRIX } from "./compiler/route.js";
export { createTaskState, deepFreeze } from "./compiler/state.js";
export type { TaskState, TaskStateSnapshot } from "./compiler/state.js";
export type {
	CapabilityProvider,
	CapabilitySlots,
	CompileRecord,
	DeviationInput,
	DeviationKind,
	ExecutionBand,
	ExecutionComplexity,
	ExecutionContract,
	ExecutorClass,
	PlanningDecision,
	RequiredCapability,
	ReviewRisk,
	ReviewerClass,
	RouteDeviation,
	SiteTelemetryRow,
} from "./compiler/contract.js";
export { SCOUT_PACKET_MAX_BYTES, scoutTask } from "./scout/index.js";
export * from "./permissions/index.js";
// `billingOf` exists in both barrels; the backend derivation (PRD-008) is the
// canonical one, so the ambiguity is resolved explicitly here.
export { billingOf } from "./backends/index.js";
export * from "./telemetry/index.js";
export * from "./lsp/index.js";
export * from "./mcp/index.js";
export * from "./review/index.js";
export * from "./proof/index.js";
export * from "./capability/index.js";
export * from "./routing/index.js";
export * from "./exploration/index.js";
export * from "./runtime/index.js";
export * from "./bench/index.js";
export { levenshtein, upsertCommand } from "./commands/registry.js";
export type { Command, CommandInit } from "./commands/registry.js";
export { createCommandSurface, createSessionHost, OWNED_COMMANDS, registerCommandSurface } from "./commands/index.js";
export { usageAdapter, usageInventory, renderUsage } from "./cli/usage.js";
export type { UsageRow } from "./cli/usage.js";
export { compilerLane, executorLane, ownsExecutionLoop, registerTurnLanes, registerTurnLanesIfOwned, type TurnLaneDeps } from "./commands/turn-lanes.js";
export type { CommandSurface, CommandSurfaceDeps, ProbeResult, RoleBinding, SessionHost } from "./commands/index.js";
export { applyRoutePins, clearRoutePins, pinOwner, pinnedDecision, routePins, setRoutePins } from "./compiler/pins.js";
export type { RoutePins } from "./compiler/pins.js";
export * from "./todo/index.js";
export * from "./goal/index.js";
export * from "./rtk/index.js";
export { verifyTask, WORKSPACE_HASH_KIND } from "./verify/index.js";
// The PRD lane is reached through its gate only: `dispatch.js` holds no lane
// module, so importing it cannot load the PRD machinery FR-032/AC-7 require to
// stay absent on the quick path. Everything else lives in `src/prd/*` and is
// imported directly by the lane's consumers.
export { createPrdAuthor, laneLoads, openPrdLane, PRD_COMMAND_HELP, registerPrdCommandsLazily, resetLaneLoads } from "./prd/dispatch.js";
export type { PrdLaneOptions } from "./prd/dispatch.js";
export { deriveGoal } from "./prd/goal.js";
export type { GoalCriterion } from "./prd/goal.js";
export type { VerifyOptions, VerifyResult, VerifySettings } from "./verify/index.js";
export { aggregate, type VerificationStatus } from "./verify/aggregate.js";
export type { EvidenceRecord, EvidenceStore, EvidenceView, ModelAssertion, VerifierResult } from "./verify/evidence.js";
export { registerRegressionScopeSite, selectVerifiers, verificationBlockOf } from "./verify/select.js";
export { workspaceHash } from "./verify/hash.js";
export * from "./backends/index.js";
export * from "./executor/index.js";
// Both barrels legitimately name a failure classifier: the executor's is the §33
// attempt signature, routing's is the telemetry-bucket one. The ambiguity is
// resolved explicitly here rather than by dropping either.
export {
	createSkillControl,
	defaultRuntimeSkillRoots,
	defaultSkillRoots,
	frontmatterOf,
	FRONTMATTER_READ_LIMIT,
	loadSkillBody,
	pluginSkillRoots,
	resetScanStats,
	scanSkills,
	scanStats,
	withoutSkillCatalog,
} from "./capabilities/skills.js";
export type { ScanOptions, ScanStats, SkillControl, SkillRecord, SkillRoot, SkillStateEntry, SourceClass } from "./capabilities/skills.js";
export { lexicalSelect, registerSkillSite, selectSkills, SKILL_SITE_ID, DEFAULT_TOP_K } from "./capabilities/skill-select.js";
export type { SelectSkillsInput, SelectSkillsResult, SkillDisclosureDecision } from "./capabilities/skill-select.js";
export { registerSkillsCommands } from "./commands/skills.js";
export { bundledRoot, BundledIntegrityError, clearPackCache, isBundledPath, packEntries, packLock, packVersion, verifyBundledFile, type PackEntry, type PackFile, type PackLock } from "./skills/pack.js";
export type { SkillsCommandDeps } from "./commands/skills.js";
export { ArtifactNotFoundError, createArtifactStore, renderCompactRecord, sha256 } from "./context/artifacts.js";
export type { ArtifactStore, CaptureInput, CaptureResult, CompactRecord } from "./context/artifacts.js";
export { buildExcerpt } from "./context/excerpt.js";
export {
	classifyCandidates,
	compact,
	registerRetentionSite,
	RETENTION_QUESTIONS,
	RETENTION_SITE_ID,
} from "./context/compaction.js";
export type { CompactOptions, CompactResult, ContextItem, Decision, ItemKind, Verdict } from "./context/compaction.js";
export { assemble } from "./context/prompt.js";
export type { AssembledPrompt, AssembleParts } from "./context/prompt.js";
export { buildWorkingState, serializeWorkingState, stubSources, WORKING_STATE_MAX_BYTES } from "./context/working-state.js";
export type { WorkingState, WorkingStateSession, WorkingStateSources } from "./context/working-state.js";
export type { TaskPacket } from "./scout/index.js";
export { createJevClient, JEV_ENDPOINT_DEFAULT, JEV_INPUT_COST_PER_MILLION, JEV_MODEL_DEFAULT } from "./jev/client.js";
export type { JevClient, JevStatus, JevTestResult, JevTransport, JevTransportRequest, JevTransportResponse } from "./jev/client.js";
export { CONFIDENCE_THRESHOLDS, accept } from "./jev/confidence.js";
export {
	clearStoredKey,
	credentialsPath,
	describeCredential,
	readStoredKey,
	resolveCredential,
	writeStoredKey,
} from "./jev/credentials.js";
export type { CredentialEnv, CredentialSource, ResolvedCredential } from "./jev/credentials.js";
export { createDecisionLog, decisionLogPath, readDecisions } from "./jev/log.js";
export type { DecisionLog, DecisionRow } from "./jev/log.js";
export { applyPrivacy, metadataSummary, redactSecrets, REDACTED } from "./jev/privacy.js";
export {
	clearSites,
	DuplicateSiteError,
	getSite,
	listSites,
	MissingFallbackError,
	registerSite,
	UnknownSiteError,
} from "./jev/registry.js";
export type { DecisionSite, FallbackContext, SiteFallback } from "./jev/registry.js";
export { answerValue, decisiveness } from "./jev/types.js";
export type {
	ChoiceAnswer,
	ChoiceQuestion,
	Consequence,
	JevQuestion,
	JevResult,
	JevUsage,
	NoulAnswer,
	NoulQuestion,
	QuestionKind,
	ScoreAnswer,
	ScoreQuestion,
} from "./jev/types.js";
export { commandRegistry, createCommandRegistry, DuplicateCommandError } from "./commands/registry.js";
export type { CommandContext, CommandHandler, CommandRegistry, CommandResult } from "./commands/registry.js";
export { jevStatus, registerJevCommands } from "./commands/jev.js";
export { registerThinkingFoldCommand } from "./commands/thinking-fold.js";
export { MODEL_ROLES, isModelRole } from "./core/types.js";
export type {
	BackendConfig,
	BackendRef,
	BackendType,
	BenchConfig,
	CapabilitiesConfig,
	JevConfig,
	JevMode,
	LeanPiConfig,
	LimitsConfig,
	ModelRole,
	SelectedSkill,
	SkillsConfig,
} from "./core/types.js";
