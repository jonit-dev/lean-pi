/**
 * The §57 RTK report (PRD-021 Phase 4, PRD-019 AC-6).
 *
 * A pure fold over two paired telemetry sources — one RTK-off arm, one RTK-on
 * arm, the same tasks under the same model — printing §57's seven measures and a
 * promote verdict. The verdict rule is **not** restated here: `verdictFromArms()`
 * (PRD-019) is imported, so the §19 rule "promote defaults only on an
 * end-to-end improvement" has exactly one implementation, and a report that
 * inverts its inputs inverts its verdict.
 *
 * Shell-output size is the one §57 measure no §52 field carries: it is the
 * reducer's `bytes_in` total, recorded by PRD-019's RTK measurement. The report
 * reads that file when the source directory holds one and prints `n/a` when it
 * does not — it never substitutes a number of its own.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRtkMeasurement, verdictFromArms } from "../../rtk/index.js";
import type { RtkArmMetrics } from "../../rtk/index.js";
import { BenchError } from "../types.js";
import { adjudicationFor, readTelemetryDir, type TelemetrySource } from "./source.js";

export const RTK_REPORT_SCHEMA = 1;

/** RTK's measurement file, as PRD-019 writes it into the source directory. */
export const RTK_MEASUREMENT_FILENAME = "rtk-measurement.json";

/** §57's seven measures for one arm, plus the counts they were folded from. */
export interface RtkArmReport {
	arm: "off" | "on";
	tasks: number;
	/** The reducer's `bytes_in` total; null when no RTK measurement is present. */
	shell_output_bytes: number | null;
	context_tokens: number;
	model_calls: number;
	retries: number;
	/** Attempts the bench ledger adjudicated; a rate over none is `null`. */
	adjudicated: number;
	/** Adjudicated completions over adjudicated attempts; `null` when nothing was adjudicated. */
	solve_rate: number | null;
	wall_ms: number;
	cost_per_success: number | null;
	effective_cost_total: number;
}

export interface RtkReport {
	schema: typeof RTK_REPORT_SCHEMA;
	generated_at: string;
	source_dir: string;
	off: RtkArmReport;
	on: RtkArmReport;
	/** `verdictFromArms()`'s outcome, in §57's promote/do-not-promote words. */
	verdict: "promote" | "do-not-promote";
	/** The PRD-019 verdict the mapping came from, so the rule stays auditable. */
	verdict_source: "improved" | "no_benefit";
	rule: string;
	paired_tasks: string[];
}

const RULE = "promote only when cost per success strictly improves and solve rate does not regress (PRD-019 verdictFromArms, §19/§57)";

function armReport(arm: "off" | "on", source: TelemetrySource, shellBytes: number | null): RtkArmReport {
	let contextTokens = 0;
	let modelCalls = 0;
	let retries = 0;
	let wallMs = 0;
	let cost = 0;
	let successes = 0;
	let adjudicated = 0;
	for (const run of source.runs) {
		contextTokens += run.usage.input_tokens + run.usage.cached_input_tokens + run.usage.output_tokens + run.usage.reasoning_tokens;
		modelCalls += run.calls.length;
		retries += run.execution.retries;
		wallMs += run.execution.wall_ms;
		cost += run.cost.effective_cost;
		const verdict = adjudicationFor(source, run.task_id);
		if (verdict === null) continue;
		adjudicated += 1;
		if (verdict === "complete") successes += 1;
	}
	return {
		arm,
		tasks: source.runs.length,
		shell_output_bytes: shellBytes,
		adjudicated,
		context_tokens: contextTokens,
		model_calls: modelCalls,
		retries,
		solve_rate: adjudicated === 0 ? null : successes / adjudicated,
		wall_ms: wallMs,
		cost_per_success: successes === 0 ? null : cost / successes,
		effective_cost_total: cost,
	};
}

function shellBytesOf(dir: string, arm: "off" | "on"): number | null {
	const path = join(dir, RTK_MEASUREMENT_FILENAME);
	if (!existsSync(path)) return null;
	return readRtkMeasurement(path)?.arms[arm].shell_output_bytes ?? null;
}

export interface RtkReportOptions {
	generated_at?: string;
}

/** Fold the two arms. Inverting which directory is which inverts the verdict. */
export function rtkReport(fromDir: string, options: RtkReportOptions = {}): RtkReport {
	const offDir = join(fromDir, "off");
	const onDir = join(fromDir, "on");
	if (!existsSync(offDir) || !existsSync(onDir)) {
		throw new BenchError(`${fromDir} must hold an "off" and an "on" arm directory, each a telemetry source`, "usage");
	}
	const offSource = readTelemetryDir(offDir);
	const onSource = readTelemetryDir(onDir);
	const off = armReport("off", offSource, shellBytesOf(fromDir, "off"));
	const on = armReport("on", onSource, shellBytesOf(fromDir, "on"));
	const verdict = verdictFromArms(armOutcome(off), armOutcome(on));
	return {
		schema: RTK_REPORT_SCHEMA,
		generated_at: options.generated_at ?? new Date().toISOString(),
		source_dir: fromDir,
		off,
		on,
		verdict: verdict === "improved" ? "promote" : "do-not-promote",
		verdict_source: verdict,
		rule: RULE,
		paired_tasks: offSource.runs.map((run) => run.task_id).filter((taskId) => onSource.runs.some((candidate) => candidate.task_id === taskId)),
	};
}

/**
 * PRD-019's rule takes numbers, and the report keeps `null` for "no verified
 * success" and "nothing adjudicated". Both map to the values the rule already
 * refuses to promote: a zero solve rate and an infinite cost per success.
 */
function armOutcome(arm: RtkArmReport): Pick<RtkArmMetrics, "solve_rate" | "cost_per_success"> {
	return { solve_rate: arm.solve_rate ?? 0, cost_per_success: arm.cost_per_success ?? Number.POSITIVE_INFINITY };
}

/** A solve rate over nothing adjudicated is `n/a`, never 0. */
function solveRate(arm: RtkArmReport): string {
	return arm.solve_rate === null ? `n/a (0 adjudicated attempts; ${arm.tasks} run(s))` : arm.solve_rate.toFixed(4);
}

/** §57's shell-output measure is absent when PRD-019 recorded no RTK measurement. */
function shellBytes(value: number | null): string {
	return value === null ? "n/a (no rtk measurement)" : `${value}`;
}

/** A cost per success over zero verified successes is `n/a`, never `$0.00`. */
function moneyPerSuccess(value: number | null): string {
	return value === null ? "n/a (0 verified successes)" : `$${value.toFixed(6)}`;
}

/** The printed §57 report. */
export function renderRtkReport(report: RtkReport): string {
	const rows: Array<[string, string, string]> = [
		["shell-output bytes", shellBytes(report.off.shell_output_bytes), shellBytes(report.on.shell_output_bytes)],
		["context tokens", `${report.off.context_tokens}`, `${report.on.context_tokens}`],
		["model calls", `${report.off.model_calls}`, `${report.on.model_calls}`],
		["retries", `${report.off.retries}`, `${report.on.retries}`],
		["solve rate", solveRate(report.off), solveRate(report.on)],
		["wall time (ms)", `${report.off.wall_ms}`, `${report.on.wall_ms}`],
		["cost per success", moneyPerSuccess(report.off.cost_per_success), moneyPerSuccess(report.on.cost_per_success)],
	];
	const lines: string[] = [];
	lines.push(`# §57 RTK report — ${report.source_dir}`);
	lines.push("");
	lines.push(`- generated: ${report.generated_at}`);
	lines.push(`- paired tasks: ${report.paired_tasks.length} (${report.paired_tasks.join(", ") || "none"})`);
	lines.push("");
	lines.push("| measure | RTK OFF | RTK ON |");
	lines.push("| --- | --- | --- |");
	for (const [measure, off, on] of rows) lines.push(`| ${measure} | ${off} | ${on} |`);
	lines.push("");
	lines.push(`verdict: **${report.verdict}** (${report.verdict_source})`);
	lines.push("");
	lines.push(`_rule: ${report.rule}_`);
	return `${lines.join("\n")}\n`;
}
