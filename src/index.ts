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
import type { AgentSession, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@mariozechner/pi-coding-agent";
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
import { ConfigError, loadConfig, writeSkillsState } from "./core/config.js";
import { buildStaticPrefix } from "./core/instructions/prefix.js";
import { LEANPI_EXTENSION_NAME, LEANPI_VERSION } from "./core/package-info.js";
import { clearCapabilityProviders, registerCapabilityProvider, setCompilerContext } from "./compiler/index.js";
import { installPermissionGuard, loadPermissionState, registerPermissionsCommand } from "./permissions/index.js";
import { registerCostCommand } from "./telemetry/index.js";
import { registerMcpCommand } from "./mcp/index.js";
import { createSessionHost, registerCommandSurface } from "./commands/index.js";
import { registerRuntimeVerifiers } from "./runtime/index.js";
import { resolveCostConfig } from "./telemetry/index.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultSkillRoots, scanSkills, createSkillControl } from "./capabilities/skills.js";
import { selectSkills } from "./capabilities/skill-select.js";
import { registerSkillsCommands } from "./commands/skills.js";
import { resolveRole } from "./core/roles.js";
import { BASELINE_TOOL_NAMES, registerBaselineTools } from "./core/tools.js";
import { credentialsPath, resolveCredential, writeStoredKey } from "./jev/credentials.js";
import { createJevClient, type JevClient } from "./jev/client.js";
import { createDecisionLog, decisionLogPath } from "./jev/log.js";
import type { CredentialEnv } from "./jev/credentials.js";
import type { LeanPiConfig, ModelRole } from "./core/types.js";

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
	/** The JEV control-plane client, handed to lanes by reference — never a tool. */
	readonly jev: JevClient;
}

/** Register one Pi provider per `native` backend; every role on it becomes selectable. */
function registerBackends(pi: ExtensionAPI, config: LeanPiConfig): void {
	const modelsByBackend = new Map<string, Set<string>>();
	for (const entry of Object.values(config.models)) {
		if (!entry) continue;
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
		pi.registerProvider(name, {
			name: backend.name ?? name,
			baseUrl: backend.baseUrl,
			apiKey: backend.apiKey ?? "LEANPI_BACKEND_API_KEY",
			api: backend.api ?? "openai-completions",
			models: [...declared].map((id) => ({
				id,
				name: id,
				reasoning: backend.reasoning === true,
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
	registerBackends(pi, config);
	const tools = registerBaselineTools(pi, cwd);
	installExecutorPrefix(pi, () => buildStaticPrefix(config));

	// Permission guard (PRD-017): installed after the baseline tools so the
	// guarded `execute` wins the name, and registered before any lane can run.
	// The guard reads only path-ish variables from `env`, which is the same
	// credential environment the rest of the session resolves against.
	const permissions = loadPermissionState(cwd, env as NodeJS.ProcessEnv);
	installPermissionGuard(pi, { cwd, state: permissions, env });
	registerPermissionsCommand(commands, { cwd, state: permissions, env });
	// Cost telemetry (PRD-015): `/cost` reads the same store `/status` will read.
	registerCostCommand(commands, { cwd });
	// MCP disclosure (PRD-006): `/mcp` plus the provider that fills
	// `capabilities.mcps`; registered after the provider reset above.
	registerMcpCommand(commands, { cwd, config, home: homedir(), env });
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
		? config.capabilities.skillRoots.map((path) => ({ path, class: path.includes(".claude/plugins") ? ("plugin" as const) : ("user" as const) }))
		: defaultSkillRoots(cwd);
	const scan = () => scanSkills(cwd, { roots: skillRoots });
	const skillRecords = scan();
	const skillControl = createSkillControl(config.skills.state, (state) => writeSkillsState(cwd, state));
	registerSkillsCommands(commands, { records: skillRecords, control: skillControl, reload: scan });
	// Runtime and UI verifiers (PRD-022): registering them turns the four kinds
	// PRD-009 left open into real verifier entries rather than `not_run`.
	registerRuntimeVerifiers();

	// The command and session surface (PRD-016). The host points at Pi's own
	// session manager: LeanPi keeps no session records of its own.
	registerCommandSurface(commands, {
		cwd,
		config,
		host: createSessionHost({ cwd, manager: SessionManager.create(cwd, join(cwd, ".leanpi", "sessions")) }),
		jev,
		cost: resolveCostConfig(config),
		env,
	});
	registerCapabilityProvider({
		kind: "skills",
		supply: async (draft) => {
			const selection = await selectSkills({ records: scan(), control: skillControl, request: draft.task.user_request, config, client: jev });
			return selection.skills;
		},
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
		if (resolveCredential(config, env).key !== null) return;
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
	// a second time when the prompt itself came from `runTurn()`.
	pi.on("before_agent_start", async (event) => {
		if (isTurnInFlight()) return;
		await runLanes(
			{ text: event.prompt },
			{
				turn: { text: event.prompt },
				role: "balanced",
				cwd,
				config,
				modelRef: resolveRole(config, "balanced"),
				skills: [],
				prefix: "",
			},
		);
	});

	return {
		name: LEANPI_EXTENSION_NAME,
		version: LEANPI_VERSION,
		cwd,
		config,
		tools,
		jev,
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
	const model = services.modelRegistry.find(ref.provider, ref.model);
	if (!model) {
		throw new Error(
			`Model ${ref.provider}/${ref.model} is not registered. Configure "backends.${ref.provider}.baseUrl" in leanpi.config.yaml.`,
		);
	}

	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: options.sessionManager ?? SessionManager.inMemory(),
		model,
		noTools: "builtin",
		tools: [...BASELINE_TOOL_NAMES],
	});

	return {
		session,
		activation: loaded,
		jev: loaded.jev,
		commands: options.commands ?? commandRegistry,
		leanpi: { name: LEANPI_EXTENSION_NAME, version: LEANPI_VERSION },
		runTurn: (turn) =>
			runTurn(typeof turn === "string" ? { text: turn } : turn, {
				config: loaded.config,
				cwd,
				session,
				registry: services.modelRegistry,
			}),
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
export { ConfigError, CONFIG_FILENAME, configPathFor, loadConfig, writeSkillsState } from "./core/config.js";
export { resolveRole, ROLE_FALLBACK_CHAINS, UnresolvedRoleError } from "./core/roles.js";
export { BASELINE_TOOL_NAMES, baselineToolDefinitions, registerBaselineTools } from "./core/tools.js";
export {
	clearLanes,
	getActivePrefix,
	listLanes,
	registerLane,
	renderSkillBlock,
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
export { levenshtein, upsertCommand } from "./commands/registry.js";
export type { Command, CommandInit } from "./commands/registry.js";
export { createCommandSurface, createSessionHost, OWNED_COMMANDS, registerCommandSurface } from "./commands/index.js";
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
} from "./capabilities/skills.js";
export type { ScanOptions, ScanStats, SkillControl, SkillRecord, SkillRoot, SkillStateEntry, SourceClass } from "./capabilities/skills.js";
export { lexicalSelect, registerSkillSite, selectSkills, SKILL_SITE_ID, DEFAULT_TOP_K } from "./capabilities/skill-select.js";
export type { SelectSkillsInput, SelectSkillsResult, SkillDisclosureDecision } from "./capabilities/skill-select.js";
export { registerSkillsCommands } from "./commands/skills.js";
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
