/**
 * One run, one record (PRD-015 Phase 1).
 *
 * `emitRunTelemetry` composes the §52 record from the accumulator, the frozen
 * execution contract (PRD-004) and the verdicts PRD-009/PRD-010 produced, prices
 * it, and appends it once. It is the only writer: the record is idempotent per
 * run, so a retried or re-entered turn cannot double-count its own cost.
 *
 * `runTurnWithTelemetry` is the seam the session's turn entry point calls: the
 * real `runTurn()` runs (lanes, contract, executor) and the record is written
 * afterwards, so it covers every attempt of the run — success, failure or
 * abandonment — rather than one record per attempt.
 */
import { runTurn, type TurnContext, type TurnDeps, type TurnInput } from "../commands/session.js";
import type { ExecutionContract } from "../compiler/contract.js";
import { billedRefs, billingOf, type BackendCall, type RunCollector } from "./collect.js";
import { priceCall, priceRun, resolveCostConfig, type CostConfig } from "./pricing.js";
import type { CallRow, RouteCostBlock, RunCapabilities, RunResult, RunTelemetry } from "./record.js";
import { appendRun } from "./store.js";

/** The verdicts copied into `result`; never decided here. */
export type RunVerdict = RunResult;

export interface EmitOptions {
	cwd: string;
	/** Resolved cost surface; absent means every rate is 0. */
	cost?: CostConfig;
	/** The PRD the PRD lane consumed, when one did; null for direct execution. */
	prdUsed?: string | null;
	/**
	 * PRD-020's pre-dispatch prediction for the identity that actually ran
	 * (`ExecutorOutcome.route_cost`). Absent for a run no router decided.
	 */
	routeCost?: RouteCostBlock;
}

function namesOf(items: readonly unknown[]): string[] {
	const names: string[] = [];
	for (const item of items) {
		if (typeof item === "string") names.push(item);
		else if (item && typeof item === "object") {
			const record = item as { name?: unknown; id?: unknown };
			if (typeof record.name === "string") names.push(record.name);
			else if (typeof record.id === "string") names.push(record.id);
		}
	}
	return names;
}

function callRow(call: BackendCall, runId: string, cost: CostConfig): CallRow {
	return {
		timestamp: call.timestamp ?? new Date().toISOString(),
		backend: call.backend,
		backend_type: call.type,
		model: call.model,
		role: call.role,
		inputTokens: call.usage.inputTokens ?? call.usage.tokens ?? 0,
		outputTokens: call.usage.outputTokens ?? 0,
		costUsd: priceCall(call, cost),
		...(call.quotaClass ? { quotaClass: call.quotaClass } : {}),
		runId,
		billing: billingOf(call),
	};
}

function capabilitiesOf(contract: ExecutionContract, collector: RunCollector): RunCapabilities {
	return {
		skills_disclosed: namesOf(contract.capabilities.skills),
		skills_used: [...collector.usedSkills()],
		mcps_disclosed: namesOf(contract.capabilities.mcps),
		mcps_used: [...collector.usedMcps()],
	};
}

/**
 * Compose, price and append the run's record. Returns it, or `undefined` when
 * this run already emitted — the store stays one line per run.
 */
export function emitRunTelemetry(
	collector: RunCollector,
	contract: ExecutionContract,
	result: RunVerdict,
	options: EmitOptions,
): RunTelemetry | undefined {
	if (!collector.markEmitted()) return undefined;
	const cost = options.cost ?? {};
	const usage = collector.usage();
	const execution = collector.execution();
	const calls = collector.calls();
	const refs = billedRefs(calls);
	const record: RunTelemetry = {
		task_id: collector.taskId,
		session_id: collector.sessionId,
		route: {
			complexity: contract.task.execution_complexity,
			executor_class: contract.routing.executor_class,
			reviewer_class: contract.routing.reviewer_class,
			reasoning: contract.reasoning.effort,
		},
		prd_used: options.prdUsed ?? null,
		executor_backend: refs.executor?.backend ?? null,
		executor_model: refs.executor?.model ?? null,
		reviewer_backend: refs.reviewer?.backend ?? null,
		reviewer_model: refs.reviewer?.model ?? null,
		usage,
		cost: priceRun({ calls, usage, wallMs: execution.wall_ms }, cost),
		execution,
		result: { ...result },
		capabilities: capabilitiesOf(contract, collector),
		jev_decisions: [...collector.decisions()],
		calls: calls.map((call) => callRow(call, collector.taskId, cost)),
		...(options.routeCost ? { route_cost: options.routeCost } : {}),
	};
	appendRun(options.cwd, record, cost);
	return record;
}

export interface TurnTelemetryOptions {
	/** Created at run start by the caller that knows the run's identity. */
	collector: RunCollector;
	/**
	 * Verdicts for this turn, copied into the record. A function is evaluated after
	 * the turn ran, which is the only way a caller can report what the turn proved
	 * rather than what it hoped for.
	 */
	verdict: RunVerdict | ((context: TurnContext) => RunVerdict | Promise<RunVerdict>);
	/** Defaults to the cost surface of `deps.config`. */
	cost?: CostConfig;
	prdUsed?: string | null;
}

/**
 * The session turn entry point with its record: the real `runTurn()` first, then
 * exactly one emission. A turn that never produced a contract was not a run and
 * writes nothing.
 */
export async function runTurnWithTelemetry(
	turn: TurnInput,
	deps: TurnDeps,
	telemetry: TurnTelemetryOptions,
): Promise<TurnContext> {
	const context = await runTurn(turn, deps);
	if (context.contract) {
		const verdict = typeof telemetry.verdict === "function" ? await telemetry.verdict(context) : telemetry.verdict;
		emitRunTelemetry(telemetry.collector, context.contract, verdict, {
			cwd: deps.cwd,
			cost: telemetry.cost ?? resolveCostConfig(deps.config),
			...(telemetry.prdUsed === undefined ? {} : { prdUsed: telemetry.prdUsed }),
			// PRD-020's prediction travels on the executor outcome, so the record
			// carries what the router predicted for the identity that ran.
			...(context.executor?.route_cost ? { routeCost: context.executor.route_cost } : {}),
		});
	}
	return context;
}
