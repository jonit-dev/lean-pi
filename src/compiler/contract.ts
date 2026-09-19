/**
 * The §8 execution contract (PRD-004).
 *
 * Owned here; every other PRD imports it. The shape mirrors ROADMAP §8 exactly
 * plus the two documented additions — `task.required_capability` and
 * `routing.deviation` — because JEV never generates this object: the compiler
 * composes it from atomic answers in ordinary code (§8).
 */
import type { ModelRole, SelectedSkill } from "../core/types.js";
import type { TaskPacket } from "../scout/index.js";
import type { TaskState } from "./state.js";

export type PlanningDecision = "PRD_REQUIRED" | "DIRECT_EXECUTION" | "UNCERTAIN";

export type ExecutionBand = "E0" | "E1" | "E2" | "E3";
export type ExecutionComplexity = "LOW" | "MEDIUM" | "HIGH";
export type ReviewRisk = "R0" | "R1" | "R2" | "R3";

export type ExecutorClass = Extract<ModelRole, "quick" | "balanced" | "strong" | "specialist">;
export type ReviewerClass = "none" | Extract<ModelRole, "review_quick" | "review_strong">;

/** A numeric floor plus an optional specialization tag — an annotation, never a model id. */
export interface RequiredCapability {
	min_coding_index: number;
	specialization?: string;
}

export type DeviationKind =
	| "model_availability"
	| "subscription_availability"
	| "quota_reserves"
	| "historical_performance"
	| "language_specialization"
	| "latency"
	| "backend_failure";

export interface DeviationInput {
	kind: DeviationKind;
	/** The class the input applies to, when it applies to one. */
	executor_class?: ExecutorClass;
	available?: boolean;
	reason: string;
}

export interface RouteDeviation {
	/** The matrix default that was departed from. */
	from: ExecutorClass;
	to: ExecutorClass;
	reason: string;
}

export interface RoutingBlock {
	executor_class: ExecutorClass;
	/** Logical class plus `'unresolved'`: PRD-008's backend registry resolves it. */
	executor_backend: "unresolved";
	reviewer_class: ReviewerClass;
	deviation?: RouteDeviation;
}

export interface CapabilitySlots {
	skills: SelectedSkill[];
	mcps: unknown[];
	lsp: boolean;
	rtk: "auto" | "off";
}

/** One interface, four named future implementations (PRD-005/006/018/019). */
export interface CapabilityProvider {
	kind: "skills" | "mcps" | "lsp" | "rtk";
	supply(draft: ExecutionContract, packet: TaskPacket): unknown;
}

export interface ExecutionContract {
	task: {
		type: string;
		prd_required: boolean;
		planning_decision: PlanningDecision;
		execution_complexity: ExecutionComplexity;
		review_risk: ReviewRisk;
		required_capability: RequiredCapability;
		user_request: string;
	};
	routing: RoutingBlock;
	reasoning: { effort: "low" | "medium" | "high" };
	capabilities: CapabilitySlots;
	context: { strategy: "targeted" | "broad"; budget_tokens: number };
	verification: { required: string[] };
	limits: { execution_attempts: number; semantic_review_rounds: number };
}

/** Per-site telemetry row; PRD-015 aggregates this shape and PRD-016 prints it. */
export interface SiteTelemetryRow {
	site_id: string;
	answer: string | number | boolean;
	confidence: number;
	fallback_used: boolean;
	tokens: { inputTokens: number; outputTokens: number };
}

export interface CompileClassification {
	execution_band: ExecutionBand;
	execution_complexity: ExecutionComplexity;
	review_risk: ReviewRisk;
	required_capability: RequiredCapability;
	planning_decision: PlanningDecision;
}

export interface CompileRecord {
	contract: ExecutionContract;
	/** The lane the planning decision dispatches to next: PRD lane or executor lane. */
	next_stage: "prd_lane" | "executor_lane";
	classification: CompileClassification;
	telemetry: SiteTelemetryRow[];
	state: TaskState;
}
