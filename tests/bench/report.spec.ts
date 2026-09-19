/**
 * PRD-021 AC-6 and AC-7 — the §56 JEV report and the §57 RTK comparison.
 *
 * Both reports are folds over `bench/fixtures/telemetry/`, whose numbers are
 * hand-checked: eight runs with two known over-routed tasks, a decision site with
 * one false positive and one false negative in ten answered calls, a site whose
 * rows all carry `fallback-used`, and paired RTK arms whose cost and solve rate
 * differ. The assertions below are the *printed* report, because that is the
 * artifact the roadmap's §56/§57 sections describe.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../../src/index.js";
import { main } from "../../src/bench/cli.js";
import { jevReport } from "../../src/bench/report/jev.js";
import { renderRtkReport, rtkReport } from "../../src/bench/report/rtk.js";
import { readTelemetryDir } from "../../src/bench/report/source.js";
import { capturingIo, tempDir } from "./helpers.js";

const JEV_DIR = join(PACKAGE_ROOT, "bench", "fixtures", "telemetry", "jev");
const RTK_DIR = join(PACKAGE_ROOT, "bench", "fixtures", "telemetry", "rtk");

describe("PRD-021 AC-6 — §56 rates with their numerators and denominators", () => {
	it("reports 0.25 for the known 2-of-8 over-routing fixture and prints n/a where nothing was observed", async () => {
		const io = capturingIo();
		const exit = await main(["--report", "jev", "--from", JEV_DIR], { cwd: PACKAGE_ROOT, io });
		expect(exit).toBe(0);
		const text = io.text;
		expect(text).toContain("| complexity over-routing | 0.2500 (2/8) |");
		expect(text).toContain("| complexity under-routing | 0.0000 (0/8) |");
		// A rate with no observations is n/a, never a misleading 0.
		expect(text).toContain("| PRD false-positive rate | n/a (0 observations; 0/0) |");
		expect(text).toContain("| PRD false-negative rate | 0.2500 (2/8) |");
		// Every §56 rate is printed with its rule.
		const report = jevReport(readTelemetryDir(JEV_DIR));
		expect(report.rates).toHaveLength(12);
		for (const rate of report.rates) {
			expect(text).toContain(rate.label);
			expect(rate.rule.length).toBeGreaterThan(20);
		}
	});

	it("scores each decision site against the adjudicator and never reads fallback rows as accuracy", () => {
		const report = jevReport(readTelemetryDir(JEV_DIR));
		const sufficiency = report.sites.find((site) => site.site_id === "proof.sufficiency");
		expect(sufficiency?.answered).toBe(10);
		expect(sufficiency?.predictions).toBe(10);
		expect(sufficiency?.false_positives).toBe(1);
		expect(sufficiency?.false_negatives).toBe(1);
		expect(sufficiency?.false_positive_rate).toBeCloseTo(0.1, 10);
		expect(sufficiency?.false_negative_rate).toBeCloseTo(0.1, 10);

		const mcp = report.sites.find((site) => site.site_id === "mcp.disclosure");
		expect(mcp?.rows).toBe(2);
		expect(mcp?.fallback).toBe(2);
		expect(mcp?.answered).toBe(0);
		expect(mcp?.false_positive_rate).toBeNull();
		expect(mcp?.false_negative_rate).toBeNull();

		const effort = report.sites.find((site) => site.site_id === "routing.reasoning_effort");
		expect(effort?.answered).toBe(2);
		expect(effort?.predictions).toBe(0);

		const skill = report.sites.find((site) => site.site_id === "skill.disclosure");
		expect(skill?.answered).toBe(3);
	});

	it("prints the per-site table and the derivation rules", async () => {
		const io = capturingIo();
		await main(["--report", "jev", "--from", JEV_DIR], { cwd: PACKAGE_ROOT, io });
		expect(io.text).toContain("per-decision-site accuracy (scored against the adjudicator, never against the proof gate)");
		expect(io.text).toContain("| proof.sufficiency | 10 | 0 | 10 | 0.1000 (1/10) | 0.1000 (1/10) |");
		expect(io.text).toContain("| mcp.disclosure | n/a (0 JEV observations) | 2 | 0 |");
	});

	it("excludes runs the bench never adjudicated instead of reading them as failures", () => {
		const dir = tempDir("leanpi-jev-bare-");
		writeFileSync(join(dir, "telemetry.jsonl"), readFileSync(join(JEV_DIR, "telemetry.jsonl")));
		const report = jevReport(readTelemetryDir(dir));
		expect(report.runs).toBe(8);
		expect(report.adjudicated_runs).toBe(0);
		expect(report.unadjudicated_runs).toBe(8);
		// Every rate reads n/a: nothing was adjudicated, so nothing was scored.
		expect(report.rates.every((rate) => rate.rate === null)).toBe(true);
		expect(report.sites.every((site) => site.false_positive_rate === null && site.false_negative_rate === null)).toBe(true);
	});

	it("reports the three §56 rates whose numerator the fixture pins", () => {
		const report = jevReport(readTelemetryDir(JEV_DIR));
		const byId = Object.fromEntries(report.rates.map((rate) => [rate.id, rate]));
		expect(byId.skill_wrong_selection?.numerator).toBe(1);
		expect(byId.skill_wrong_selection?.denominator).toBe(3);
		expect(byId.proof_false_pass?.numerator).toBe(1);
		expect(byId.proof_false_pass?.denominator).toBe(5);
		expect(byId.review_missed_risk?.numerator).toBe(1);
		expect(byId.escalation_accuracy?.rate).toBe(1);
	});
});

describe("PRD-021 AC-7 — the §57 RTK comparison and its verdict", () => {
	it("prints the seven measures from the paired telemetry and promotes only on an end-to-end improvement", async () => {
		const io = capturingIo();
		const exit = await main(["--report", "rtk", "--from", RTK_DIR], { cwd: PACKAGE_ROOT, io });
		expect(exit).toBe(0);
		for (const measure of ["shell-output bytes", "context tokens", "model calls", "retries", "solve rate", "wall time (ms)", "cost per success"]) {
			expect(io.text).toContain(measure);
		}
		expect(io.text).toContain("| shell-output bytes | 40960 | 12288 |");
		expect(io.text).toContain("verdict: **promote** (improved)");

		const report = rtkReport(RTK_DIR);
		expect(report.off.cost_per_success).toBeCloseTo(0.03, 10);
		expect(report.on.cost_per_success).toBeCloseTo(0.01, 10);
		expect(report.off.solve_rate).toBe(1);
		expect(report.on.solve_rate).toBe(1);
		expect(report.off.retries).toBe(2);
		expect(report.on.retries).toBe(0);
		expect(report.off.wall_ms).toBe(24_000);
		expect(report.off.context_tokens).toBe(30_000 + 28_000 + 26_000 + 3 * 500);
		// The measures are folded from the telemetry records; the RTK measurement
		// file only supplies shell-output bytes (its other fields are sentinels).
		expect(report.on.context_tokens).not.toBe(999_999);
		expect(report.paired_tasks).toEqual(["rtk-task-1", "rtk-task-2", "rtk-task-3"]);
	});

	it("inverts the verdict when the two input sets are inverted", () => {
		const swapped = tempDir("leanpi-rtk-swap-");
		for (const [from, to] of [["on", "off"], ["off", "on"]] as const) {
			mkdirSync(join(swapped, to), { recursive: true });
			cpSync(join(RTK_DIR, from, "telemetry.jsonl"), join(swapped, to, "telemetry.jsonl"));
			cpSync(join(RTK_DIR, from, "ledger.jsonl"), join(swapped, to, "ledger.jsonl"));
		}
		const measurement = JSON.parse(readFileSync(join(RTK_DIR, "rtk-measurement.json"), "utf8")) as { arms: Record<string, unknown> };
		writeFileSync(join(swapped, "rtk-measurement.json"), JSON.stringify({ ...measurement, arms: { off: measurement.arms.on, on: measurement.arms.off } }));
		const report = rtkReport(swapped);
		expect(report.off.cost_per_success).toBeCloseTo(0.01, 10);
		expect(report.on.cost_per_success).toBeCloseTo(0.03, 10);
		expect(report.verdict).toBe("do-not-promote");
		expect(report.verdict_source).toBe("no_benefit");
		expect(report.off.shell_output_bytes).toBe(12_288);
	});

	it("prints n/a for an arm's solve rate rather than 0 when nothing was adjudicated", () => {
		const arms = tempDir("leanpi-rtk-bare-");
		for (const arm of ["off", "on"] as const) {
			mkdirSync(join(arms, arm), { recursive: true });
			writeFileSync(join(arms, arm, "telemetry.jsonl"), readFileSync(join(RTK_DIR, arm, "telemetry.jsonl")));
		}
		const report = rtkReport(arms);
		expect(report.off.solve_rate).toBeNull();
		expect(report.on.solve_rate).toBeNull();
		expect(report.verdict).toBe("do-not-promote");
		expect(renderRtkReport(report)).toContain("n/a (0 adjudicated attempts; 3 run(s))");
	});

	it("refuses an arm directory layout it cannot pair", () => {
		const empty = tempDir("leanpi-rtk-empty-");
		expect(() => rtkReport(empty)).toThrow(/must hold an "off" and an "on" arm directory/);
	});
});
