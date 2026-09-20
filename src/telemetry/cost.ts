/**
 * `/cost` — what this session spent, per verified success (PRD-015 Phase 2, FR-149).
 *
 * Registered through the command registry (PRD-016 owns the registry, PRD-001
 * owns `activate()`); the handler itself lives here because this PRD owns the
 * store it reads. Read-only over `readRuns()`: the stored `effective_cost` is
 * authoritative and is never recomputed at display time, so `/cost` and the
 * record cannot disagree.
 */
import type { CommandContext, CommandRegistry, CommandResult } from "../commands/registry.js";
import { aggregateRuns, type TelemetryAggregate } from "./aggregate.js";
import { unpricedCalls, type CostConfig } from "./pricing.js";
import type { RunTelemetry } from "./record.js";
import { readRuns, telemetryPath } from "./store.js";

export interface CostCommandDeps {
	/** Project root; `CommandContext.cwd` wins when the dispatcher supplies one. */
	cwd: string;
	/** Session whose runs the report totals; every session in the store when absent. */
	sessionId?: string;
	cost?: CostConfig;
}

function money(usd: number): string {
	return `$${usd.toFixed(6)}`;
}

function table(rows: string[][]): string {
	const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
	return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd()).join("\n");
}

/** The per-verified-success figure §3 asks for; `n/a` when nothing succeeded. */
export function renderEffectiveCostPerSuccess(aggregate: TelemetryAggregate): string {
	return aggregate.costPerVerifiedSuccess === null ? "n/a" : money(aggregate.costPerVerifiedSuccess);
}

/**
 * The spend no rate card priced, printed beside a total instead of folded into
 * it. These calls burned metered tokens and recorded $0, so a report that only
 * sums `costUsd` is short by an unknown amount; naming the models is also the
 * fix — they are the `cost.models` keys the operator has to declare.
 */
function renderUnpriced(runs: readonly RunTelemetry[]): string[] {
	const rows = runs.flatMap((run) => unpricedCalls(run.calls ?? []));
	if (rows.length === 0) return [];
	const models = [...new Set(rows.map((row) => `${row.backend}/${row.model}`))];
	return [`unpriced: ${rows.length} metered call(s) with no configured rate (${models.join(", ")})`];
}

/**
 * The report: one row per task, then the objective. `scope` is what the totals
 * were actually read over — the handler only filters by session when it was
 * registered with one, and a figure that says "session" over every session in
 * the store is a wrong answer to the question §3 asks.
 */
export function renderCostReport(runs: readonly RunTelemetry[], aggregate: TelemetryAggregate, scope: "session" | "all sessions"): string {
	const rows = [
		["task_id", "route", "executor", "success", "effective_cost"],
		...runs.map((run) => [
			run.task_id,
			`${run.route?.complexity ?? "?"}/${run.route?.executor_class ?? "?"}`,
			run.executor_backend === null ? "n/a" : `${run.executor_backend}/${run.executor_model ?? "?"}`,
			run.result?.success === true ? "yes" : "no",
			money(run.cost?.effective_cost ?? 0),
		]),
	];
	return [
		table(rows),
		"",
		`runs: ${aggregate.runs}`,
		`${scope} total: ${money(aggregate.effectiveCostUsd)}`,
		...renderUnpriced(runs),
		`verified successes: ${aggregate.verifiedSuccesses}`,
		`effective cost per verified success: ${renderEffectiveCostPerSuccess(aggregate)}`,
	].join("\n");
}

/** The full field breakdown of one record: `/cost <task_id>`. */
export function renderRun(record: RunTelemetry): string {
	const usage = record.usage;
	const execution = record.execution;
	return [
		`task ${record.task_id} (session ${record.session_id})`,
		`route: ${record.route?.complexity ?? "?"} / ${record.route?.executor_class ?? "?"} / ${record.route?.reviewer_class ?? "?"} / reasoning=${record.route?.reasoning ?? "?"}`,
		`prd_used: ${record.prd_used ?? "none"}`,
		`executor: ${record.executor_backend ?? "n/a"}/${record.executor_model ?? "n/a"}`,
		`reviewer: ${record.reviewer_backend ?? "n/a"}/${record.reviewer_model ?? "n/a"}`,
		`usage: input=${usage.input_tokens} cached_input=${usage.cached_input_tokens} output=${usage.output_tokens} reasoning=${usage.reasoning_tokens} jev=${usage.jev_tokens} local_gpu_s=${usage.local_gpu_seconds} external_harness_calls=${usage.external_harness_calls} subscription=${usage.subscription_usage}`,
		`cost: api=${money(record.cost.api_usd)} jev=${money(record.cost.jev_usd)} quota=${money(record.cost.estimated_quota_cost)} effective=${money(record.cost.effective_cost)}`,
		`execution: wall=${execution.wall_ms}ms tool_calls=${execution.tool_calls} file_reads=${execution.file_reads} repeated_reads=${execution.repeated_reads} retries=${execution.retries} escalations=${execution.escalations} compactions=${execution.compactions}`,
		`result: verification=${record.result.verification} proof_gate=${record.result.proof_gate} reviewer=${record.result.reviewer} success=${record.result.success}`,
		`capabilities: skills disclosed=[${record.capabilities.skills_disclosed.join(", ")}] used=[${record.capabilities.skills_used.join(", ")}] mcps disclosed=[${record.capabilities.mcps_disclosed.join(", ")}] used=[${record.capabilities.mcps_used.join(", ")}]`,
		`calls: ${(record.calls ?? []).map((call) => `${call.backend_type}/${call.backend}/${call.model} (${call.role}, in=${call.inputTokens}, out=${call.outputTokens}, ${money(call.costUsd)})`).join("; ") || "none"}`,
		...renderUnpriced([record]),
		`jev_decisions: ${(record.jev_decisions ?? []).map((row) => `${row.site_id} answer=${JSON.stringify(row.answer)} confidence=${row.confidence ?? "n/a"} fallback=${row.fallback_used} tokens=${row.tokens}`).join("; ") || "none"}`,
	].join("\n");
}

export function registerCostCommand(registry: CommandRegistry, deps: CostCommandDeps): void {
	const handler = (args: string, context: CommandContext): CommandResult => {
		const cwd = context.cwd || deps.cwd;
		const path = telemetryPath(cwd, deps.cost);
		// Registered without a session id, `/cost` totals every run in the store;
		// the label has to say which population the number came from.
		const scope = deps.sessionId === undefined ? "all sessions" : "session";
		const runs = readRuns(cwd, deps.sessionId === undefined ? {} : { sessionId: deps.sessionId }, deps.cost);
		const taskId = args.trim();
		if (taskId.length > 0) {
			const record = runs.find((run) => run.task_id === taskId);
			if (!record) return { ok: false, text: `no telemetry record for task "${taskId}" in ${path}` };
			return { ok: true, text: renderRun(record) };
		}
		if (runs.length === 0) return { ok: true, text: `no telemetry recorded yet in ${path}` };
		return { ok: true, text: renderCostReport(runs, aggregateRuns(runs), scope) };
	};
	if (registry.has("cost")) registry.unregister("cost");
	registry.register("cost", handler);
}
