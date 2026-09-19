/**
 * `compileTask` — the composition point (PRD-004 Phases 3 and 4).
 *
 * Every JEV answer that enters here is a scalar, enum or score; the contract is
 * assembled in ordinary code. `compileTask(request, packet, deviations?)` is the
 * single compile entry point — no other module exposes a second one — and JEV-off
 * is a first-class path, so a JEV failure never throws out of this function (§49).
 */
import type { JevClient } from "../jev/client.js";
import { resolvedDefaults } from "../permissions/trust.js";
import type { JevQuestion, JevResult, JevUsage } from "../jev/types.js";
import type { LeanPiConfig } from "../core/types.js";
import type { TaskPacket } from "../scout/index.js";
import { classifyExecution, classifyReviewRisk, deriveRequiredCapability } from "./classify.js";
import type {
	CapabilityProvider,
	CapabilitySlots,
	CompileRecord,
	DeviationInput,
	ExecutionComplexity,
	ExecutionContract,
	SiteTelemetryRow,
} from "./contract.js";
import { runGate } from "./gate.js";
import { applyDeviations, matrixDefault } from "./route.js";
import { createTaskState, deepFreeze } from "./state.js";

export interface CompilerContext {
	client: Pick<JevClient, "ask" | "fallbackCount"> & Partial<Pick<JevClient, "lastUsage">>;
	config: LeanPiConfig;
	cwd?: string;
}

let context: CompilerContext | undefined;
const providers: CapabilityProvider[] = [];
const records = new WeakMap<ExecutionContract, CompileRecord>();

/** Called by `activate()`; a compiler with no context resolves every site deterministically. */
export function setCompilerContext(next: CompilerContext | undefined): void {
	context = next;
}

export function getCompilerContext(): CompilerContext | undefined {
	return context;
}

/** PRD-005/006/018/019 register their provider here; nothing else is abstracted. */
export function registerCapabilityProvider(provider: CapabilityProvider): void {
	providers.push(provider);
}

export function clearCapabilityProviders(): void {
	providers.length = 0;
}

/** The per-compile record: telemetry rows, classification detail and the task state. */
export function compileRecordOf(contract: ExecutionContract): CompileRecord | undefined {
	return records.get(contract);
}

const CONTEXT_BY_COMPLEXITY = {
	LOW: { strategy: "targeted" as const, budget_tokens: 6000 },
	MEDIUM: { strategy: "targeted" as const, budget_tokens: 12000 },
	HIGH: { strategy: "broad" as const, budget_tokens: 24000 },
};

const EFFORT_BY_COMPLEXITY = { LOW: "low", MEDIUM: "medium", HIGH: "high" } as const;

const VERIFICATION_BY_COMPLEXITY: Record<ExecutionComplexity, string[]> = {
	LOW: ["typecheck", "affected_tests"],
	MEDIUM: ["typecheck", "affected_tests", "targeted_runtime"],
	HIGH: ["typecheck", "affected_tests", "integration", "runtime_smoke"],
};

const ATTEMPTS_BY_COMPLEXITY = { LOW: 2, MEDIUM: 3, HIGH: 4 } as const;

const ZERO_TOKENS: JevUsage = { inputTokens: 0, outputTokens: 0 };

/** A JEV client that is never reachable: every site resolves through its fallback. */
const unavailable: CompilerContext["client"] = {
	ask: (_siteId: string, _questions: JevQuestion[], _state: unknown): Promise<JevResult[]> => Promise.reject(new Error("JEV unavailable")),
	fallbackCount: () => 0,
	lastUsage: () => ZERO_TOKENS,
};

const DEFAULT_THRESHOLDS = { gate_prd_required: 0.5, complexity: 0.5, review_risk: 0.5 };

/** A config stand-in for a compile with no session (tests, CLI probes). */
function fallbackConfig(): LeanPiConfig {
	return {
		configPath: null,
		backends: {},
		models: {},
		instructions: { ponytail: true },
		jev: { apiKey: null, endpoint: "", model: "", mode: "disabled" },
		capabilities: { skillRoots: [], mcpConfigPaths: [] },
		skills: { maxLoaded: 3, state: {} },
		bench: { skills: { maxUnnecessaryLoadRate: 0.04 } },
		context: { artifact_threshold_bytes: 32_768, compaction_threshold_bytes: 48_000, working_state_max_bytes: 3000 },
		lsp: { mode: "auto", servers: {} },
		permissions: resolvedDefaults(),
		limits: { executionAttempts: 2, semanticReviewRounds: 1 },
		thresholds: DEFAULT_THRESHOLDS,
	};
}

/** Which lane the planning decision dispatches to next; PRD-012 owns the PRD lane. */
function dispatchFor(prdRequired: boolean): "prd_lane" | "executor_lane" {
	return prdRequired ? "prd_lane" : "executor_lane";
}

export type NextStage = ReturnType<typeof dispatchFor>;

export async function compileTask(
	request: string,
	packet: TaskPacket,
	deviations: DeviationInput[] = [],
): Promise<ExecutionContract> {
	const active = context;
	const client = active?.client ?? unavailable;
	const config = active?.config ?? fallbackConfig();
	const state = createTaskState();

	const gate = await runGate({ client, request, packet, config });
	const complexity = await classifyExecution({ client, request, packet, config });
	const capability = await deriveRequiredCapability({ client, request, packet, config, band: complexity.band });
	const risk = await classifyReviewRisk({ client, request, packet, elevateReview: gate.elevateReview });

	const defaults = matrixDefault(gate.decision === "PRD_REQUIRED", complexity.complexity, risk.review_risk);
	const { routing, deviation } = applyDeviations(defaults, deviations);

	const slots: CapabilitySlots = {
		skills: [],
		mcps: [],
		lsp: packet.workspace.lsp_available,
		rtk: "auto",
	};
	const contract: ExecutionContract = {
		task: {
			type: inferTaskType(request),
			prd_required: gate.decision === "PRD_REQUIRED",
			planning_decision: gate.decision,
			execution_complexity: complexity.complexity,
			review_risk: risk.review_risk,
			required_capability: capability.required_capability,
			user_request: request,
		},
		routing: {
			executor_class: routing.executor_class,
			executor_backend: "unresolved",
			reviewer_class: routing.reviewer_class,
			...(deviation ? { deviation } : {}),
		},
		reasoning: { effort: EFFORT_BY_COMPLEXITY[complexity.complexity] },
		capabilities: slots,
		context: CONTEXT_BY_COMPLEXITY[complexity.complexity],
		verification: { required: [...VERIFICATION_BY_COMPLEXITY[complexity.complexity]] },
		limits: {
			execution_attempts: ATTEMPTS_BY_COMPLEXITY[complexity.complexity],
			semantic_review_rounds: routing.reviewer_class === "none" ? 0 : routing.reviewer_class === "review_quick" ? 1 : 2,
		},
	};

	// Providers fill the declared slots; with none registered the defaults stand.
	for (const provider of providers) {
		const value = await provider.supply(contract, packet);
		if (value === undefined) continue;
		contract.capabilities = { ...contract.capabilities, [provider.kind]: value } as CapabilitySlots;
	}

	const telemetry: SiteTelemetryRow[] = [
		{ site_id: "gate.prd_required", answer: gate.decision, confidence: gate.confidence, fallback_used: gate.fallbackUsed, tokens: gate.tokens },
		{
			site_id: "classify.execution_complexity",
			answer: complexity.band,
			confidence: complexity.confidence,
			fallback_used: complexity.fallbackUsed,
			tokens: complexity.tokens,
		},
		{
			site_id: "classify.required_capability",
			answer: capability.required_capability.min_coding_index,
			confidence: capability.confidence,
			fallback_used: capability.fallbackUsed,
			tokens: capability.tokens,
		},
		{
			site_id: "classify.review_risk_input",
			answer: risk.review_risk,
			confidence: risk.confidence,
			fallback_used: risk.fallbackUsed,
			tokens: risk.tokens,
		},
	];

	state.recordPlanning({ decision: gate.decision, contract_frozen: true });
	deepFreeze(contract);
	records.set(contract, {
		contract,
		next_stage: dispatchFor(contract.task.prd_required),
		classification: {
			execution_band: complexity.band,
			execution_complexity: complexity.complexity,
			review_risk: risk.review_risk,
			required_capability: capability.required_capability,
			planning_decision: gate.decision,
		},
		telemetry,
		state,
	});

	return contract;
}

function inferTaskType(request: string): string {
	if (/\b(fix\w*|bug\w*|crash\w*|regress\w*|broken|fail\w*)\b/i.test(request)) return "bugfix";
	if (/\b(add\w*|implement\w*|feature\w*|support\w*|introduc\w*)\b/i.test(request)) return "feature";
	if (/\b(refactor\w*|rename\w*|cleanup|tidy)\b/i.test(request)) return "refactor";
	if (/\b(replac\w*|migrat\w*|rewrit\w*|redesign\w*)\b/i.test(request)) return "migration";
	return "task";
}

export { createTaskState } from "./state.js";
export type { TaskState } from "./state.js";
