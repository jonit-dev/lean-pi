/**
 * Core shared types (PRD-001).
 *
 * A *model* is not an *execution backend* (ROADMAP §23): a role resolves to a
 * `BackendRef`, and the backend entry carries ROADMAP §25's `type` discriminant
 * — `native` (LeanPi owns the Pi agent loop) versus `external_harness` (a
 * bounded job delegated to another harness, owned by PRD-008).
 */
import type { Api } from "@mariozechner/pi-ai";
import type { ResolvedPermissions } from "../permissions/trust.js";

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
	enabled?: boolean;
	[key: string]: unknown;
}

export type JevMode = "enabled" | "disabled" | "metadata-only" | "redacted";

export interface JevConfig {
	/** Resolution slot, never a stored secret: explicit config wins over store/env. */
	apiKey?: string | null;
	endpoint?: string;
	model?: string;
	mode?: JevMode;
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
	models: Partial<Record<ModelRole, { backend: string; model: string }>>;
	instructions: Required<InstructionsConfig>;
	jev: Required<Omit<JevConfig, "apiKey">> & { apiKey: string | null };
	capabilities: Required<CapabilitiesConfig>;
	skills: Required<Omit<SkillsConfig, "state">> & { state: NonNullable<SkillsConfig["state"]> };
	bench: BenchConfig;
	context: ContextConfig;
	lsp: LspConfig;
	mcp: McpConfig;
	capability: CapabilitySetting;
	/** Effective permission state: built-in defaults merged with user scope, then project scope (PRD-017). */
	permissions: ResolvedPermissions;
	thresholds: ThresholdsConfig;
	limits: Required<LimitsConfig>;
}
