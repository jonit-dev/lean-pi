/**
 * The §53 folds and the report artifact (PRD-021 Phase 1).
 *
 * Pure arithmetic over the ledger plus PRD-015's telemetry records: this module
 * aggregates, it does not instrument. Every rate is a count over adjudicated
 * attempts, and an attempt whose §52 record cannot be joined is a hard error —
 * never a zero-cost success.
 *
 * Three deliberate choices the roadmap makes and this file must not soften:
 *
 * - §4's targets are printed, never enforced: the exit code does not depend on
 *   them, and the section is labelled "targets, not claims".
 * - `p95` is nearest-rank on the sorted sample and is labelled with `n`, so
 *   nobody reads a smoothed quantile into a ten-task seed suite.
 * - a rate with no observations prints `n/a (n observations)` rather than 0.
 */
import { loadRanking, RankingUnavailableError, RankingValidationError } from "../capability/index.js";
import type { LeanPiConfig } from "../core/types.js";
import type { RunTelemetry } from "../telemetry/record.js";
import type { BenchConfigRow, BenchLedgerRow } from "./types.js";
import { BenchError } from "./types.js";

export const REPORT_SCHEMA = 1;

/** §4's aspirational targets, printed as comparison context and never as gates. */
export const SECTION4_TARGETS = {
	relative_solve_rate: "90–95% or more of a contemporary Claude Code / Codex baseline",
	cost_ratio_of_baseline: 0.25,
	stretch_cost_ratio_of_baseline: 0.1,
	note: "ROADMAP §4 — product targets, not claims about current performance",
};

/** The executor model's PRD-024 capability annotation; every field is null when the catalog cannot answer. */
export interface CapabilityAnnotation {
	model_id: string;
	/** The coding index (`coding_score`) — the number a cost-per-success is read against. */
	index: number | null;
	price_blended_per_mtok: number | null;
	speed_tier: string | null;
	/** The ranking file the values came from; null when unavailable. */
	source: string | null;
	/** Why the index is unavailable, when it is. */
	unavailable_reason: string | null;
}

/** `index: unavailable` — the documented degradation when PRD-024's catalog is absent or unlisted. */
export function capabilityOf(config: LeanPiConfig | null | undefined, modelId: string): CapabilityAnnotation {
	const unavailable = (reason: string): CapabilityAnnotation => ({
		model_id: modelId,
		index: null,
		price_blended_per_mtok: null,
		speed_tier: null,
		source: null,
		unavailable_reason: reason,
	});
	if (!config) return unavailable("no configuration was supplied to read the catalog with");
	let ranking;
	try {
		ranking = loadRanking(config);
	} catch (error) {
		if (error instanceof RankingUnavailableError || error instanceof RankingValidationError) return unavailable(error.message);
		throw error;
	}
	const record = ranking.models.find((candidate) => candidate.model_id === modelId || candidate.aliases.includes(modelId));
	if (!record) return unavailable(`model "${modelId}" is not listed in ${ranking.path}`);
	return {
		model_id: record.model_id,
		index: record.coding_score,
		price_blended_per_mtok: record.price_blended_per_mtok,
		speed_tier: record.speed_tier,
		source: ranking.path,
		unavailable_reason: null,
	};
}

/** Median and nearest-rank p95 of a sample, both labelled with the sample size. */
export function medianAndP95(values: readonly number[]): { median: number | null; p95: number | null; n: number } {
	if (values.length === 0) return { median: null, p95: null, n: 0 };
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
	return { median, p95: sorted[Math.ceil(0.95 * sorted.length) - 1] as number, n: sorted.length };
}

/** §53's per-configuration row. `null` marks a value with no observations, never a 0. */
export interface ConfigMetrics {
	config_id: string;
	label: string;
	adapter: string;
	operator: string;
	executor_model: string;
	/** Pi's loaded extensions for this row; empty is the auditable "no LeanPi". */
	loaded_extensions: string[];
	features: string[];
	capability: CapabilityAnnotation;
	attempts: number;
	adjudicated_complete: number;
	adjudicated_incomplete: number;
	adjudication_errors: number;
	reported_successes: number;
	verified_solve_rate: number;
	effective_cost_total: number;
	cost_per_verified_success: number | null;
	generator_tokens_total: number;
	generator_tokens_per_verified_success: number | null;
	time_to_verified_success_ms: { median: number | null; p95: number | null; n: number };
	false_completion_rate: number | null;
	false_completion_tasks: string[];
	subscription_usage: number;
	adjudicators: string[];
	budget_usd: number;
	note: string | null;
}

/** One task's row across the configurations that ran it — the A/B pairing, stated. */
export interface PairingRow {
	task_id: string;
	/** One entry per configuration that attempted the task, in the run's configuration order. */
	arms: Array<{
		config_id: string;
		adjudication: string;
		reported_success: boolean;
		effective_cost: number;
		wall_ms: number;
	}>;
}

export interface BenchReport {
	schema: typeof REPORT_SCHEMA;
	run_id: string;
	generated_at: string;
	suite_dir: string;
	tasks: number;
	telemetry_rows: number;
	configs: ConfigMetrics[];
	pairing: PairingRow[];
	section4: typeof SECTION4_TARGETS;
	/** The measured values the §4 comparison is stated over, per config. */
	section4_measured: Array<{ config_id: string; cost_per_verified_success: number | null; verified_solve_rate: number; relative_to_baseline: number | null }>;
	baseline_config_id: string | null;
	notes: string[];
}

/** The §52 record for one ledger row; a missing record is the loud failure the roadmap asks for. */
export function joinTelemetry(ledger: readonly BenchLedgerRow[], telemetry: readonly RunTelemetry[]): Map<string, RunTelemetry> {
	const byTask = new Map(telemetry.map((record) => [record.task_id, record]));
	const joined = new Map<string, RunTelemetry>();
	for (const row of ledger) {
		const record = byTask.get(row.telemetry_task_id);
		if (!record) {
			throw new BenchError(
				`task "${row.task_id}" under config "${row.config_id}" has no §52 record for telemetry task id "${row.telemetry_task_id}"; an attempt without telemetry is not a free success`,
				"telemetry-join",
			);
		}
		joined.set(row.telemetry_task_id, record);
	}
	return joined;
}

function configMetricsOf(
	row: BenchConfigRow,
	attempts: readonly BenchLedgerRow[],
	records: Map<string, RunTelemetry>,
	config: LeanPiConfig | null | undefined,
): ConfigMetrics {
	let complete = 0;
	let incomplete = 0;
	let errors = 0;
	let reported = 0;
	let costTotal = 0;
	let tokens = 0;
	let subscription = 0;
	const wall: number[] = [];
	const falseCompletions: string[] = [];
	const adjudicators: string[] = [];
	for (const attempt of attempts) {
		const record = records.get(attempt.telemetry_task_id) as RunTelemetry;
		costTotal += record.cost.effective_cost;
		tokens += record.usage.input_tokens + record.usage.cached_input_tokens + record.usage.output_tokens + record.usage.reasoning_tokens;
		subscription += record.usage.subscription_usage;
		if (!adjudicators.includes(attempt.adjudication.adjudicator)) adjudicators.push(attempt.adjudication.adjudicator);
		if (attempt.adjudication.verdict === "complete") {
			complete += 1;
			wall.push(record.execution.wall_ms);
		} else if (attempt.adjudication.verdict === "incomplete") {
			incomplete += 1;
		} else {
			errors += 1;
		}
		if (attempt.reported_success) {
			reported += 1;
			if (attempt.adjudication.verdict !== "complete") falseCompletions.push(attempt.task_id);
		}
	}
	const timing = medianAndP95(wall);
	return {
		config_id: row.id,
		label: row.label,
		adapter: row.adapter,
		operator: attempts[0]?.adapter.operator ?? row.adapter,
		executor_model: row.executor_model,
		loaded_extensions: attempts[0]?.adapter.extensions ?? [],
		features: row.features,
		capability: capabilityOf(config, row.executor_model),
		attempts: attempts.length,
		adjudicated_complete: complete,
		adjudicated_incomplete: incomplete,
		adjudication_errors: errors,
		reported_successes: reported,
		verified_solve_rate: attempts.length === 0 ? 0 : complete / attempts.length,
		effective_cost_total: costTotal,
		cost_per_verified_success: complete === 0 ? null : costTotal / complete,
		generator_tokens_total: tokens,
		generator_tokens_per_verified_success: complete === 0 ? null : tokens / complete,
		time_to_verified_success_ms: timing,
		false_completion_rate: reported === 0 ? null : falseCompletions.length / reported,
		false_completion_tasks: falseCompletions,
		subscription_usage: subscription,
		adjudicators,
		budget_usd: row.budget_usd,
		note: attempts.find((attempt) => attempt.note !== null)?.note ?? null,
	};
}

const BASELINE_PREFERENCE = ["claude-code", "codex", "omp", "stock-pi"];

export interface FoldInput {
	run_id: string;
	generated_at: string;
	suite_dir: string;
	/** Task identities; the fold needs their ids and count, not their files. */
	tasks: readonly { id: string }[];
	ledger: readonly BenchLedgerRow[];
	telemetry: readonly RunTelemetry[];
	configs: readonly BenchConfigRow[];
	config?: LeanPiConfig | null;
}

/** Fold the ledger and the store into the report. Recomputing from an edited ledger changes the values. */
export function foldReport(input: FoldInput): BenchReport {
	const records = joinTelemetry(input.ledger, input.telemetry);
	const metrics = input.configs.map((row) => configMetricsOf(row, input.ledger.filter((attempt) => attempt.config_id === row.id), records, input.config));
	const pairing: PairingRow[] = input.tasks.map((task) => ({
		task_id: task.id,
		arms: input.configs.flatMap((row) =>
			input.ledger
				.filter((attempt) => attempt.config_id === row.id && attempt.task_id === task.id)
				.map((attempt) => ({
					config_id: row.id,
					adjudication: attempt.adjudication.verdict,
					reported_success: attempt.reported_success,
					effective_cost: records.get(attempt.telemetry_task_id)?.cost.effective_cost ?? 0,
					wall_ms: records.get(attempt.telemetry_task_id)?.execution.wall_ms ?? 0,
				})),
		),
	}));
	const baseline = metrics.find((row) => BASELINE_PREFERENCE.includes(row.config_id)) ?? null;
	return {
		schema: REPORT_SCHEMA,
		run_id: input.run_id,
		generated_at: input.generated_at,
		suite_dir: input.suite_dir,
		tasks: input.tasks.length,
		telemetry_rows: input.telemetry.length,
		configs: metrics,
		pairing,
		section4: SECTION4_TARGETS,
		section4_measured: metrics.map((row) => ({
			config_id: row.config_id,
			cost_per_verified_success: row.cost_per_verified_success,
			verified_solve_rate: row.verified_solve_rate,
			relative_to_baseline:
				baseline === null || baseline.cost_per_verified_success === null || baseline.cost_per_verified_success === 0 || row.cost_per_verified_success === null
					? null
					: row.cost_per_verified_success / baseline.cost_per_verified_success,
		})),
		baseline_config_id: baseline?.config_id ?? null,
		notes:
			baseline === null
				? ["no baseline row ran in this invocation: the §4 comparison needs one of claude-code, codex or stock-pi"]
				: [],
	};
}

function money(value: number | null): string {
	return value === null ? "n/a (0 verified successes)" : `$${value.toFixed(6)}`;
}

function rate(value: number | null, numerator: number, denominator: number, unit: string): string {
	return value === null ? `n/a (0 ${unit})` : `${value.toFixed(4)} (${numerator}/${denominator})`;
}

/** The markdown artifact the run leaves behind. */
export function renderReportMarkdown(report: BenchReport, ledger: readonly BenchLedgerRow[]): string {
	const lines: string[] = [];
	lines.push(`# Bench report ${report.run_id}`);
	lines.push("");
	lines.push(`- suite: ${report.suite_dir} (${report.tasks} tasks)`);
	lines.push(`- generated: ${report.generated_at}`);
	lines.push(`- §52 telemetry rows joined: ${report.telemetry_rows}`);
	lines.push(`- §4 targets are printed for comparison only; the exit code never depends on them.`);
	lines.push("");
	lines.push("## §53 metrics");
	lines.push("");
	lines.push("| config | attempts | verified solve rate | cost/verified success | generator tokens/verified success | time to verified success | false completion rate | effective cost total |");
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const row of report.configs) {
		const timing = row.time_to_verified_success_ms;
		lines.push(
			`| ${row.config_id} | ${row.attempts} | ${rate(row.verified_solve_rate, row.adjudicated_complete, row.attempts, "attempts")} | ${money(row.cost_per_verified_success)} | ${
				row.generator_tokens_per_verified_success === null ? "n/a (0 verified successes)" : `${Math.round(row.generator_tokens_per_verified_success)} tokens`
			} | median ${timing.median === null ? "n/a" : `${Math.round(timing.median)}ms`} / p95 (nearest-rank, n=${timing.n}) ${timing.p95 === null ? "n/a" : `${Math.round(timing.p95)}ms`} | ${
				row.false_completion_rate === null
					? `n/a (0 reported successes)`
					: `${row.false_completion_rate.toFixed(4)} (${row.false_completion_tasks.length}/${row.reported_successes})${row.false_completion_tasks.length > 0 ? ` — tasks: ${row.false_completion_tasks.join(", ")}` : ""}`
			} | $${row.effective_cost_total.toFixed(6)} |`,
		);
	}
	lines.push("");
	lines.push("## configuration rows");
	lines.push("");
	for (const row of report.configs) {
		lines.push(`### ${row.config_id} — ${row.label}`);
		lines.push("");
		lines.push(`- adapter: ${row.adapter} (operator ${row.operator})`);
		lines.push(`- executor model: ${row.executor_model}`);
		lines.push(
			`- capability: ${
				row.capability.unavailable_reason === null
					? `index ${row.capability.index ?? "n/a"}, blended price ${row.capability.price_blended_per_mtok ?? "n/a"} USD/Mtok, speed ${row.capability.speed_tier ?? "n/a"} (${row.capability.source})`
					: `index: unavailable — ${row.capability.unavailable_reason}`
			}`,
		);
		lines.push(`- loaded extensions: ${row.loaded_extensions.length === 0 ? "none (no LeanPi)" : row.loaded_extensions.join(", ")}`);
		lines.push(`- features: ${row.features.join(", ") || "none"}`);
		lines.push(`- adjudicators: ${row.adjudicators.join(" | ") || "none"}`);
		lines.push(`- subscription usage recorded: ${row.subscription_usage}`);
		lines.push(`- budget per attempt: ${row.budget_usd > 0 ? `$${row.budget_usd}` : "unlimited"}`);
		if (row.note !== null) lines.push(`- note: ${row.note}`);
		lines.push("");
	}
	lines.push("## per-task pairing");
	lines.push("");
	lines.push("The same task under each configuration that ran it, with each side's own adjudication and measured cost:");
	lines.push("");
	lines.push("| task | " + report.configs.map((row) => row.config_id).join(" | ") + " |");
	lines.push("| --- |" + report.configs.map(() => " --- |").join(""));
	for (const row of report.pairing) {
		const cells = report.configs.map((config) => {
			const arm = row.arms.find((entry) => entry.config_id === config.config_id);
			return arm ? `${arm.adjudication} / $${arm.effective_cost.toFixed(6)} / reported ${arm.reported_success}` : "-";
		});
		lines.push(`| ${row.task_id} | ${cells.join(" | ")} |`);
	}
	lines.push("");
	lines.push("## adjudicator identity per attempt");
	lines.push("");
	lines.push("| task | config | adjudicator | verdict | reviewer model | rubric model |");
	lines.push("| --- | --- | --- | --- | --- | --- |");
	for (const row of ledger) {
		lines.push(
			`| ${row.task_id} | ${row.config_id} | ${row.adjudication.adjudicator} | ${row.adjudication.verdict} | ${row.adjudication.reviewer_model ?? "-"} | ${row.adjudication.rubric_model ?? "-"} |`,
		);
	}
	lines.push("");
	lines.push("## §4 aspirational targets (comparison context, not a gate)");
	lines.push("");
	if (report.baseline_config_id === null) {
		lines.push(`- no baseline row in this invocation, so no relative comparison is printed (${report.notes.join("; ")})`);
	} else {
		lines.push(`- baseline row: ${report.baseline_config_id}`);
		lines.push(`- target: ${SECTION4_TARGETS.relative_solve_rate}; cost at or below ${SECTION4_TARGETS.cost_ratio_of_baseline * 100}% of the baseline's cost per verified success (stretch ${SECTION4_TARGETS.stretch_cost_ratio_of_baseline * 100}%)`);
		for (const row of report.section4_measured) {
			lines.push(
				`- ${row.config_id}: solve rate ${row.verified_solve_rate.toFixed(4)}, cost/verified success ${money(row.cost_per_verified_success)}, relative to baseline ${
					row.relative_to_baseline === null ? "n/a" : `${(row.relative_to_baseline * 100).toFixed(1)}%`
				}`,
			);
		}
	}
	lines.push("");
	lines.push(`_${SECTION4_TARGETS.note}_`);
	return `${lines.join("\n")}\n`;
}
