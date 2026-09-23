/**
 * PRD-021 AC-1, AC-2, AC-8 — the run, the A/B pairing and the suite inventory.
 *
 * The suite under the run is the *real* `bench/suites/seed` inventory restated
 * with local acceptance commands (`localiseSeedSuite`): same ten task ids,
 * prompts and §55 categories, so the seed data is exercised end-to-end without
 * cloning ten upstream repositories and installing ten toolchains. The execution
 * seam is the one PRD-015's RTK A/B declares for PRD-021 — a scripted session
 * where a real one would run — and the scripted session writes its §52 record
 * with PRD-015's own writer, into the run's store.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../../src/index.js";
import { capabilityOf, foldReport } from "../../src/bench/metrics.js";
import { readLedger, runBench } from "../../src/bench/runner.js";
import { coverageOf, loadSuite, SEED_SUITE_DIR, SUITE_CATEGORIES } from "../../src/bench/suite.js";
import { main, recompute } from "../../src/bench/cli.js";
import { appendRun } from "../../src/telemetry/index.js";
import type { RunTelemetry } from "../../src/telemetry/index.js";
import type { BenchConfigRow, BenchLedgerRow } from "../../src/bench/types.js";
import { capturingIo, fixtureConfig, localiseSeedSuite, preparedWorkspaces, tempDir, writeRunFixture } from "./helpers.js";

const SEED = loadSuite(SEED_SUITE_DIR, PACKAGE_ROOT);
const SEED_IDS = SEED.tasks.map((task) => task.id);
const NINTH = SEED_IDS[8] as string;
const LAST = SEED_IDS[9] as string;

function record(taskId: string, sessionId: string, options: { cost: number; wallMs: number; success: boolean; model: string }): RunTelemetry {
	return {
		task_id: taskId,
		session_id: sessionId,
		route: { complexity: "MEDIUM", executor_class: "balanced", reviewer_class: "review_quick", reasoning: "medium" },
		prd_used: null,
		executor_backend: "local",
		executor_model: options.model,
		reviewer_backend: "local",
		reviewer_model: "gemini-2.5-flash",
		usage: { input_tokens: 10_000, cached_input_tokens: 0, output_tokens: 1_000, reasoning_tokens: 0, jev_tokens: 0, local_gpu_seconds: 0, external_harness_calls: 0, subscription_usage: 0 },
		cost: { api_usd: options.cost, jev_usd: 0, estimated_quota_cost: 0, effective_cost: options.cost },
		execution: { wall_ms: options.wallMs, tool_calls: 3, file_reads: 2, repeated_reads: 0, retries: 0, escalations: 0, compactions: 0 },
		result: { verification: "pass", proof_gate: "PASS", reviewer: "PASS", success: options.success },
		capabilities: { skills_disclosed: [], skills_used: [], mcps_disclosed: [], mcps_used: [] },
		jev_decisions: [],
		calls: [],
	};
}

/** Zero-based position of a seed task, so both configurations' outcomes are explicit. */
function indexOf(taskId: string): number {
	return SEED_IDS.indexOf(taskId);
}

interface RunOutcome {
	runDir: string;
	reportText: string;
	report: {
		configs: Array<Record<string, unknown>>;
		pairing: Array<{ task_id: string; arms: Array<{ config_id: string }> }>;
		telemetry_rows: number;
	};
	ledger: BenchLedgerRow[];
}

async function runSeedSuite(root: string, runId: string): Promise<RunOutcome> {
	const runDir = join(root, "out", runId);
	// One fixed acceptance check for the whole suite; whether an attempt satisfies
	// it is the attempt's own doing, which is what keeps the golden held out.
	const suiteDir = localiseSeedSuite(PACKAGE_ROOT, join(root, "suite"), () => ({ complete: true }));
	const workspaces = preparedWorkspaces(root);
	const run = await runBench({
		cwd: PACKAGE_ROOT,
		config: fixtureConfig(root),
		suiteDir,
		configDir: "bench/configs",
		configIds: ["leanpi-no-jev", "leanpi-jev"],
		runId,
		outDir: join(root, "out"),
		prepare: workspaces.prepare,
		now: () => new Date("2026-09-19T00:00:00.000Z"),
		execute: async (attempt) => {
			const noJev = attempt.config.id === "leanpi-no-jev";
			// The two configurations disagree about the last two tasks: no-JEV solves
			// eight, JEV solves nine, and each claims one more than it solved. The
			// golden the adjudicator runs is fixed for the whole run, so the marker
			// file is the whole difference.
			if (indexOf(attempt.task.id) < (noJev ? 8 : 9)) writeFileSync(join(attempt.workspace, "bench-done-marker"), "done\n");
			appendRun(
				attempt.workspace,
				record(attempt.telemetry_task_id, attempt.session_id, {
					cost: noJev ? 0.02 : 0.01,
					wallMs: attempt.task.id === NINTH ? 4000 : noJev ? 2000 : 1000,
					// The rows disagree about the ninth task: no-JEV claims it and the
					// adjudicator rejects it, which is what makes the metric differ.
					success: noJev ? indexOf(attempt.task.id) < 9 : true,
					model: attempt.config.executor_model,
				}),
				{ telemetry_path: attempt.telemetry_path },
			);
			return { extensions: ["leanpi"], operator: "scripted", subscription_usage: 0, note: null };
		},
	});
	return {
		runDir,
		reportText: readFileSync(run.report_path, "utf8"),
		report: JSON.parse(readFileSync(run.report_json_path, "utf8")) as RunOutcome["report"],
		ledger: readLedger(run.ledger_path),
	};
}

describe("PRD-021 AC-1/AC-2 — the §53 report over two LeanPi configurations", () => {
	it("runs the seed suite for both configurations and derives every §53 metric from the ledger", async () => {
		const root = tempDir();
		const outcome = await runSeedSuite(root, "ac1");
		const [noJev, jev] = outcome.report.configs as Array<Record<string, number | string | null | { index: number | null }>>;
		expect(noJev?.config_id).toBe("leanpi-no-jev");
		expect(jev?.config_id).toBe("leanpi-jev");
		expect(outcome.ledger).toHaveLength(20);
		expect(outcome.report.telemetry_rows).toBe(20);

		// §53's five metrics, each present in the printed artifact.
		for (const label of ["verified solve rate", "cost/verified success", "generator tokens/verified success", "time to verified success", "false completion rate"]) {
			expect(outcome.reportText).toContain(label);
		}
		expect(noJev?.attempts).toBe(10);
		expect(noJev?.verified_solve_rate).toBeCloseTo(0.8, 10);
		expect(jev?.verified_solve_rate).toBeCloseTo(0.9, 10);
		// §53 states cost per verified success over the total effective cost.
		expect(noJev?.effective_cost_total).toBeCloseTo(0.2, 6);
		expect(jev?.effective_cost_total).toBeCloseTo(0.1, 6);
		expect(noJev?.effective_cost_total).not.toBe(jev?.effective_cost_total);
		expect(noJev?.cost_per_verified_success).toBeCloseTo(0.2 / 8, 10);
		expect(noJev?.generator_tokens_per_verified_success).toBeCloseTo((10 * 11_000) / 8, 6);
		// Nearest-rank p95, labelled with n so a ten-task sample is not read as a quantile.
		expect(outcome.reportText).toContain("p95 (nearest-rank, n=8)");
		expect(outcome.reportText).toContain("p95 (nearest-rank, n=9)");
		// False completion quantifies the disagreement §53 exists to catch.
		expect(noJev?.false_completion_rate).toBeCloseTo(1 / 9, 10);
		expect(jev?.false_completion_rate).toBeCloseTo(1 / 10, 10);
		expect(outcome.reportText).toContain("tasks: " + NINTH);
		// The capability index is looked up per configuration's executor model.
		expect((noJev?.capability as { index: number | null }).index).toBeGreaterThan(0);
		expect(noJev?.loaded_extensions).toEqual(["leanpi"]);
	});

	it("states the per-task pairing that makes the A/B two runs rather than one reported twice", async () => {
		const root = tempDir();
		const outcome = await runSeedSuite(root, "ac2");
		expect(outcome.report.pairing).toHaveLength(10);
		for (const row of outcome.report.pairing) {
			expect(row.arms.map((arm) => arm.config_id)).toEqual(["leanpi-no-jev", "leanpi-jev"]);
		}
		expect(outcome.reportText).toContain("## per-task pairing");
		expect(outcome.reportText).toContain(NINTH);
	});

	it("preserves task-major, config-major fold order over an interleaved ledger", () => {
		const configRow = (id: string): BenchConfigRow => ({
			id,
			label: id,
			adapter: "leanpi",
			vendor: null,
			jev: "disabled",
			executor_model: "qwen3-coder-480b-a35b",
			reviewer_model: null,
			features: [],
			owner_gated: false,
			subscription: false,
			budget_usd: 0,
		});
		const row = (configId: string, taskId: string, attempt: number, verdict: BenchLedgerRow["adjudication"]["verdict"]): BenchLedgerRow => {
			const telemetry_task_id = `${taskId}@${configId}#${attempt}`;
			return {
				run_id: "fold-order",
				task_id: taskId,
				config_id: configId,
				telemetry_task_id,
				session_id: telemetry_task_id,
				source: { repo: "fixture", commit: "0".repeat(40), fix_commit: null, pinned_via: "fixture" },
				budget_usd: 0,
				reported_success: true,
				adjudication: { verdict, kind: "upstream-test", adjudicator: "test -f marker", reason: null, rubric_model: null, reviewer_model: "gemini-2.5-flash" },
				adapter: { operator: "scripted", extensions: [], note: null },
				note: null,
				started_at: "2026-09-19T00:00:00.000Z",
				finished_at: "2026-09-19T00:00:01.000Z",
			};
		};
		// Deliberately interleaved: cfg-b leads, one pair's attempts are non-adjacent,
		// and the source order is neither task-major nor config-major.
		const ledger = [
			row("cfg-b", "task-1", 1, "incomplete"),
			row("cfg-a", "task-2", 1, "complete"),
			row("cfg-a", "task-1", 1, "complete"),
			row("cfg-b", "task-2", 1, "incomplete"),
			row("cfg-a", "task-1", 2, "incomplete"),
			row("cfg-b", "task-1", 2, "error"),
		];
		const telemetry = ledger.map((entry) => record(entry.telemetry_task_id, entry.session_id, { cost: 0.01, wallMs: 1000, success: true, model: "qwen3-coder-480b-a35b" }));
		const report = foldReport({
			run_id: "fold-order",
			generated_at: "2026-09-19T00:00:00.000Z",
			suite_dir: "fixture",
			tasks: [{ id: "task-1" }, { id: "task-2" }],
			ledger,
			telemetry,
			configs: [configRow("cfg-a"), configRow("cfg-b")],
			config: null,
		});
		// Task-major: one pairing row per task, in suite order.
		expect(report.pairing.map((pair) => pair.task_id)).toEqual(["task-1", "task-2"]);
		// Config-major in the config list's order — cfg-a before cfg-b though cfg-b leads the ledger.
		expect(report.pairing.map((pair) => pair.arms.map((arm) => arm.config_id))).toEqual([
			["cfg-a", "cfg-a", "cfg-b", "cfg-b"],
			["cfg-a", "cfg-b"],
		]);
		// Source order kept among multiple attempts of one (task, config) pair.
		expect(report.pairing.map((pair) => pair.arms.map((arm) => arm.adjudication))).toEqual([
			["complete", "incomplete", "incomplete", "error"],
			["complete", "incomplete"],
		]);
	});

	it("recomputes every rate from an edited ledger — 2/4 reads 0.50, one flipped row reads 0.25", () => {
		const root = tempDir();
		const runDir = join(root, "recompute");
		const rows: BenchLedgerRow[] = ["a", "b", "c", "d"].map((id, index) => ({
			run_id: "hand-edited",
			task_id: id,
			config_id: "leanpi-jev",
			telemetry_task_id: `${id}@leanpi-jev`,
			session_id: "s",
			source: { repo: "fixture", commit: "0".repeat(40), fix_commit: null, pinned_via: "fixture" },
			budget_usd: 0,
			reported_success: true,
			adjudication: {
				verdict: index < 2 ? "complete" : "incomplete",
				kind: "upstream-test",
				adjudicator: "test -f marker",
				reason: null,
				rubric_model: null,
				reviewer_model: "gemini-2.5-flash",
			},
			adapter: { operator: "scripted", extensions: [], note: null },
			note: null,
			started_at: "2026-09-19T00:00:00.000Z",
			finished_at: "2026-09-19T00:00:01.000Z",
		}));
		const records = ["a", "b", "c", "d"].map((id) => record(`${id}@leanpi-jev`, "s", { cost: 0.01, wallMs: 1000, success: true, model: "qwen3-coder-480b-a35b" }));
		writeRunFixture(runDir, rows, records);

		const first = recompute(runDir, fixtureConfig(root), { cwd: PACKAGE_ROOT, configDir: "bench/configs" });
		expect(first.report.configs[0]?.verified_solve_rate).toBeCloseTo(0.5, 10);
		expect(first.markdown).toContain("0.5000 (2/4)");

		// Flip one row to a failure: a literal would not move.
		rows[0]!.adjudication.verdict = "incomplete";
		writeRunFixture(runDir, rows, records);
		const second = recompute(runDir, fixtureConfig(root), { cwd: PACKAGE_ROOT, configDir: "bench/configs" });
		expect(second.report.configs[0]?.verified_solve_rate).toBeCloseTo(0.25, 10);
		expect(second.markdown).toContain("0.2500 (1/4)");
	});

	it("states the §4 targets as comparison context and degrades to index: unavailable without a catalog", async () => {
		const root = tempDir();
		const runDir = join(root, "out", "ac1b");
		const storePath = join(runDir, "telemetry.jsonl");
		const run = await runBench({
			cwd: PACKAGE_ROOT,
			config: fixtureConfig(root, { rankingFile: join(root, "absent-ranking.json") }),
			suiteDir: localiseSeedSuite(PACKAGE_ROOT, join(root, "suite-b"), () => ({ complete: true })),
			configDir: "bench/configs",
			configIds: ["leanpi-jev", "stock-pi"],
			runId: "ac1b",
			outDir: join(root, "out"),
			prepare: preparedWorkspaces(root).prepare,
			execute: async (attempt) => {
				writeFileSync(join(attempt.workspace, "bench-done-marker"), "done\n");
				appendRun(attempt.workspace, record(attempt.telemetry_task_id, attempt.session_id, { cost: 0.01, wallMs: 1000, success: true, model: attempt.config.executor_model }), {
					telemetry_path: storePath,
				});
				return { extensions: [], operator: "scripted", subscription_usage: 0, note: null };
			},
		});
		const text = readFileSync(run.report_path, "utf8");
		// §4 is printed, labelled, and never a gate: the exit code is unaffected.
		expect(text).toContain("## §4 aspirational targets (comparison context, not a gate)");
		expect(text).toContain("baseline row: stock-pi");
		expect(text).toContain("relative to baseline");
		expect(text).toContain("index: unavailable");
		expect(run.report.section4_measured.find((row) => row.config_id === "leanpi-jev")?.relative_to_baseline).toBeCloseTo(1, 6);
		expect(run.report.section4.cost_ratio_of_baseline).toBe(0.25);
	});

	it("prints index: unavailable when the capability catalog cannot be read", () => {
		const root = tempDir();
		const annotation = capabilityOf(fixtureConfig(root, { rankingFile: join(root, "absent-ranking.json") }), "gpt-5-mini");
		expect(annotation.index).toBeNull();
		expect(annotation.unavailable_reason).toContain("absent-ranking.json");
		const missing = capabilityOf(fixtureConfig(root), "a-model-no-catalog-lists");
		expect(missing.index).toBeNull();
		expect(missing.unavailable_reason).toContain("not listed");
	});
});

describe("PRD-021 AC-8 — the suite inventory and the §55 coverage table", () => {
	it("prints ten tasks with their source repository and commit, and marks the unfilled §55 categories", async () => {
		const io = capturingIo();
		const exit = await main(["--list"], { cwd: PACKAGE_ROOT, io });
		expect(exit).toBe(0);
		expect(SEED_IDS).toHaveLength(10);
		for (const task of SEED.tasks) {
			expect(io.text).toContain(task.source.repo);
			expect(task.source.commit).toMatch(/^[0-9a-f]{40}$/);
			expect(task.source.fix_commit).toMatch(/^[0-9a-f]{40}$/);
			expect(io.text).toContain(task.source.commit);
		}
		expect(io.text).toContain("§55 coverage");
		expect(io.text).toContain("UNFILLED");
		expect(io.text).toContain("50–100");
		const coverage = coverageOf(SEED.tasks);
		expect(coverage).toHaveLength(SUITE_CATEGORIES.length);
		expect(coverage.filter((row) => row.filled).length).toBeLessThan(coverage.length);
		expect(io.text).toContain(`this suite holds 10 and fills ${coverage.filter((row) => row.filled).length} categor`);
		// The matrix's roster is printed, including the owner-gated rows.
		for (const row of ["leanpi-no-jev", "leanpi-jev", "leanpi-subscription", "leanpi-all", "stock-pi", "claude-code", "codex"]) {
			expect(io.text).toContain(row);
		}
	});
});
