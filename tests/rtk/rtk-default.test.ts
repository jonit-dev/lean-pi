/**
 * PRD-019 Phase 3 — AC-6 and AC-7: the §57 A/B measurement and the default it decides.
 *
 * The runner is driven over a fixture set with a real telemetry store and real
 * PRD-009 evidence records; the assertions recompute cost per success from the
 * store rather than trusting the report, and check both directions of the
 * verdict — a one-value stub fails one of them.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactStore } from "../../src/context/artifacts.js";
import { reduceToolOutput, type RtkCallRecord } from "../../src/rtk/index.js";
import {
	loadShellHeavyFixtures,
	readRtkMeasurement,
	resolveRtkDefault,
	RTK_MEASUREMENT_PATH_DEFAULT,
	rtkMeasurementPath,
	rtkModeOf,
	runRtkAb,
	SHELL_HEAVY_FIXTURES,
	solveRateOf,
	verdictFromArms,
	type RtkArmMetrics,
	type RtkFixtureTask,
	type RtkMeasurement,
} from "../../src/rtk/index.js";
import type { RunTelemetry } from "../../src/telemetry/record.js";
import { round6 } from "../../src/telemetry/pricing.js";
import { appendRun, readRuns } from "../../src/telemetry/store.js";
import { EvidenceStore } from "../../src/verify/evidence.js";
import type { EvidenceRecord } from "../../src/verify/evidence.js";
import { tempDir } from "../helpers/fixtures.js";
import { countingSpawn, REDUCING_REDUCER, reducerCommand, rtkConfig } from "./helpers.js";

const TASKS: RtkFixtureTask[] = [
	{ id: "typecheck", kind: "build", command: "pnpm", args: ["tsc", "--noEmit"] },
	{ id: "unit-tests", kind: "test", command: "pnpm", args: ["vitest", "run"] },
	{ id: "lint-scan", kind: "lint", command: "pnpm", args: ["eslint", "."] },
];

const OUTPUT_BY_TASK: Record<string, string> = {
	typecheck: Array.from({ length: 1200 }, (_, index) => `src/a${index}.ts(${index},1): error TS2322: Type mismatch ${"y".repeat(30)}`).join("\n"),
	"unit-tests": Array.from({ length: 900 }, (_, index) => `FAIL tests/spec-${index}.test.ts > case ${index} ${"z".repeat(30)}`).join("\n"),
	"lint-scan": Array.from({ length: 600 }, (_, index) => `src/f${index}.ts:${index}: TODO ${"w".repeat(30)}`).join("\n"),
};

interface ArmNumbers {
	costUsd: number;
	contextTokens: number;
	modelCalls: number;
	retries: number;
	wallMs: number;
	success: boolean;
}

function runRow(sessionId: string, taskId: string, numbers: ArmNumbers): RunTelemetry {
	return {
		task_id: taskId,
		session_id: sessionId,
		route: { complexity: "MEDIUM", executor_class: "balanced", reviewer_class: "none", reasoning: "medium" },
		prd_used: "PRD-019",
		executor_backend: "stub",
		executor_model: "stub-model",
		reviewer_backend: null,
		reviewer_model: null,
		usage: {
			input_tokens: numbers.contextTokens,
			cached_input_tokens: 0,
			output_tokens: 0,
			reasoning_tokens: 0,
			jev_tokens: 0,
			local_gpu_seconds: 0,
			external_harness_calls: 0,
			subscription_usage: 0,
		},
		cost: { api_usd: numbers.costUsd, jev_usd: 0, estimated_quota_cost: 0, effective_cost: numbers.costUsd },
		execution: { wall_ms: numbers.wallMs, tool_calls: 1, file_reads: 0, repeated_reads: 0, retries: numbers.retries, escalations: 0, compactions: 0 },
		result: { verification: "pass", proof_gate: "pass", reviewer: "none", success: numbers.success },
		capabilities: { skills_disclosed: [], skills_used: [], mcps_disclosed: [], mcps_used: [] },
		jev_decisions: [],
		calls: [
			{ timestamp: new Date(0).toISOString(), backend: "stub", backend_type: "native", model: "stub-model", role: "balanced", inputTokens: numbers.contextTokens, outputTokens: 0, costUsd: numbers.costUsd },
			{ timestamp: new Date(0).toISOString(), backend: "stub", backend_type: "native", model: "stub-model", role: "review_quick", inputTokens: 0, outputTokens: 0, costUsd: 0 },
		],
	};
}

/**
 * An executor that runs each fixture task under its arm: OFF keeps the raw text,
 * ON routes it through the real reducer, and each arm's session writes its own
 * PRD-015 rows. Evidence comes from a real PRD-009 store.
 */
async function fixtureExecutor(
	cwd: string,
	numbersFor: (arm: "off" | "on", taskId: string, index: number) => ArmNumbers,
): Promise<{ execute: (task: RtkFixtureTask, arm: "off" | "on", sessionId: string) => Promise<{ evidence: EvidenceRecord[]; rtk_calls: RtkCallRecord[] }>; spawns: () => number }> {
	const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-rtk-ab-"), thresholdBytes: 1 << 20 });
	const counted = countingSpawn();
	const evidenceStore = new EvidenceStore();
	const config = rtkConfig({ ...reducerCommand(REDUCING_REDUCER) });
	const indexOf = new Map(TASKS.map((task, index) => [task.id, index]));

	return {
		spawns: () => counted.count(),
		execute: async (task, arm, sessionId) => {
			const output = OUTPUT_BY_TASK[task.id] ?? "";
			const result = await reduceToolOutput({ output, kind: task.kind, sourceRef: `execute:${task.command}`, exitCode: 0 }, { store: artifacts, config, mode: arm, spawn: counted.spawn });
			const numbers = numbersFor(arm, task.id, indexOf.get(task.id) ?? 0);
			appendRun(cwd, runRow(sessionId, task.id, numbers));
			const evidence = evidenceStore.record(
				{ kind: "test", status: "pass", exitCode: 0, artifactRef: result.artifact?.artifact ?? null, criterion: [task.id], scope: task.command },
				"workspace-hash",
			);
			return { evidence: [evidence], rtk_calls: [result.record] };
		},
	};
}

const OFF_NUMBERS = (): ArmNumbers => ({ costUsd: 0.3, contextTokens: 10_000, modelCalls: 2, retries: 2, wallMs: 1_000, success: true });
// Same spend, one fewer verified success: cost per success is worse, so the verdict is no_benefit.
const ON_NUMBERS = (taskId: string): ArmNumbers => ({ costUsd: 0.3, contextTokens: 7_000, modelCalls: 2, retries: 1, wallMs: 900, success: taskId !== "lint-scan" });

describe("PRD-019 Phase 3 — the §57 A/B measurement", () => {
	it("AC-6: the runner writes both arms with all seven metrics, recomputed from the stores", async () => {
		const cwd = tempDir("leanpi-rtk-ab-cwd-");
		const { execute, spawns } = await fixtureExecutor(cwd, (arm, taskId) => (arm === "off" ? OFF_NUMBERS() : ON_NUMBERS(taskId)));
		const { report, path } = await runRtkAb({ cwd, tasks: TASKS, execute, sessionId: "ab", generatedAt: "2026-09-19T00:00:00.000Z", modelRole: "balanced" });

		expect(path).toBe(join(cwd, RTK_MEASUREMENT_PATH_DEFAULT));
		expect(existsSync(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(report);
		expect(report).toMatchObject({ schema: 1, tasks: 3, model_role: "balanced", fixture_set: "caller-supplied", verdict: "no_benefit" });
		expect(spawns()).toBe(TASKS.length);

		for (const arm of ["off", "on"] as const) {
			const metrics = report.arms[arm];
			expect(Object.keys(metrics).sort()).toEqual(
				["arm", "context_tokens", "cost_per_success", "model_calls", "retries", "shell_output_bytes", "solve_rate", "tasks", "wall_ms"].sort(),
			);
			expect(metrics.tasks).toBe(3);
			expect(metrics.shell_output_bytes).toBeGreaterThan(64 * 1024);
			expect(metrics.context_tokens).toBeGreaterThan(0);
			expect(metrics.model_calls).toBe(6);
			expect(metrics.wall_ms).toBeGreaterThan(0);
			expect(metrics.solve_rate).toBe(1);
			expect(metrics.cost_per_success).toBeGreaterThan(0);
		}
		// The ON arm's shipped context is smaller per task, but §57's decision quantity is cost per success.
		expect(report.arms.on.context_tokens).toBeLessThan(report.arms.off.context_tokens);
		expect(report.arms.on.retries).toBeLessThan(report.arms.off.retries);

		// Cost per success recomputed from PRD-015's store, not read back from the report.
		for (const arm of ["off", "on"] as const) {
			const runs = readRuns(cwd, { sessionId: `ab:${arm}` });
			const total = runs.reduce((sum, run) => sum + run.cost.effective_cost, 0);
			const successes = runs.filter((run) => run.result.success).length;
			expect(report.arms[arm].cost_per_success).toBe(round6(total / successes));
		}
		expect(report.arms.on.cost_per_success).toBeGreaterThan(report.arms.off.cost_per_success);
		// The ON arm's "lint-scan" run reports success: false while its evidence
		// passes, so a solve rate of 1 is only reachable from PRD-009's records.
		expect(readRuns(cwd, { sessionId: "ab:on" }).filter((run) => !run.result.success)).toHaveLength(1);
		expect(report.arms.on.solve_rate).toBe(1);

		// Deleting the report and re-running regenerates it rather than passing the stale copy.
		rmSync(path);
		const again = await runRtkAb({ cwd, tasks: TASKS, execute, sessionId: "ab-2", generatedAt: "2026-09-19T01:00:00.000Z" });
		expect(existsSync(path)).toBe(true);
		expect(readRtkMeasurement(path)!.generated_at).toBe("2026-09-19T01:00:00.000Z");
		expect(again.report.arms.off.context_tokens).toBe(report.arms.off.context_tokens);
	});

	it("AC-6: solve rate comes from evidence records, never from the executor's own success flag", () => {
		const evidence: EvidenceRecord[] = [
			{ kind: "test", status: "pass", workspaceHash: "h", startedAt: new Date(0).toISOString(), exitCode: 0, artifactRef: null, criterion: ["a"], scope: "pnpm test" },
			{ kind: "test", status: "fail", workspaceHash: "h", startedAt: new Date(0).toISOString(), exitCode: 1, artifactRef: null, criterion: ["b"], scope: "pnpm test" },
		];
		expect(solveRateOf(["a", "b"], evidence)).toBe(0.5);
		expect(solveRateOf(["a"], evidence)).toBe(1);
		// An executor that claims success without a record is not solved.
		expect(solveRateOf(["c"], evidence)).toBe(0);
	});

	it("AC-6: the fixture set is this repository's, from bench/fixtures/shell-heavy.json when present", async () => {
		const cwd = tempDir("leanpi-rtk-fixtures-");
		expect(loadShellHeavyFixtures(cwd)).toEqual({ fixture_set: "src/rtk/ab.ts (bundled shell-heavy set)", tasks: SHELL_HEAVY_FIXTURES });
		expect(SHELL_HEAVY_FIXTURES.map((task) => task.command)).toContain("pnpm");

		writeFileSync(join(cwd, "shell-heavy.json"), JSON.stringify([{ id: "only", kind: "test", command: "true" }]));
		expect(loadShellHeavyFixtures(cwd, "shell-heavy.json")).toEqual({ fixture_set: "shell-heavy.json", tasks: [{ id: "only", kind: "test", command: "true" }] });
	});
});

describe("PRD-019 Phase 3 — the measurement-derived default", () => {
	it("AC-7: the default follows the recorded verdict in both directions, and a missing report resolves to auto", async () => {
		const cwd = tempDir("leanpi-rtk-default-");
		const { execute } = await fixtureExecutor(cwd, (arm, taskId) => (arm === "off" ? OFF_NUMBERS() : ON_NUMBERS(taskId)));
		const { report, path } = await runRtkAb({ cwd, tasks: TASKS, execute, sessionId: "ab" });

		expect(report.verdict).toBe("no_benefit");
		expect(resolveRtkDefault(report)).toBe("auto");
		expect(rtkModeOf(undefined, { reportPath: path })).toBe("auto");

		const improving: RtkMeasurement = { ...report, arms: { ...report.arms, on: { ...report.arms.on, cost_per_success: 0.2 } }, verdict: verdictFromArms(report.arms.off, { ...report.arms.on, cost_per_success: 0.2 }) };
		expect(improving.verdict).toBe("improved");
		expect(resolveRtkDefault(improving)).toBe("on");
		expect(rtkModeOf(undefined, { reportPath: path })).toBe("auto");

		// An unwritten report, a garbage report and a missing path are all "no measurement yet".
		const improvingPath = join(cwd, "improving.json");
		writeFileSync(improvingPath, JSON.stringify(improving));
		expect(rtkModeOf(undefined, { reportPath: improvingPath })).toBe("on");
		const garbage = join(cwd, "garbage.json");
		writeFileSync(garbage, "{not json");
		expect(readRtkMeasurement(garbage)).toBeNull();
		expect(rtkModeOf(undefined, { reportPath: garbage })).toBe("auto");
		expect(rtkModeOf(undefined, { reportPath: join(cwd, "absent.json") })).toBe("auto");
		expect(rtkModeOf(undefined, { cwd })).toBe("auto");

		// An explicit setting is a user override, not a second default.
		expect(rtkModeOf(rtkConfig({ mode: "off" }), { reportPath: improvingPath })).toBe("off");
		expect(rtkModeOf(rtkConfig({}), { reportPath: improvingPath })).toBe("on");

		// The two-direction negative control: one value cannot satisfy both branches.
		const worse: RtkArmMetrics = { ...report.arms.on, cost_per_success: 0.9 };
		expect(verdictFromArms(report.arms.off, worse)).toBe("no_benefit");
		expect(resolveRtkDefault({ ...report, verdict: "improved" })).toBe("on");
	});

	it("AC-7: under a no-benefit default, below-threshold output spawns no reducer while above-threshold does", async () => {
		const cwd = tempDir("leanpi-rtk-auto-");
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-rtk-auto-store-"), thresholdBytes: 1 << 20 });
		const counted = countingSpawn();
		const config = rtkConfig({ ...reducerCommand(REDUCING_REDUCER) });
		const mode = rtkModeOf(undefined, { cwd });
		expect(mode).toBe("auto");

		const small = await reduceToolOutput({ output: "ok\n".repeat(200), kind: "test", sourceRef: "execute:true" }, { store: artifacts, config, mode, spawn: counted.spawn });
		expect(counted.count()).toBe(0);
		expect(small.text).toBe("ok\n".repeat(200));

		const big = OUTPUT_BY_TASK["typecheck"]!;
		const large = await reduceToolOutput({ output: big, kind: "build", sourceRef: "execute:pnpm tsc" }, { store: artifacts, config, mode, spawn: counted.spawn });
		expect(counted.count()).toBe(1);
		expect(large.text).not.toBe(big);
		const expanded = artifacts.expand(large.artifact!.artifact!);
		expect(expanded.byteLength).toBe(Buffer.byteLength(big, "utf8"));
		expect(expanded.toString("utf8")).toBe(big);
	});

	it("AC-7: rtkModeOf reads the same committed path the runner writes, env override included", () => {
		const cwd = tempDir("leanpi-rtk-path-");
		expect(rtkMeasurementPath(cwd)).toBe(join(cwd, RTK_MEASUREMENT_PATH_DEFAULT));
		expect(rtkMeasurementPath(cwd, "custom.json")).toBe(join(cwd, "custom.json"));
		expect(rtkMeasurementPath(cwd, undefined, { LEANPI_RTK_MEASUREMENT: "/tmp/measured.json" })).toBe("/tmp/measured.json");
		expect(rtkMeasurementPath(cwd, "custom.json", { LEANPI_RTK_MEASUREMENT: "/tmp/measured.json" })).toBe(join(cwd, "custom.json"));
	});
});
