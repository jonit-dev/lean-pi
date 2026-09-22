/**
 * Core shared types (PRD-001).
 *
 * A *model* is not an *execution backend* (ROADMAP §23): a role resolves to a
 * `BackendRef`, and the backend entry carries ROADMAP §25's `type` discriminant
 * — `native` (LeanPi owns the Pi agent loop) versus `external_harness` (a
 * bounded job delegated to another harness, owned by PRD-008).
 */
import type { Api } from "@earendil-works/pi-ai";
// The session's own level vocabulary, which includes `off`: pi-ai's
// `ThinkingLevel` is the subset a request can ask for.
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ResolvedPermissions } from "../permissions/trust.js";
// The runtime plan's shape is owned by `runtime/plan.ts`; the config only carries
// it. A type-only import, so this module stays free of the runtime lane.
import type { RuntimePlan } from "../runtime/plan.js";

/**
 * Pi's session thinking levels, in ascending effort. A config value outside this
 * list is a named error rather than a level Pi would silently clamp.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Logical executor/reviewer classes (FR-041–FR-043). Routing never names a vendor. */
export const MODEL_ROLES = ["quick", "balanced", "strong", "specialist", "review_quick", "review_strong"] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export function isModelRole(value: string): value is ModelRole {
	return (MODEL_ROLES as readonly string[]).includes(value);
}

/** ROADMAP §25's backend discriminant, parsed verbatim by PRD-008. */
export const BACKEND_TYPES = ["native", "external_harness"] as const;

export type BackendType = (typeof BACKEND_TYPES)[number];

/** A concrete model on a concrete backend. */
export interface BackendRef {
	backend: string;
	model: string;
	type: BackendType;
}

/** One `models:` entry: the backend that serves a role, and the model id it runs on it. */
export interface ModelBinding {
	backend: string;
	model: string;
}

/**
 * The `models:` block. The six roles are the §27 map; `specialists` (FR-047) is a
 * separate map from a language or task-type key to the role that serves it, so its
 * keys are not roles and it is not a role entry.
 */
export type ModelsConfig = Partial<Record<ModelRole, ModelBinding>> & { specialists?: Record<string, ModelRole> };

/** The `verify:` block (PRD-009/PRD-018): the host project's own verifier commands. */
export interface VerifyConfig {
	commands: Partial<Record<string, string>>;
	timeoutMs?: number;
	/**
	 * PRD-022's runtime declarations (smoke/CLI/browser/screenshot). The compiler
	 * copies this into `verification.runtime`, which is what selects and drives the
	 * runtime verifiers. An untrusted project contributes no runtime block.
	 */
	runtime?: RuntimePlan;
}

/** Configuration of one backend. Local/self-hosted backends are ordinary `native` entries. */
export interface BackendConfig {
	type: BackendType;
	/** OpenAI-compatible (or Pi-supported) endpoint for `native` backends. */
	baseUrl?: string;
	/** Pi API identifier, e.g. `openai-completions`. */
	api?: Api;
	/** Literal API key or the name of the environment variable holding it. */
	apiKey?: string;
	/** Display name. */
	name?: string;
	/** Executable for `external_harness` backends (PRD-008). */
	command?: string;
	/**
	 * Pi's model compatibility overrides. Pi detects an endpoint's dialect from
	 * the provider id and base URL, and a native backend carries the operator's
	 * own name for it, so a vendor that does not speak OpenAI's
	 * `reasoning_effort` (e.g. one served with DeepSeek's `thinking` field) has
	 * to declare it here or Pi sends no thinking control at all.
	 */
	compat?: Record<string, unknown>;
	/**
	 * The thinking level this backend's turns run at when the compiler decided
	 * none — a native backend compiles no contract, so without it such a turn
	 * runs at whatever level the session carries. `off` is a real value: it is
	 * the only one most vendors read as "do not think". Mirrors Pi's session
	 * levels, and is validated against them at parse time so a typo cannot
	 * silently become a different spend.
	 */
	thinkingLevel?: ThinkingLevel;
	enabled?: boolean;
	[key: string]: unknown;
}

export type JevMode = "enabled" | "disabled" | "metadata-only" | "redacted";

/**
 * Which implementation answers the registered decision sites (PRD-042).
 * `typesafe` is the hosted service and the default; `laya` is a local model.
 */
export type JevProvider = "typesafe" | "laya";

/** The local Laya runtime (PRD-042). Every field has a working default. */
export interface LayaConfig {
	/** Attach to an already-running JEV-contract server instead of managing one. */
	endpoint?: string;
	/** Managed runtime root; `$XDG_DATA_HOME/leanpi/laya` when absent. */
	home?: string;
	/** `auto` uses CUDA when a CUDA GPU is present. */
	device?: "auto" | "cuda" | "cpu";
	/** Laya checkpoint subfolder; absent is the English root checkpoint. */
	checkpoint?: string;
	/** `false` makes a missing runtime a clear error instead of a download. */
	autoSetup?: boolean;
	/** Managed server port; 0 (default) picks a free one. */
	port?: number;
}

export interface JevConfig {
	/** Resolution slot, never a stored secret: explicit config wins over store/env. */
	apiKey?: string | null;
	endpoint?: string;
	model?: string;
	mode?: JevMode;
	/** USD per million JEV tokens; absent prices JEV at 0. */
	usd_per_mtok?: number;
	/** Which implementation answers the sites (PRD-042); `typesafe` when absent. */
	provider?: JevProvider;
	/** Local runtime settings, read when `provider: laya` (PRD-042). */
	laya?: LayaConfig;
}

/**
 * The top-level `cost:` block (PRD-015), carried through `loadConfig` so
 * `resolveCostConfig` reads the declared policy rather than an empty object.
 * Per-backend rates stay under `backends.<name>.cost`.
 */
export interface CostBlockConfig {
	/** Per-model override, keyed by model id. */
	models?: Record<string, Partial<{ input: number; cachedInput: number; cacheWrite: number; output: number }>>;
	/** USD charged per call of a quota class (PRD-020 reads this same key). */
	quota_shadow_usd?: Record<string, number>;
	local_usd_per_gpu_sec?: number;
	latency_usd_per_sec?: number;
	/** Store location override; `.leanpi/telemetry.jsonl` when absent. */
	telemetry_path?: string;
}

/** A resolved skill body handed to the executor request; PRD-005 fills the slot. */
export interface SelectedSkill {
	name: string;
	source: string;
	body: string;
}

export interface InstructionsConfig {
	ponytail?: boolean;
}

export interface SkillsConfig {
	maxLoaded?: number;
	state?: Record<string, { enabled?: boolean; pinned?: boolean }>;
}

export interface CapabilitiesConfig {
	skillRoots?: string[];
	/** Project-scope MCP config files; the trust surface hashes them (PRD-017). Default `.leanpi/mcp.json`. */
	mcpConfigPaths?: string[];
}

export interface LimitsConfig {
	executionAttempts?: number;
	semanticReviewRounds?: number;
	/**
	 * Overrides the complexity-derived escalation ceiling. Absent keeps the
	 * compiler's per-complexity default; a configured value must be a
	 * non-negative integer (PRD-007 §33).
	 */
	max_escalations?: number;
	/** Where the executor works: `none` in place, `worktree` in an owned checkout (PRD-022). */
	isolation?: "none" | "worktree";
}

/**
 * The `workspace:` block (PRD-022). `worktreeRoot` overrides where an isolated
 * run's checkout is created; relative paths resolve against the owning
 * repository. The default is `<primary-repo>/.worktrees`.
 */
export interface WorkspaceConfig {
	worktreeRoot?: string;
}

/** Calibration surface §10 requires: thresholds are configuration, never literals in a branch. */
export interface ThresholdsConfig {
	gate_prd_required: number;
	complexity: number;
	review_risk: number;
}

/** Model capability ranking surface (PRD-024): the bundled file, its staleness window and per-role floors. */
export interface CapabilityRoleSetting {
	min_coding_index?: number;
	max_blended_price?: number;
	pin?: string;
}

export interface CapabilitySetting {
	rankingFile?: string | null;
	stalenessDays?: number;
	roles?: Partial<Record<ModelRole, CapabilityRoleSetting>>;
}

/** MCP disclosure surface (PRD-006): the admitted-tool cap and the persisted enable/disable/pin state. */
export interface McpConfig {
	maxTools?: number;
	state?: Record<string, { enabled?: boolean; pinned?: boolean }>;
}

/** LSP integration surface (PRD-018): `auto` decides per task; `servers` overrides a language's command. */
export interface LspConfig {
	mode?: "off" | "diagnostics" | "navigation" | "full" | "auto";
	servers?: Record<string, string>;
}

/** Turn recap (PRD-036): whether to generate one, and which role pays for it. */
export interface RecapConfig {
	enabled?: boolean;
	role?: ModelRole;
}

/**
 * The top-level `routing:` block (PRD-020): the calibration and policy knobs
 * `resolveRoutingConfig` reads. Carried through `loadConfig` so a file's values
 * reach the router instead of being dropped in favour of the shipped defaults.
 */
export interface RoutingBlockConfig {
	predicted_input_tokens?: number;
	predicted_output_tokens?: number;
	predicted_cached_input_fraction?: number;
	effort_token_multiplier?: Partial<Record<"minimal" | "low" | "medium" | "high", number>>;
	effort_by_complexity?: Partial<Record<"LOW" | "MEDIUM" | "HIGH", "minimal" | "low" | "medium" | "high">>;
	retry_effort_threshold?: number;
	matrix_retry_rate?: number;
	min_bucket_runs?: number;
	/** Candidates within this many USD may be reordered by `routing.quota_preference`. */
	tie_band_usd?: number;
	delegation_slice_threshold?: number;
	local_gpu_seconds?: number;
	latency_ms?: number;
	/** Per-site switches, keyed by `routing.<site>` id. */
	sites?: Partial<Record<string, boolean>>;
}

/** Context engine budgets (PRD-014): artifact threshold, compaction trigger, state ceiling. */
export interface ContextConfig {
	artifact_threshold_bytes: number;
	compaction_threshold_bytes: number;
	working_state_max_bytes: number;
}

export interface BenchConfig {
	skills: { maxUnnecessaryLoadRate: number };
}

/** The §27 role map plus its configuration surface. */
export interface LeanPiConfig {
	/** Path the config was loaded from, or null when defaults were used. */
	configPath: string | null;
	backends: Record<string, BackendConfig>;
	models: ModelsConfig;
	instructions: Required<InstructionsConfig>;
	jev: Required<Omit<JevConfig, "apiKey">> & { apiKey: string | null };
	capabilities: Required<CapabilitiesConfig>;
	skills: Required<Omit<SkillsConfig, "state">> & { state: NonNullable<SkillsConfig["state"]> };
	bench: BenchConfig;
	context: ContextConfig;
	lsp: LspConfig;
	mcp: McpConfig;
	capability: CapabilitySetting;
	/** The declared `cost:` block; PRD-015 reads it through `resolveCostConfig`. */
	cost?: CostBlockConfig;
	/** The declared `routing:` block (PRD-020); absent means the shipped defaults. */
	routing?: RoutingBlockConfig;
	/** Turn recap (PRD-036): the one extra model call per turn, and the role it runs on. */
	recap: Required<RecapConfig>;
	/** Verifier command overrides and timeout; the table in `verify/descriptors.ts` is the default. */
	verify?: VerifyConfig;
	/** Effective permission state: built-in defaults merged with user scope, then project scope (PRD-017). */
	permissions: ResolvedPermissions;
	thresholds: ThresholdsConfig;
	/**
	 * Bounded-execution limits. Every ceiling stays absent when the operator did
	 * not configure it, so the compiler's complexity-derived defaults still apply:
	 * an absent value is not the same as an explicit `0`.
	 */
	limits: {
		executionAttempts?: number;
		semanticReviewRounds?: number;
		max_escalations?: number;
		isolation: "none" | "worktree";
	};
	/** The declared `workspace:` block (PRD-022); absent keys fall back to the documented defaults. */
	workspace?: WorkspaceConfig;
}
