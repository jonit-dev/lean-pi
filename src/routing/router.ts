/**
 * `selectRoute()` — the adaptive router (PRD-020).
 *
 * Deterministic arithmetic over configuration, PRD-024's ranking and PRD-015's
 * telemetry; JEV never makes the final pick. The order is fixed:
 *
 * 1. the capability filter is PRD-024's `selectCheapestClearing()` — a
 *    `capability_gap` escalates and never dispatches;
 * 2. specialists (FR-047) and then the §14 matrix role act as a *preference
 *    inside the `route_cost` tie band*, so a bound role can break an
 *    equipollent choice but can never outbid a genuinely cheaper clearing
 *    candidate;
 * 3. the cheapest clearing candidate wins, ties broken by configured backend
 *    priority and then by model id;
 * 4. `routing.quota_preference` may reorder the remaining finalists, and only
 *    finalists — an answer naming anything else is ignored;
 * 5. a repeated failure signature in this run moves the route (§34) instead of
 *    re-dispatching the identical configuration.
 *
 * Effort is decided before candidates are priced because higher effort buys more
 * predicted tokens; that is what makes it feed back into `route_cost` instead of
 * being a free knob.
 */
import type { WorkerTaskPacket } from "../backends/worker.js";
import type { CapabilityGap } from "../capability/select.js";
import type { ExecutionContract, ExecutionComplexity, RequiredCapability, SiteTelemetryRow } from "../compiler/contract.js";
import { resolveRole } from "../core/roles.js";
import type { LeanPiConfig, ModelRole } from "../core/types.js";
import { answerValue, type JevQuestion, type JevResult } from "../jev/types.js";
import type { JevClient } from "../jev/client.js";
import type { RouteCostBlock, RouteDescriptor, RunTelemetry } from "../telemetry/record.js";
import { readRuns } from "../telemetry/store.js";
import { bucketStats, classifyFailure, historicalSignatures, type AttemptFailure, type CalibrationState, type FailureVerdict } from "./calibration.js";
import { defaultClearingSource, type ClearingSource } from "./candidates.js";
import { resolveRoutingConfig, type RoutingConfig } from "./config.js";
import { predictRouteCost, routeCostBlock, type RouteCandidate, type RouteCostPrediction } from "./cost.js";
import { ROUTING_SITE_IDS, type EffortLevel, type EscalationCategory } from "./defaults.js";
import {
	DELEGATION_WORTH_SITE_ID,
	EFFORT_LEVELS,
	QUOTA_PREFERENCE_SITE_ID,
	REASONING_EFFORT_SITE_ID,
	delegationQuestions,
	effortQuestions,
	fallbackDelegation,
	quotaPreferenceQuestions,
	registerRoutingSites,
} from "./sites.js";

const EFFORT_ORDER: readonly EffortLevel[] = ["minimal", "low", "medium", "high"];

/** The JEV surface the router needs; the compiler's `CompilerContext` passes the same client by reference. */
export type RoutingJevClient = Pick<JevClient, "ask" | "fallbackCount"> & Partial<Pick<JevClient, "lastUsage" | "getMode">>;

export interface ScoredCandidate {
	candidate: RouteCandidate;
	prediction: RouteCostPrediction;
}

export interface RouteRequest {
	contract: ExecutionContract;
	config: LeanPiConfig;
	/** Project root the telemetry store is read from; a supplied `history` wins over it. */
	cwd?: string;
	/** Completed runs used for calibration; defaults to the project's store. */
	history?: readonly RunTelemetry[];
	/** Declared independent slices, for `routing.delegation_worth`. */
	slices?: number;
	/** Failures of the earlier attempts of this run, in order (PRD-007 owns the loop). */
	priorAttempts?: readonly AttemptFailure[];
	client?: RoutingJevClient;
	/** Test seam: the clearing set source; defaults to PRD-024's `selectCheapestClearing()`. */
	clearing?: ClearingSource;
}

export interface RouteDecision {
	/** The candidate to dispatch; `null` only when `capability_gap` is present. */
	selected: ScoredCandidate | null;
	/** Every candidate the capability filter returned, scored. */
	candidates: ScoredCandidate[];
	/** The candidates the tie band and the quota-preference site could choose between. */
	finalists: string[];
	effort: EffortLevel;
	effort_source: "fallback" | "jev";
	delegation: "delegate" | "inline";
	delegation_source: "fallback" | "jev";
	capability_gap?: CapabilityGap;
	/** §34's category when this decision escalates; `null` when it does not. */
	escalation: EscalationCategory | null;
	/** The retry classification, when the last attempt failed. */
	failure?: FailureVerdict;
	calibration: CalibrationState;
	/** The selected candidate's predicted §26 block, ready for the run record. */
	route_cost: RouteCostBlock | null;
	telemetry: SiteTelemetryRow[];
	reason: string;
}

/** The complexity → effort table, raised one level when the bucket retries above its threshold. */
export function adjustedEffort(base: EffortLevel, retryRate: number, threshold: number): EffortLevel {
	if (retryRate <= threshold) return base;
	return EFFORT_ORDER[Math.min(EFFORT_ORDER.indexOf(base) + 1, EFFORT_ORDER.length - 1)] as EffortLevel;
}

function resolveRoleOrNull(config: LeanPiConfig, role: ModelRole): { backend: string; model: string } | null {
	try {
		const ref = resolveRole(config, role);
		return { backend: ref.backend, model: ref.model };
	} catch {
		return null;
	}
}

/** Cost first, then PRD-008's configured backend priority, then the model id. */
function better(left: ScoredCandidate, right: ScoredCandidate): number {
	return (
		left.prediction.route_cost - right.prediction.route_cost ||
		right.candidate.priority - left.candidate.priority ||
		left.candidate.id.localeCompare(right.candidate.id)
	);
}

const ZERO_TOKENS = { inputTokens: 0, outputTokens: 0 };

interface ChoiceOutcome {
	value: string | null;
	row: SiteTelemetryRow;
}

/**
 * One confidence-gated site consultation. A disabled site, an absent client, an
 * unreachable endpoint and an answer outside `options` all resolve to the
 * deterministic fallback, and the row records that it did.
 */
async function askChoice(
	client: RoutingJevClient | undefined,
	options: {
		siteId: string;
		enabled: boolean;
		questions: JevQuestion[];
		state: unknown;
		fallback: string;
	},
): Promise<ChoiceOutcome> {
	const row = (value: string, fallbackUsed: boolean, confidence: number, tokens: { inputTokens: number; outputTokens: number }): ChoiceOutcome => ({
		value,
		row: { site_id: options.siteId, answer: value, confidence, fallback_used: fallbackUsed, tokens },
	});
	if (!options.enabled || !client) return row(options.fallback, true, 0, ZERO_TOKENS);
	const before = client.fallbackCount();
	let results: JevResult[];
	try {
		results = await client.ask(options.siteId, options.questions, options.state);
	} catch {
		return row(options.fallback, true, 0, ZERO_TOKENS);
	}
	if (client.fallbackCount() > before) return row(options.fallback, true, 0, ZERO_TOKENS);
	const answer = results[0];
	const tokens = client.lastUsage?.() ?? ZERO_TOKENS;
	const value = answer ? answerValue(answer) : null;
	if (typeof value !== "string") return row(options.fallback, true, answer?.confidence ?? 0, tokens);
	return row(value, false, answer?.confidence ?? 0, tokens);
}

/** The backend's own effort parameter name, or `null` when the backend has none. */
export function effortParameterOf(config: LeanPiConfig, backend: string): string | null {
	const declared = (config.backends[backend] as { effort_param?: unknown } | undefined)?.effort_param;
	return typeof declared === "string" && declared.length > 0 ? declared : null;
}

/**
 * The request PRD-008's worker receives. A backend that declares an effort
 * parameter gets the chosen level under its own name; a backend that declares
 * none gets the packet unchanged — it still runs, it is just never told.
 */
export function dispatchRequest(packet: WorkerTaskPacket, decision: RouteDecision, config: LeanPiConfig): WorkerTaskPacket {
	const backend = decision.selected?.candidate.backend;
	const parameter = backend ? effortParameterOf(config, backend) : null;
	if (!parameter) return packet;
	// PRD-008's packet has no effort field, so the backend's own parameter name is
	// the key it arrives under; a backend that declares none gets the packet unchanged.
	const withEffort: WorkerTaskPacket & Record<string, unknown> = { ...packet, [parameter]: decision.effort };
	return withEffort;
}

/** The record's route descriptor with the decided effort; `minimal` maps to PRD-015's `low` floor. */
export function routeDescriptorOf(contract: ExecutionContract, decision: RouteDecision): RouteDescriptor {
	return {
		complexity: contract.task.execution_complexity,
		executor_class: contract.routing.executor_class,
		reviewer_class: contract.routing.reviewer_class,
		reasoning: decision.effort === "minimal" ? "low" : decision.effort,
	};
}

/** Attach the prediction to the run record. PRD-015 owns the record; this PRD owns this block. */
export function withRouteCost(record: RunTelemetry, decision: RouteDecision): RunTelemetry {
	return decision.route_cost ? { ...record, route_cost: decision.route_cost } : record;
}

export async function selectRoute(request: RouteRequest): Promise<RouteDecision> {
	const { contract, config } = request;
	registerRoutingSites();
	const routing: RoutingConfig = resolveRoutingConfig(config);
	const complexity: ExecutionComplexity = contract.task.execution_complexity;
	const required: RequiredCapability = contract.task.required_capability;
	const history = request.history ?? (request.cwd ? readRuns(request.cwd) : []);
	const clear = request.clearing ?? defaultClearingSource(config);
	const clearing = clear({ required, config });

	// FR-047: the task's language (PRD-004's specialization annotation) or its
	// task type names a role; absent an entry the §14 matrix's role applies.
	const specialistRole = routing.specialists[required.specialization ?? contract.task.type];
	const matrixEffort = routing.effort_by_complexity[complexity];

	// PRD-024 returns a gap when nothing clears. An empty set without one is the
	// same situation stated differently, and it must never reach the scorer.
	const gap =
		clearing.capability_gap ??
		(clearing.candidates.length === 0
			? { requested: required.min_coding_index, best_available: null, reason: "no ranked model cleared the required coding floor" }
			: undefined);

	if (gap) {
		// §34: every other category is an action over an existing pool. With nothing
		// clearing the bar there is no such action, so the gap goes to the user and
		// no below-bar model is scored or dispatched.
		return {
			selected: null,
			candidates: [],
			finalists: [],
			effort: matrixEffort,
			effort_source: "fallback",
			delegation: fallbackDelegation({ slices: request.slices ?? 0, threshold: routing.delegation_slice_threshold }),
			delegation_source: "fallback",
			capability_gap: gap,
			escalation: "USER_INPUT",
			calibration: "insufficient-history",
			route_cost: null,
			telemetry: [],
			reason: `capability_gap: requested ${gap.requested}, best available ${gap.best_available ?? "none"} — ${gap.reason}`,
		};
	}

	const telemetry: SiteTelemetryRow[] = [];
	const routeRole: ModelRole = specialistRole ?? contract.routing.executor_class;
	const scoreAll = (effort: EffortLevel): ScoredCandidate[] =>
		clearing.candidates.map((candidate) => {
			// The calibration bucket is the candidate's own configured role when it has
			// one, which is the role its past runs were recorded under.
			const role = candidate.roles.includes(routeRole) ? routeRole : (candidate.roles[0] ?? routeRole);
			return { candidate, prediction: predictRouteCost({ candidate, role, complexity, effort, routing, config, history }) };
		});

	// Effort must be known before candidates are priced. The adjustment reads the
	// bucket of PRD-024's cheapest clearing candidate — the backend the
	// deterministic scorer would pick — rather than guessing a role-wide average.
	const provisionalBucket = bucketStats({
		history,
		key: { role: routeRole, complexity, backend: (clearing.candidates[0] as RouteCandidate).backend },
		min_bucket_runs: routing.min_bucket_runs,
		matrix_retry_rate: routing.matrix_retry_rate,
		fallback: {
			latency_ms: routing.latency_ms,
			local_gpu_seconds: routing.local_gpu_seconds,
			input_tokens: routing.predicted_input_tokens,
			output_tokens: routing.predicted_output_tokens,
		},
	});
	const deterministicEffort = adjustedEffort(matrixEffort, provisionalBucket.retry_rate, routing.retry_effort_threshold);
	const evidence =
		provisionalBucket.calibration === "telemetry"
			? `calibration: telemetry (${provisionalBucket.runs} runs, retry rate ${provisionalBucket.retry_rate.toFixed(2)})`
			: "calibration: insufficient-history";
	const effortChoice = await askChoice(request.client, {
		siteId: REASONING_EFFORT_SITE_ID,
		enabled: routing.sites[ROUTING_SITE_IDS.reasoning_effort],
		questions: effortQuestions({ complexity, default_effort: deterministicEffort, evidence }),
		state: { complexity, default_effort: deterministicEffort, evidence, stage: "route" },
		fallback: deterministicEffort,
	});
	const effortAccepted = (EFFORT_LEVELS as readonly string[]).includes(effortChoice.value ?? "");
	let effort: EffortLevel = effortAccepted ? (effortChoice.value as EffortLevel) : deterministicEffort;
	let effortSource: "fallback" | "jev" = effortAccepted && !effortChoice.row.fallback_used ? "jev" : "fallback";
	telemetry.push({ ...effortChoice.row, answer: effort, fallback_used: effortChoice.row.fallback_used || !effortAccepted });

	// Delegation is decided once per contract; §58 keeps inline the bias.
	const slices = request.slices ?? 0;
	const deterministicDelegation = fallbackDelegation({ slices, threshold: routing.delegation_slice_threshold });
	const delegationChoice = await askChoice(request.client, {
		siteId: DELEGATION_WORTH_SITE_ID,
		enabled: routing.sites[ROUTING_SITE_IDS.delegation_worth],
		questions: delegationQuestions({ slices, threshold: routing.delegation_slice_threshold }),
		state: { slices, threshold: routing.delegation_slice_threshold },
		fallback: deterministicDelegation,
	});
	const delegationAccepted = delegationChoice.value === "delegate" || delegationChoice.value === "inline";
	const delegation: "delegate" | "inline" = delegationAccepted ? (delegationChoice.value as "delegate" | "inline") : deterministicDelegation;
	const delegationSource: "fallback" | "jev" = delegationAccepted && !delegationChoice.row.fallback_used ? "jev" : "fallback";
	telemetry.push({ ...delegationChoice.row, answer: delegation, fallback_used: delegationChoice.row.fallback_used || !delegationAccepted });

	let scored = scoreAll(effort);
	let ordering = [...scored].sort(better);
	let band = ordering.filter((entry) => entry.prediction.route_cost <= (ordering[0] as ScoredCandidate).prediction.route_cost + routing.tie_band_usd);
	/**
	 * The band, role preference first: the specialist when `models.specialists`
	 * names one and its model clears the bar, else the §14 matrix role, else plain
	 * cost order. The preference reorders the band — it does not shrink it, so a
	 * candidate the preference does not name is still an alternative the tie band
	 * may choose.
	 */
	const bandInPreferenceOrder = (): ScoredCandidate[] => {
		const ref = resolveRoleOrNull(config, specialistRole ?? contract.routing.executor_class);
		if (!ref) return band;
		const preferred = band.filter((entry) => entry.candidate.backend === ref.backend && entry.candidate.model === ref.model);
		return preferred.length > 0 ? [...preferred, ...band.filter((entry) => !preferred.includes(entry))] : band;
	};
	let finalists = bandInPreferenceOrder();
	let winner = finalists[0] as ScoredCandidate;

	if (finalists.length > 1) {
		const quotaChoice = await askChoice(request.client, {
			siteId: QUOTA_PREFERENCE_SITE_ID,
			enabled: routing.sites[ROUTING_SITE_IDS.quota_preference],
			questions: quotaPreferenceQuestions({
				candidates: finalists.map((entry) => ({
					id: entry.candidate.id,
					backend: entry.candidate.backend,
					route_cost: entry.prediction.route_cost,
					reason: `${entry.candidate.backend}/${entry.candidate.model}: predicted route cost $${entry.prediction.route_cost.toFixed(6)}, coding score ${entry.candidate.coding_score}`,
				})),
			}),
			state: { candidates: finalists.map((entry) => ({ id: entry.candidate.id, backend: entry.candidate.backend, reason: `$${entry.prediction.route_cost.toFixed(6)}` })), stage: "route" },
			fallback: winner.candidate.id,
		});
		// An answer outside the band is ignored; the deterministic winner stands.
		const named = finalists.find((entry) => entry.candidate.id === quotaChoice.value);
		if (named) winner = named;
		telemetry.push({ ...quotaChoice.row, answer: winner.candidate.id, fallback_used: !named || quotaChoice.row.fallback_used });
	}

	// §34's retry consequence: a signature that repeats an earlier attempt of this
	// run must not be answered with the identical configuration.
	const failure = request.priorAttempts && request.priorAttempts.length > 0
		? classifyFailure(request.priorAttempts[request.priorAttempts.length - 1] as AttemptFailure, request.priorAttempts.slice(0, -1), historicalSignatures(history))
		: undefined;
	let escalation: EscalationCategory | null = failure?.escalation ?? null;
	if (failure?.class === "repeated-signature") {
		const alternative = ordering.find((entry) => entry.candidate.backend !== winner.candidate.backend);
		if (alternative) {
			winner = alternative;
			escalation = "SWITCH_BACKEND";
		} else {
			const raised = EFFORT_ORDER[Math.min(EFFORT_ORDER.indexOf(effort) + 1, EFFORT_ORDER.length - 1)] as EffortLevel;
			if (raised !== effort) {
				effort = raised;
				effortSource = "fallback";
				scored = scoreAll(effort);
				ordering = [...scored].sort(better);
				band = ordering.filter((entry) => entry.prediction.route_cost <= (ordering[0] as ScoredCandidate).prediction.route_cost + routing.tie_band_usd);
				finalists = bandInPreferenceOrder();
				winner = finalists[0] ?? (ordering[0] as ScoredCandidate);
			}
			escalation = "INCREASE_REASONING";
		}
	}

	return {
		selected: winner,
		candidates: scored,
		finalists: finalists.map((entry) => entry.candidate.id),
		effort,
		effort_source: effortSource,
		delegation,
		delegation_source: delegationSource,
		...(failure ? { failure } : {}),
		escalation,
		calibration: winner.prediction.calibration,
		route_cost: routeCostBlock(winner.prediction),
		telemetry,
		reason: `${winner.candidate.id} at effort ${effort} (${winner.prediction.calibration}); ${scored.length} clearing candidate(s), finalists [${finalists.map((entry) => entry.candidate.id).join(", ")}]`,
	};
}
