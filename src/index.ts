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
import { ConfigError, loadConfig } from "./core/config.js";
import { buildStaticPrefix } from "./core/instructions/prefix.js";
import { LEANPI_EXTENSION_NAME, LEANPI_VERSION } from "./core/package-info.js";
import { resolveRole } from "./core/roles.js";
import { BASELINE_TOOL_NAMES, registerBaselineTools } from "./core/tools.js";
import type { LeanPiConfig, ModelRole } from "./core/types.js";

export interface ActivateOptions {
	config?: LeanPiConfig;
	cwd?: string;
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
		registerLane(lane) {
			registerTurnLane(lane);
		},
	};
}

export default activate;

export interface CreateLeanPiSessionOptions {
	cwd?: string;
	agentDir?: string;
	config?: LeanPiConfig;
	sessionManager?: SessionManager;
	/** Overrides the model chosen for the initial turn, e.g. for `/model`. */
	model?: string | { provider: string; model: string };
}

export interface LeanPiSession {
	session: AgentSession;
	activation: LeanPiActivation;
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
					activation = activate(pi, { cwd, config: options.config });
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
