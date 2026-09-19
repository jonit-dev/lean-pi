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
	type Lane,
	type TurnContext,
	type TurnInput,
} from "./commands/session.js";
import { commandRegistry, type CommandRegistry } from "./commands/registry.js";
import { registerJevCommands } from "./commands/jev.js";
import { ConfigError, loadConfig } from "./core/config.js";
import { buildStaticPrefix } from "./core/instructions/prefix.js";
import { LEANPI_EXTENSION_NAME, LEANPI_VERSION } from "./core/package-info.js";
import { setCompilerContext } from "./compiler/index.js";
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
	const config = options.config ?? loadConfig(cwd);
	registerBackends(pi, config);
	const tools = registerBaselineTools(pi, cwd);
	installExecutorPrefix(pi, () => buildStaticPrefix(config));

	const env = options.env ?? process.env;
	const commands = options.commands ?? commandRegistry;
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
