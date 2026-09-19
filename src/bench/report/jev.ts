/**
 * The §56 JEV report (PRD-021 Phase 4).
 *
 * A pure fold over PRD-015's telemetry records and the bench ledger: this module
 * executes nothing. Every rate prints its numerator and denominator, so a rate
 * with no observations reads `n/a (0 observations)` instead of a misleading 0,
 * and every rate's derivation is printed next to it.
 *
 * Two §56 requirements shape the fold:
 *
 * - **accuracy is scored against the independent adjudicator**, never against
 *   LeanPi's own proof gate. The per-site table joins each site's recorded
 *   answer to the Phase 3 verdict, so a `proof_gate: PASS` that the golden
 *   rejects counts as a false pass.
 * - **fallback rows are not JEV observations.** A row carrying `fallback_used`
 *   is deterministic-fallback coverage and is excluded from every accuracy
 *   denominator, so a JEV-disabled run cannot read as perfect JEV accuracy.
 */
import { SKILL_SITE_ID } from "../../capabilities/skill-select.js";
import type { RunTelemetry } from "../../telemetry/record.js";
import { adjudicationFor, type TelemetrySource } from "./source.js";

export const JEV_REPORT_SCHEMA = 1;

/** A rate, with the counts it was computed from and the rule that produced them. */
export interface RateRow {
	id: string;
	label: string;
	rule: string;
	numerator: number;
	denominator: number;
	/** `null` when the denominator is zero — printed as `n/a`, never as 0. */
	rate: number | null;
}

/** One decision site's accuracy, scored against the adjudicator. */
export interface SiteRow {
	site_id: string;
	/** Resolved rows (JEV-answered plus fallback). */
	rows: number;
	/** Rows JEV answered; `fallback_used` rows are excluded. */
	answered: number;
	fallback: number;
	/** Answered rows whose answer is a completion prediction (`true`/`false`/`pass`/`fail`). */
	predictions: number;
	false_positives: number;
	false_negatives: number;
	false_positive_rate: number | null;
	false_negative_rate: number | null;
	tokens: number;
}

export interface JevReport {
	schema: typeof JEV_REPORT_SCHEMA;
	generated_at: string;
	source_dir: string;
	runs: number;
	adjudicated_runs: number;
	/** Runs the source carries without a bench ledger row: excluded from every rate. */
	unadjudicated_runs: number;
	rates: RateRow[];
	sites: SiteRow[];
	fallback_rows: number;
	decision_rows: number;
}

const BAND: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const NO_VERDICT: Record<string, true> = { "": true, none: true, "not_run": true, "not-required": true, "n/a": true, skipped: true, unavailable: true };

function passed(verdict: string): boolean {
	return verdict === "PASS" || verdict === "pass";
}

function verdictPresent(verdict: string): boolean {
	return !NO_VERDICT[verdict];
}

/** The band the attempt's *outcome* shows was needed: no retry and no escalation needed the cheapest band. */
function neededBand(run: RunTelemetry, complete: boolean): number {
	if (!complete || run.execution.retries + run.execution.escalations >= 2) return 2;
	if (run.execution.retries === 0 && run.execution.escalations === 0) return 0;
	return 1;
}

function rateRow(id: string, label: string, rule: string, numerator: number, denominator: number): RateRow {
	return { id, label, rule, numerator, denominator, rate: denominator === 0 ? null : numerator / denominator };
}

function predictionOf(answer: unknown): boolean | null {
	const scalar = Array.isArray(answer) ? answer[0] : answer;
	if (typeof scalar === "boolean") return scalar;
	if (scalar === "pass" || scalar === "complete" || scalar === "PASS") return true;
	if (scalar === "fail" || scalar === "incomplete" || scalar === "FAIL") return false;
	return null;
}

function skillAnswers(run: RunTelemetry): string[] {
	return run.jev_decisions
		.filter((row) => row.site_id === SKILL_SITE_ID && !row.fallback_used)
		.flatMap((row) => (Array.isArray(row.answer) ? row.answer : [row.answer]))
		.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export interface JevReportOptions {
	generated_at?: string;
}

/** Fold the source into §56's rates plus the per-site accuracy table. */
export function jevReport(source: TelemetrySource, options: JevReportOptions = {}): JevReport {
	const complete = new Map<string, boolean>();
	// §56 scores every rate against the independent verdict, so a run the bench
	// never adjudicated is not counted at all: reading "no verdict" as "not
	// complete" would manufacture false passes and missed risks out of nothing.
	const runs: RunTelemetry[] = [];
	let adjudicated = 0;
	for (const run of source.runs) {
		const verdict = adjudicationFor(source, run.task_id);
		if (verdict === null) continue;
		runs.push(run);
		adjudicated += 1;
		complete.set(run.task_id, verdict === "complete");
	}
	const done = (run: RunTelemetry): boolean => complete.get(run.task_id) === true;

	let prdUsed = 0;
	let prdUnused = 0;
	let prdFalsePositive = 0;
	let prdFalseNegative = 0;
	let over = 0;
	let under = 0;
	let skillDisclosedRuns = 0;
	let skillUnnecessary = 0;
	let skillNamed = 0;
	let skillWrong = 0;
	let mcpDisclosedRuns = 0;
	let mcpUnnecessary = 0;
	let reviewerRuns = 0;
	let reviewerUnnecessary = 0;
	let reviewerMissed = 0;
	let proofRuns = 0;
	let proofFalsePass = 0;
	let proofUnnecessary = 0;
	let escalated = 0;
	let escalationWorked = 0;

	for (const run of runs) {
		const band = BAND[run.route.complexity] ?? 1;
		const needed = neededBand(run, done(run));
		if (band > needed) over += 1;
		if (band < needed) under += 1;

		if (run.prd_used !== null) {
			prdUsed += 1;
			if (!done(run)) prdFalsePositive += 1;
		} else {
			prdUnused += 1;
			if (!done(run)) prdFalseNegative += 1;
		}

		const disclosed = run.capabilities?.skills_disclosed ?? [];
		if (disclosed.length > 0) {
			skillDisclosedRuns += 1;
			if (disclosed.some((skill) => !(run.capabilities.skills_used ?? []).includes(skill))) skillUnnecessary += 1;
		}
		const named = skillAnswers(run);
		if (named.length > 0) {
			skillNamed += 1;
			if (named.some((skill) => !(run.capabilities?.skills_used ?? []).includes(skill))) skillWrong += 1;
		}

		const mcps = run.capabilities?.mcps_disclosed ?? [];
		if (mcps.length > 0) {
			mcpDisclosedRuns += 1;
			if (mcps.some((name) => !(run.capabilities.mcps_used ?? []).includes(name))) mcpUnnecessary += 1;
		}

		if (verdictPresent(run.result.reviewer)) {
			reviewerRuns += 1;
			if (needed === 0) reviewerUnnecessary += 1;
			if (passed(run.result.reviewer) && !done(run)) reviewerMissed += 1;
		}
		if (verdictPresent(run.result.proof_gate)) {
			proofRuns += 1;
			if (passed(run.result.proof_gate) && !done(run)) proofFalsePass += 1;
			if (needed === 0 && done(run)) proofUnnecessary += 1;
		}
		if (run.execution.escalations > 0) {
			escalated += 1;
			if (done(run)) escalationWorked += 1;
		}
	}

	const sites = new Map<string, SiteRow>();
	let fallbackRows = 0;
	let decisionRows = 0;
	for (const run of runs) {
		for (const row of run.jev_decisions ?? []) {
			const site = sites.get(row.site_id) ?? {
				site_id: row.site_id,
				rows: 0,
				answered: 0,
				fallback: 0,
				predictions: 0,
				false_positives: 0,
				false_negatives: 0,
				false_positive_rate: null,
				false_negative_rate: null,
				tokens: 0,
			};
			site.rows += 1;
			decisionRows += 1;
			site.tokens += row.tokens;
			if (row.fallback_used) {
				site.fallback += 1;
				fallbackRows += 1;
			} else {
				site.answered += 1;
				const prediction = predictionOf(row.answer);
				if (prediction !== null) {
					site.predictions += 1;
					if (prediction && !done(run)) site.false_positives += 1;
					if (!prediction && done(run)) site.false_negatives += 1;
				}
			}
			sites.set(row.site_id, site);
		}
	}
	for (const site of sites.values()) {
		site.false_positive_rate = site.predictions === 0 ? null : site.false_positives / site.predictions;
		site.false_negative_rate = site.predictions === 0 ? null : site.false_negatives / site.predictions;
	}

	return {
		schema: JEV_REPORT_SCHEMA,
		generated_at: options.generated_at ?? new Date().toISOString(),
		source_dir: source.dir,
		runs: source.runs.length,
		adjudicated_runs: adjudicated,
		unadjudicated_runs: source.runs.length - adjudicated,
		rates: [
			rateRow("prd_false_positive", "PRD false-positive rate", "runs whose PRD lane ran and whose task the adjudicator rejects ÷ runs with prd_used", prdFalsePositive, prdUsed),
			rateRow("prd_false_negative", "PRD false-negative rate", "failed runs with no PRD lane ÷ runs with prd_used null", prdFalseNegative, prdUnused),
			rateRow("complexity_over_routing", "complexity over-routing", "runs routed above the band their outcome needed ÷ runs (needed = LOW when complete with no retry or escalation)", over, runs.length),
			rateRow("complexity_under_routing", "complexity under-routing", "runs routed below the band their outcome needed ÷ runs", under, runs.length),
			rateRow("skill_wrong_selection", "skill wrong-selection", `runs whose ${SKILL_SITE_ID} answer names a skill the run never used ÷ runs with that site answered`, skillWrong, skillNamed),
			rateRow("skill_unnecessary_load", "skill unnecessary-load", "runs disclosing a skill they never used ÷ runs with at least one skill disclosed", skillUnnecessary, skillDisclosedRuns),
			rateRow("mcp_unnecessary_disclosure", "MCP unnecessary-disclosure", "runs disclosing an MCP they never used ÷ runs with at least one MCP disclosed", mcpUnnecessary, mcpDisclosedRuns),
			rateRow("review_unnecessary_call", "review unnecessary-call", "reviewer verdicts on runs that needed no escalation band ÷ runs with a reviewer verdict", reviewerUnnecessary, reviewerRuns),
			rateRow("review_missed_risk", "review missed-risk", "passing reviewer verdicts on tasks the adjudicator rejects ÷ runs with a reviewer verdict", reviewerMissed, reviewerRuns),
			rateRow("proof_false_pass", "proof false-pass", "passing proof gates on tasks the adjudicator rejects ÷ runs with a proof-gate verdict", proofFalsePass, proofRuns),
			rateRow("proof_unnecessary_evidence", "proof unnecessary-evidence", "proof-gate verdicts on runs that needed no escalation band and completed ÷ runs with a proof-gate verdict", proofUnnecessary, proofRuns),
			rateRow("escalation_accuracy", "escalation accuracy", "escalations followed by adjudicated completion ÷ runs that escalated", escalationWorked, escalated),
		],
		sites: [...sites.values()].sort((left, right) => (left.site_id < right.site_id ? -1 : 1)),
		fallback_rows: fallbackRows,
		decision_rows: decisionRows,
	};
}

function siteRate(value: number | null, numerator: number, denominator: number): string {
	return value === null ? `n/a (0 predictions; ${numerator}/${denominator})` : `${value.toFixed(4)} (${numerator}/${denominator})`;
}

/** The printed §56 report, with each rate's numerator, denominator and rule. */
export function renderJevReport(report: JevReport): string {
	const lines: string[] = [];
	lines.push(`# §56 JEV report — ${report.source_dir}`);
	lines.push("");
	lines.push(`- generated: ${report.generated_at}`);
	lines.push(`- telemetry runs: ${report.runs} (${report.adjudicated_runs} carry an adjudicated verdict; ${report.unadjudicated_runs} are excluded from every rate below)`);
	lines.push(`- decision rows: ${report.decision_rows} (${report.fallback_rows} carry fallback-used and are counted as deterministic-fallback coverage, never as JEV accuracy)`);
	lines.push("");
	lines.push("## §56 rates");
	lines.push("");
	lines.push("| rate | value | derivation |");
	lines.push("| --- | --- | --- |");
	for (const row of report.rates) {
		const value = row.rate === null ? `n/a (0 observations; ${row.numerator}/${row.denominator})` : `${row.rate.toFixed(4)} (${row.numerator}/${row.denominator})`;
		lines.push(`| ${row.label} | ${value} | ${row.rule} |`);
	}
	lines.push("");
	lines.push("## per-decision-site accuracy (scored against the adjudicator, never against the proof gate)");
	lines.push("");
	lines.push("| site | answered | fallback | predictions | false-positive rate | false-negative rate | tokens |");
	lines.push("| --- | --- | --- | --- | --- | --- | --- |");
	for (const site of report.sites) {
		lines.push(
			`| ${site.site_id} | ${site.answered === 0 ? "n/a (0 JEV observations)" : site.answered} | ${site.fallback} | ${site.predictions} | ${siteRate(
				site.false_positive_rate,
				site.false_positives,
				site.predictions,
			)} | ${siteRate(site.false_negative_rate, site.false_negatives, site.predictions)} | ${site.tokens} |`,
		);
	}
	return `${lines.join("\n")}\n`;
}
