/**
 * LeanPi extension entry point (PRD-001).
 *
 * LeanPi is a Pi extension package, not a new harness: `activate(pi)` registers
 * the role→backend providers, the five baseline tools and the STATIC prefix on
 * the executor request path, and `createLeanPiSession()` is the programmatic
 * form of the same path so tests exercise production code rather than a fixture.
 *
 * `export default activate` is what `pi --extension ./dist/index.js` loads.
 */
import type { AgentSession, ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	getActivePrefix,
	isTurnInFlight,
	registerLane as registerTurnLane,
	runLanes,
	runTurn,
	setActivePrefix,
	type Lane,
	type TurnContext,
	type TurnInput,
} from "./commands/session.js";
import { commandRegistry, type CommandRegistry } from "./commands/registry.js";
import { registerJevCommands } from "./commands/jev.js";
import { ConfigError, loadConfig, toPiConfigValue, writeSkillsState } from "./core/config.js";
import { buildStaticPrefix } from "./core/instructions/prefix.js";
import { LEANPI_EXTENSION_NAME, LEANPI_VERSION } from "./core/package-info.js";
import { clearCapabilityProviders, registerCapabilityProvider, setCompilerContext } from "./compiler/index.js";
import { installPermissionGuard, loadPermissionState, registerPermissionsCommand } from "./permissions/index.js";
import { registerCostCommand } from "./telemetry/index.js";
import { registerMcpCommand, registerMcpDisclosure } from "./mcp/index.js";
import { createSessionHost, registerCommandSurface, PRD_OWNED_COMMANDS } from "./commands/index.js";
import { registerRuntimeVerifiers } from "./runtime/index.js";
import { ownsExecutionLoop, registerTurnLanesIfOwned, setLaneCollector } from "./commands/turn-lanes.js";
import type { ExecutionContract } from "./compiler/contract.js";
import {
	callsFromMessages,
	createRunCollector,
	emitRunTelemetry,
	resolveCostConfig,
	runTurnWithTelemetry,
	type RunCollector,
	type RunVerdict,
} from "./telemetry/index.js";
import { createArtifactStore, type ArtifactStore } from "./context/artifacts.js";
import type { WorkingStateSources } from "./context/working-state.js";
import { reduceToolOutput } from "./rtk/index.js";
import { gateFromProofResult, itemsOf, registerTodoCommands, type TodoCarrier, type TodoGate } from "./todo/index.js";
import { createGoalStore, goalTextSource, registerGoalCommands } from "./goal/index.js";
import { registerReviewCommand, type ReviewCommandDeps } from "./review/index.js";
import { createLspProvider } from "./lsp/index.js";
import { LSP_TOOL_NAMES, registerLspTools } from "./lsp/tools.js";
import { registerPrdCommandsLazily } from "./prd/dispatch.js";
import { readPrdState } from "./prd/state.js";
import { aggregate } from "./verify/aggregate.js";
import type { EvidenceRecord } from "./verify/evidence.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultSkillRoots, scanSkills, createSkillControl, withoutSkillCatalog, type SkillRecord } from "./capabilities/skills.js";
import { bundledRoot } from "./skills/pack.js";
import { selectSkills } from "./capabilities/skill-select.js";
import { registerSkillsCommands } from "./commands/skills.js";
import { resolveRole } from "./core/roles.js";
import { LEANPI_STATUS_KEY, statusLine } from "./cli/statusline.js";
import { sessionModelFor } from "./cli/bootstrap.js";
import { BASELINE_TOOL_NAMES, registerBaselineTools } from "./core/tools.js";
import { credentialsPath, resolveCredential, writeStoredKey } from "./jev/credentials.js";
import { createJevClient, type JevClient } from "./jev/client.js";
import { createDecisionLog, decisionLogPath } from "./jev/log.js";
import type { CredentialEnv } from "./jev/credentials.js";
import { isModelRole, type LeanPiConfig, type ModelRole } from "./core/types.js";

export interface ActivateOptions {
	config?: LeanPiConfig;
	cwd?: string;
	/** Environment the credential store and `JEV_API_KEY` are read from. */
	env?: CredentialEnv;
	/** Command registry `/jev` registers into; PRD-016 extends the default one. */
	commands?: CommandRegistry;
	/** JEV transport seam: tests point the client at a stub endpoint. */
	jevTransport?: import("./jev/client.js").JevTransport;
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
}

/**
 * The `apiKey` field for a provider registration, or nothing.
 *
 * A bare name in LeanPi's config means "the variable of that name". If the
 * variable is absent, Pi 0.85 reads the bare name as a *literal key* and the
 * provider answers `401 {"type":"AuthError","message":"Invalid API key."}` —
 * indistinguishable, to a user who just ran `leanpi --jev-key`, from a verdict
 * on the key they configured. Registering nothing lets Pi fall back to its own
 * stored credential for the provider.
 */
function apiKeyFor(declared: unknown, env: NodeJS.ProcessEnv): { apiKey: string } | undefined {
	if (typeof declared !== "string" || declared.length === 0) return undefined;
	const bareName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(declared);
	if (bareName && (env[declared] === undefined || env[declared] === "")) return undefined;
	return { apiKey: toPiConfigValue(declared, env) };
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
function workingStateSourcesFor(state: { cwd: string; todo: TodoCarrier; lastContext: () => TurnContext | undefined }): WorkingStateSources {
	const goalStore = createGoalStore(state.cwd);
	const evidence = (): readonly EvidenceRecord[] => state.lastContext()?.executor?.evidence ?? [];
	return {
		goal: goalTextSource(goalStore),
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

export function activate(pi: ExtensionAPI, options: ActivateOptions = {}): LeanPiActivation {
	// Pi's extension API has no cwd at load time, so the loader-driven path
	// resolves it from the process. `LEANPI_CWD` is the documented override for
	// launching Pi from outside the project it should configure.
	const cwd = options.cwd ?? process.env.LEANPI_CWD ?? process.cwd();
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
	const tools = registerBaselineTools(pi, cwd);
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
	// Cost telemetry (PRD-015): `/cost` reads the same store `/status` will read.
	registerCostCommand(commands, { cwd });
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
	// The compiler uses the session's JEV client: one control plane per process,
	// handed by reference rather than re-created per lane.
	setCompilerContext({ client: jev, config, cwd });

	// Skill disclosure (PRD-005): one registry, one selection function, one
	// command surface. The provider fills `capabilities.skills` inside compileTask.
	// Providers are process-global and bound to this session's JEV client, so the
	// session being activated replaces the previous one's set rather than stacking.
	clearCapabilityProviders();
	const skillRoots = config.capabilities.skillRoots.length > 0
		? [
				...config.capabilities.skillRoots.map((path) => ({ path, class: path.includes(".claude/plugins") ? ("plugin" as const) : ("user" as const) })),
				// The bundled pack is always last, even when the user configures
				// roots explicitly: PRD-026's floor must not be configurable away by
				// omission, only by disabling individual skills.
				{ path: bundledRoot(), class: "bundled" as const },
			]
		: defaultSkillRoots(cwd);
	const scan = () => scanSkills(cwd, { roots: skillRoots });
	const skillRecords = scan();
	const skillControl = createSkillControl(config.skills.state, (state) => writeSkillsState(cwd, state));
	registerSkillsCommands(commands, { records: skillRecords, control: skillControl, reload: scan });
	// Runtime and UI verifiers (PRD-022): registering them turns the four kinds
	// PRD-009 left open into real verifier entries rather than `not_run`.
	registerRuntimeVerifiers();

	// The command and session surface (PRD-016). The host points at Pi's own
	// session manager: LeanPi keeps no session records of its own. The same
	// manager keys the artifact store, so a compaction record and the bytes it
	// references always resolve inside one session directory.
	registerCommandSurface(commands, {
		cwd,
		config,
		host: createSessionHost({ cwd, manager }),
		jev,
		cost: resolveCostConfig(config),
		env,
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
	registerGoalCommands(commands, { cwd, config, prd: () => readPrdState(cwd), sessionId: manager.getSessionId() });
	registerReviewCommand(commands, reviewDeps);
	registerPrdCommandsLazily(commands, { cwd, config, artifactStore: artifacts, jev });

	// The run that is still open: a compiled turn's collector and context, held from
	// `before_agent_start` until `agent_end` reports what the loop spent.
	let pendingRun: { collector: RunCollector; context: TurnContext } | undefined;

	// The per-turn fan-in: lanes write the turn's compiled state onto the context,
	// the entry points hand it back here, and the command surfaces, the working
	// state and the todo gate read it. Nothing else stores per-turn state here.
	let lastContext: TurnContext | undefined;
	const workingStateSources = workingStateSourcesFor({ cwd, todo: todoCarrier, lastContext: () => lastContext });
	const observeTurn = (context: TurnContext): void => {
		lastContext = context;
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
	});

	const declinedFor = credentialsPath(env);
	registerJevCommands(commands, {
		client: jev,
		env,
		onDeclined: () => declined.add(declinedFor),
		wasDeclined: () => declined.has(declinedFor),
	});

	// First run without a resolved key prompts exactly once; declining is a
	// first-class path that leaves the harness working on deterministic fallback.
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (resolveCredential(config, env, cwd).key !== null) return;
		if (declined.has(declinedFor)) return;
		const key = await ctx.ui.input("LeanPi needs a JEV API key (leave empty to use deterministic fallback):");
		if (!key) {
			declined.add(declinedFor);
			ctx.ui.notify("LeanPi: JEV left unconfigured — routing falls back to deterministic heuristics.", "warning");
			return;
		}
		const validation = await jev.validateKey(key);
		if (!validation.ok) {
			declined.add(declinedFor);
			ctx.ui.notify(`LeanPi: JEV key rejected (${validation.error}). Continuing on deterministic fallback.`, "error");
			return;
		}
		writeStoredKey(key, env);
		ctx.ui.notify(`LeanPi: JEV configured (model ${validation.modelVersion}).`, "info");
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
		if (context.contract && !owns) {
			const ref = resolveRole(config, context.contract.routing.executor_class);
			const model = ctx.modelRegistry.find(ref.backend, ref.model);
			if (model) {
				await pi.setModel(model);
				installed = `${ref.backend}/${ref.model}`;
			}
			pi.setThinkingLevel(context.contract.reasoning.effort);
		}
		// "Tell me your goal, I figure out the rest" is only trustworthy if the
		// figuring is visible: the footer carries what this turn routed to, how
		// hard it was told to think, and what it was classified as.
		//
		// `installed` is the model Pi was *given*, which is not always the one the
		// contract asked for: an `external_harness` class has no entry in Pi's
		// registry, `setModel` is skipped, and Pi keeps running the session model.
		// Naming the contract's choice there would report a route that did not
		// happen — the one failure this line exists to prevent.
		if (context.contract) {
			ctx.ui.setStatus(
				LEANPI_STATUS_KEY,
				statusLine({
					config,
					contract: context.contract,
					lane: owns ? "executor" : "pi_loop",
					...(owns || installed !== undefined ? {} : { model: sessionModelFor(config) ?? "pi's own model" }),
					prdWanted: context.contract.task.planning_decision === "PRD_REQUIRED" && context.prd === undefined,
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

	// PRD-015's sink for the path Pi itself drives: one call per assistant message
	// the loop produced, plus the tool calls it made, then exactly one record.
	pi.on("agent_end", (event) => {
		const run = pendingRun;
		pendingRun = undefined;
		setLaneCollector(undefined);
		if (!run) return;
		const spend = callsFromMessages(event.messages, run.context.modelRef);
		for (const call of spend.calls) run.collector.add(call);
		run.collector.noteToolCall(spend.toolCalls);
		emitRunTelemetry(run.collector, run.context.contract as ExecutionContract, verdictOf(run.context), {
			cwd,
			cost: resolveCostConfig(config),
			...(run.context.executor?.route_cost ? { routeCost: run.context.executor.route_cost } : {}),
		});
	});

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
	};
}

export default activate;

/** Credential paths the user has declined this process; they are not prompted again. */
const declined = new Set<string>();

export interface CreateLeanPiSessionOptions {
	cwd?: string;
	agentDir?: string;
	config?: LeanPiConfig;
	sessionManager?: SessionManager;
	env?: CredentialEnv;
	commands?: CommandRegistry;
	jevTransport?: import("./jev/client.js").JevTransport;
	/** Injected so a test can answer the first-run prompt without a TUI. */
	uiInput?: (message: string) => Promise<string | undefined>;
	/** Overrides the model chosen for the initial turn, e.g. for `/model`. */
	model?: string | { provider: string; model: string };
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
	let activation: LeanPiActivation | undefined;
	const services = await createAgentSessionServices({
		cwd,
		agentDir: options.agentDir,
		resourceLoaderOptions: {
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
					activation = activate(pi, {
						cwd,
						config: options.config,
						env: options.env,
						commands: options.commands,
						jevTransport: options.jevTransport,
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
	const model = services.modelRuntime.getModel(ref.provider, ref.model);
	if (!model) {
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
		// The allowlist admits the LSP tools to the registry; the mode, applied per
		// turn by `runTurn`, decides which of them are active. They start inactive
		// (§15), exactly as the LSP tool tests boot their session.
		tools: [...BASELINE_TOOL_NAMES, ...LSP_TOOL_NAMES, ARTIFACT_TOOL_NAME],
	});
	// The five baseline names plus the expand affordance: the LSP tools stay
	// inactive until a turn's mode selects its group.
	session.setActiveToolsByName([...BASELINE_TOOL_NAMES, ARTIFACT_TOOL_NAME]);

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
export { BASELINE_TOOL_NAMES, baselineToolDefinitions, registerBaselineTools } from "./core/tools.js";
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
export { laneLoads, openPrdLane, registerPrdCommandsLazily, resetLaneLoads } from "./prd/dispatch.js";
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
