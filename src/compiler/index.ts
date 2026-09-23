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
import { targetedRunsWithoutScope, targetedSurfaceOf } from "../verify/select.js";
import { classifyExecution, classifyReviewRisk, deriveRequiredCapability } from "./classify.js";
import type {
	AcceptanceCriterion,
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
import { selectRuntimeVerifiers } from "../runtime/planner.js";
import { createTaskState, deepFreeze } from "./state.js";
import { applyRoutePins, pinnedDecision, routePins } from "./pins.js";

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

/**
 * The effort a complexity class is billed at.
 *
 * `low`/`medium`/`high` are real gradations on most endpoints but not on the
 * measured one, whose wire control is binary — so `low` costs what `high` does
 * there, and the only *tested* money decision on that endpoint is thinking on or
 * off. Turning thinking off is not obviously better: blanket `off` was 27.5%
 * worse **per verified solve** ($0.055814/4 = $0.01395 against $0.053362/3 =
 * $0.01779), and on this suite the task that got cheaper with `off` (`express`,
 * ×0.54) is not the one a heuristic calls simplest — its `slugify` verdict sent
 * the task whose cost *rose* under `off` ($0.006212 → $0.008480) to no thinking.
 * A class-gated `off` therefore needs a classifier that picks the winners and a
 * measurement that shows it; until then the classes keep thinking.
 */
const EFFORT_BY_COMPLEXITY = { LOW: "low", MEDIUM: "medium", HIGH: "high" } as const;

const VERIFICATION_BY_COMPLEXITY: Record<ExecutionComplexity, string[]> = {
	LOW: ["typecheck", "affected_tests"],
	// Canonical PRD-009/PRD-022 verifier kinds only: a kind outside that union is
	// reported as unsupported and can never be satisfied, so a contract that
	// required one would be unverifiable by construction. `runtime_smoke` is not
	// here: it is required only when the contract actually declares a smoke plan
	// (see `compileTask`), because a facility nothing can satisfy is a guaranteed
	// `not_run` that blocks every MEDIUM/HIGH turn.
	MEDIUM: ["typecheck", "affected_tests"],
	HIGH: ["typecheck", "affected_tests", "full_suite"],
};

const ATTEMPTS_BY_COMPLEXITY = { LOW: 2, MEDIUM: 3, HIGH: 4 } as const;

/** Escalations are bounded separately from attempts, and never grant extra attempts. */
const MAX_ESCALATIONS_BY_COMPLEXITY = { LOW: 1, MEDIUM: 2, HIGH: 2 } as const;

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
		jev: { apiKey: null, endpoint: "", model: "", mode: "disabled", usd_per_mtok: 0, provider: "typesafe", laya: {} },
		capabilities: { skillRoots: [], mcpConfigPaths: [] },
		skills: { maxLoaded: 3, state: {} },
		bench: { skills: { maxUnnecessaryLoadRate: 0.04 } },
		context: { artifact_threshold_bytes: 32_768, compaction_threshold_bytes: 48_000, working_state_max_bytes: 3000 },
		lsp: { mode: "auto", servers: {} },
		mcp: { maxTools: 6, state: {} },
		capability: { rankingFile: null, stalenessDays: 90, roles: {} },
		recap: { enabled: true, role: "quick" },
		verify: { commands: {} },
		permissions: resolvedDefaults(),
		limits: { isolation: "none" },
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
	/** The request already has its plan (a PRD it names, a running goal): no PRD gate. */
	planned = false,
): Promise<ExecutionContract> {
	const active = context;
	const client = active?.client ?? unavailable;
	const config = active?.config ?? fallbackConfig();
	const state = createTaskState();

	// Two dependency chains, not four sequential round-trips: risk needs the
	// gate's `elevateReview` and capability needs the complexity band, but the
	// chains need nothing from each other. Run them side by side — every prompt
	// waits on this, so the turn starts a full JEV round-trip sooner.
	const [[gate, risk], [complexity, capability]] = await Promise.all([
		(async () => {
			const gate = await runGate({ client, request, packet, config });
			return [gate, await classifyReviewRisk({ client, request, packet, elevateReview: gate.elevateReview })] as const;
		})(),
		(async () => {
			const complexity = await classifyExecution({ client, request, packet, config });
			return [complexity, await deriveRequiredCapability({ client, request, packet, config, band: complexity.band })] as const;
		})(),
	]);
	// PRD-016's session pins decide the gate outcome and the two classes; the
	// classifier and the §14 matrix stay the source of every unpinned value.
	const pins = routePins();
	const decision = pinnedDecision(planned ? "DIRECT_EXECUTION" : gate.decision, pins);

	const defaults = matrixDefault(decision === "PRD_REQUIRED", complexity.complexity, risk.review_risk);
	const { routing: classified, deviation } = applyDeviations(defaults, deviations);
	const routing = applyRoutePins(classified, pins);

	const slots: CapabilitySlots = {
		skills: [],
		mcps: [],
		lsp: packet.workspace.lsp_available,
		rtk: "auto",
	};
	// A contract may not demand a check no surface can name: `affected_tests` is
	// required only when a surface exists — the test files this task changed, or a
	// configured command that runs without one. An unnamed targeted test resolves
	// no command, records `not_run`, and leaves every external-harness turn
	// blocked on a verifier that could never have run.
	const targetedSurface = targetedSurfaceOf(packet.workspace.changed_files);
	const requiredVerifiers = VERIFICATION_BY_COMPLEXITY[complexity.complexity].filter(
		(kind) => kind !== "affected_tests" || targetedSurface.length > 0 || targetedRunsWithoutScope(config.verify?.commands ?? {}),
	);
	// A direct task's single acceptance criterion is the request itself; the PRD
	// lane replaces this list with the PRD's own criteria.
	const acceptanceCriteria: AcceptanceCriterion[] = [{ id: "AC-1", text: request }];
	// PRD-022's runtime declarations come from the trusted `verify.runtime` block;
	// they are copied verbatim (already validated at load) into the contract, which
	// is what `runtimePlanOf` and the planner read.
	const runtimePlan = config.verify?.runtime;
	const contract: ExecutionContract = {
		task: {
			type: inferTaskType(request),
			prd_required: decision === "PRD_REQUIRED",
			planning_decision: decision,
			execution_complexity: complexity.complexity,
			review_risk: risk.review_risk,
			required_capability: capability.required_capability,
			user_request: request,
			objective: request,
			acceptance_criteria: acceptanceCriteria,
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
		verification: {
			required: requiredVerifiers,
			...(runtimePlan && Object.keys(runtimePlan).length > 0 ? { runtime: runtimePlan } : {}),
			// PRD-009 attributes evidence per criterion (FR-124), and the targeted
			// surface is what each criterion is proved by. A packet that names no
			// test file declares no scope, so no criterion claims one.
			...(targetedSurface.length > 0
				? { criteria: acceptanceCriteria.map((criterion) => ({ id: criterion.id, verifiers: ["affected_tests"], scope: targetedSurface })) }
				: {}),
		},
		limits: {
			// An explicit configured ceiling wins; an absent one keeps the
			// complexity-derived default. `0` is a real, explicit bound.
			execution_attempts: config.limits.executionAttempts ?? ATTEMPTS_BY_COMPLEXITY[complexity.complexity],
			max_escalations: config.limits.max_escalations ?? MAX_ESCALATIONS_BY_COMPLEXITY[complexity.complexity],
			semantic_review_rounds:
				config.limits.semanticReviewRounds ??
				(routing.reviewer_class === "none" ? 0 : routing.reviewer_class === "review_quick" ? 1 : 2),
			isolation: config.limits.isolation,
		},
	};
	// A declared runtime surface is a required check, selected by the planner's
	// declared-surface rule. It is appended after the contract carries the plan so
	// the planner reads the same block the contract ships; an absent plan selects
	// nothing and demands no smoke facility.
	if (runtimePlan) {
		const selected = selectRuntimeVerifiers(contract);
		for (const kind of selected) if (!contract.verification.required.includes(kind)) contract.verification.required.push(kind);
	}

	// Providers fill the declared slots; with none registered the defaults stand.
	for (const provider of providers) {
		const value = await provider.supply(contract, packet);
		if (value === undefined) continue;
		contract.capabilities = { ...contract.capabilities, [provider.kind]: value } as CapabilitySlots;
	}

	const telemetry: SiteTelemetryRow[] = [
		{
			site_id: "gate.prd_required",
			answer: decision,
			confidence: pins.prd_required === undefined ? gate.confidence : 1,
			// A pinned gate was decided by the session, not by JEV: the row says so.
			fallback_used: pins.prd_required === undefined ? gate.fallbackUsed : true,
			tokens: gate.tokens,
		},
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

	state.recordPlanning({ decision, contract_frozen: true });
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
			gate_confident: gate.confident,
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
