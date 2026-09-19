/**
 * The §57 A/B runner and its fixture set (PRD-019 Phase 3, AC-6).
 *
 * Each fixture task runs twice — OFF then ON, identical task and model role — and
 * the report's seven metrics are collected, never self-reported: solve rate comes
 * from PRD-009 `EvidenceRecord`s the arm's session recorded, and every cost figure
 * comes from PRD-015's run store through `readRuns()`. The runner always writes
 * the report it just measured; nothing reads a stale copy.
 *
 * The execution seam is PRD-021's entry point: a suite-wide run over the full
 * 50–100 task benchmark substitutes a real session for `execute` and imports
 * `verdictFromArms()` rather than restating the rule. The default fixture set is
 * this repository's own shell-heavy build/test/grep commands, and
 * `bench/fixtures/shell-heavy.json` overrides it when present.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LeanPiConfig } from "../core/types.js";
import { round6, resolveCostConfig, type CostConfig } from "../telemetry/pricing.js";
import { readRuns } from "../telemetry/store.js";
import type { RunTelemetry } from "../telemetry/record.js";
import type { EvidenceRecord } from "../verify/evidence.js";
import type { RtkCallRecord } from "./reducer.js";
import type { RtkArmMetrics, RtkMeasurement } from "./measurement.js";
import { rtkMeasurementPath, verdictFromArms, writeRtkMeasurement } from "./measurement.js";
import type { RtkArm } from "./policy.js";

export interface RtkFixtureTask {
	id: string;
	/** Tool kind the fixture's command classifies as (`test`, `build`, …). */
	kind: string;
	command: string;
	args?: string[];
}

/** This repository's own shell-heavy commands: the property §57 measures, on a real workload. */
export const SHELL_HEAVY_FIXTURES: RtkFixtureTask[] = [
	{ id: "typecheck", kind: "build", command: "pnpm", args: ["tsc", "--noEmit"] },
	{ id: "unit-tests", kind: "test", command: "pnpm", args: ["vitest", "run"] },
	{ id: "todo-scan", kind: "grep", command: "grep", args: ["-rn", "TODO", "src"] },
	{ id: "dependency-audit", kind: "shell", command: "pnpm", args: ["outdated"] },
];

export const SHELL_HEAVY_FIXTURE_PATH = "bench/fixtures/shell-heavy.json";

function isFixtureTask(value: unknown): value is RtkFixtureTask {
	const task = value as Partial<RtkFixtureTask> | null;
	return (
		task !== null &&
		typeof task === "object" &&
		typeof task.id === "string" &&
		typeof task.kind === "string" &&
		typeof task.command === "string" &&
		(task.args === undefined || (Array.isArray(task.args) && task.args.every((arg) => typeof arg === "string")))
	);
}

/** The declared fixture set when it exists, the bundled one otherwise — never an empty run. */
export function loadShellHeavyFixtures(cwd: string, fixturePath?: string): { fixture_set: string; tasks: RtkFixtureTask[] } {
	const relative = fixturePath ?? SHELL_HEAVY_FIXTURE_PATH;
	const path = join(cwd, relative);
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
			const tasks = (Array.isArray(parsed) ? parsed : (parsed as { tasks?: unknown })?.tasks) ?? [];
			if (Array.isArray(tasks) && tasks.every(isFixtureTask) && tasks.length > 0) return { fixture_set: relative, tasks };
		} catch {
			// A malformed fixture file falls back to the bundled set rather than aborting a measurement.
		}
	}
	return { fixture_set: "src/rtk/ab.ts (bundled shell-heavy set)", tasks: SHELL_HEAVY_FIXTURES };
}

/** What one arm's run of one fixture task produced: evidence records and the reducer's records. */
export interface RtkTaskRun {
	/** PRD-009 records only; an executor's own claim is not evidence. */
	evidence: EvidenceRecord[];
	/** `reduceToolOutput()` records for the task's tool calls; `bytes_in` is §57's shell-output size. */
	rtk_calls: RtkCallRecord[];
}

export type RtkTaskExecutor = (task: RtkFixtureTask, arm: RtkArm, sessionId: string) => Promise<RtkTaskRun> | RtkTaskRun;

export interface RtkAbOptions {
	cwd: string;
	/** Execute one fixture task under one arm. The arm's session writes telemetry under `sessionId`. */
	execute: RtkTaskExecutor;
	tasks?: RtkFixtureTask[];
	fixturePath?: string;
	/** Base session id; each arm gets `${sessionId}:${arm}`, which is how the store separates them. */
	sessionId?: string;
	reportPath?: string;
	generatedAt?: string;
	modelRole?: string | null;
	config?: LeanPiConfig | null;
}

export interface RtkAbResult {
	report: RtkMeasurement;
	path: string;
}

/** A task is solved when PRD-009 recorded a result for it and no recorded result failed. */
export function solveRateOf(taskIds: string[], evidence: EvidenceRecord[]): number {
	if (taskIds.length === 0) return 0;
	const solved = taskIds.filter((id) => {
		const rows = evidence.filter((record) => record.criterion.includes(id));
		return rows.length > 0 && rows.every((record) => record.status === "pass");
	});
	return solved.length / taskIds.length;
}

/**
 * The seven §57 metrics for one arm. Solve rate and cost come from stored records;
 * an arm with no successful run reports cost per success 0, and `verdictFromArms()`
 * refuses to call a zero-solve-rate arm an improvement.
 */
export function aggregateArmMetrics(
	arm: RtkArm,
	runs: RunTelemetry[],
	evidence: EvidenceRecord[],
	taskIds: string[],
	shellOutputBytes: number,
): RtkArmMetrics {
	let contextTokens = 0;
	let modelCalls = 0;
	let retries = 0;
	let wallMs = 0;
	let totalCost = 0;
	let successes = 0;
	for (const run of runs) {
		contextTokens += run.usage.input_tokens + run.usage.cached_input_tokens + run.usage.output_tokens + run.usage.reasoning_tokens;
		modelCalls += run.calls.length;
		retries += run.execution.retries;
		wallMs += run.execution.wall_ms;
		totalCost += run.cost.effective_cost;
		if (run.result.success) successes += 1;
	}
	return {
		arm,
		tasks: taskIds.length,
		shell_output_bytes: shellOutputBytes,
		context_tokens: contextTokens,
		model_calls: modelCalls,
		retries,
		solve_rate: solveRateOf(taskIds, evidence),
		wall_ms: wallMs,
		cost_per_success: round6(successes > 0 ? totalCost / successes : 0),
	};
}

export async function runRtkAb(options: RtkAbOptions): Promise<RtkAbResult> {
	const loaded = options.tasks === undefined
		? loadShellHeavyFixtures(options.cwd, options.fixturePath)
		: { fixture_set: "caller-supplied", tasks: options.tasks };
	const taskIds = loaded.tasks.map((task) => task.id);
	const baseSession = options.sessionId ?? `rtk-ab-${options.generatedAt ?? new Date().toISOString()}`;
	const cost: CostConfig | undefined = resolveCostConfig(options.config);

	const measured: Partial<Record<RtkArm, RtkArmMetrics>> = {};
	for (const arm of ["off", "on"] as const) {
		const sessionId = `${baseSession}:${arm}`;
		const evidence: EvidenceRecord[] = [];
		const calls: RtkCallRecord[] = [];
		for (const task of loaded.tasks) {
			const run = await options.execute(task, arm, sessionId);
			evidence.push(...run.evidence);
			calls.push(...run.rtk_calls);
		}
		const shellOutputBytes = calls.reduce((total, call) => total + call.bytes_in, 0);
		measured[arm] = aggregateArmMetrics(arm, readRuns(options.cwd, { sessionId }, cost), evidence, taskIds, shellOutputBytes);
	}

	const off = measured.off!;
	const on = measured.on!;
	const report: RtkMeasurement = {
		schema: 1,
		generated_at: options.generatedAt ?? new Date().toISOString(),
		fixture_set: loaded.fixture_set,
		model_role: options.modelRole ?? null,
		tasks: loaded.tasks.length,
		arms: { off, on },
		verdict: verdictFromArms(off, on),
	};
	return { report, path: writeRtkMeasurement(report, rtkMeasurementPath(options.cwd, options.reportPath)) };
}
