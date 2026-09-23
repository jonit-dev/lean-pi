/**
 * PRD-050 F3 — the bench runner must join §52 records without re-reading the
 * whole telemetry store per attempt.
 *
 * One incremental pass over the store's new bytes per join keeps the run
 * O(total bytes); a full `readRuns` per attempt is O(attempts × store).
 * The stale pre-append below proves the index stays exact: the fresh record
 * wins the join, never a cached earlier row.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PACKAGE_ROOT } from "../../src/index.js";
import { runBench } from "../../src/bench/runner.js";
import type { RunTelemetry } from "../../src/telemetry/index.js";
import {
	appendRecords,
	fixtureConfig,
	fixtureConfigRow,
	fixtureSuite,
	preparedWorkspaces,
	stubExecutor,
	tempDir,
} from "./helpers.js";

const readRunsCalls: Array<string | undefined> = [];
vi.mock("../../src/telemetry/store.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../src/telemetry/store.js")>();
	return {
		...mod,
		readRuns: (...args: Parameters<typeof mod.readRuns>) => {
			readRunsCalls.push(args[1]?.taskId);
			return mod.readRuns(...args);
		},
	};
});

/** `0` reads in full; a positive cap forces the short-read path `readSync` is allowed to take. */
const fsRead = vi.hoisted(() => ({ cap: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const mod = await importOriginal<typeof import("node:fs")>();
	return {
		...mod,
		readSync: ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) =>
			mod.readSync(fd, buffer, offset, fsRead.cap > 0 ? Math.min(length, fsRead.cap) : length, position)) as typeof mod.readSync,
	};
});

/** A stale §52 row for an attempt that has not run yet: the join must prefer the fresh record. */
function staleRecord(taskId: string, sessionId: string): RunTelemetry {
	return {
		task_id: taskId,
		session_id: sessionId,
		route: { complexity: "MEDIUM", executor_class: "balanced", reviewer_class: "review_quick", reasoning: "medium" },
		prd_used: null,
		executor_backend: "local",
		executor_model: "qwen3-coder-480b-a35b",
		reviewer_backend: "local",
		reviewer_model: "gemini-2.5-flash",
		usage: { input_tokens: 10_000, cached_input_tokens: 0, output_tokens: 1_000, reasoning_tokens: 0, jev_tokens: 0, local_gpu_seconds: 0, external_harness_calls: 0, subscription_usage: 0 },
		cost: { api_usd: 999, jev_usd: 0, estimated_quota_cost: 0, effective_cost: 999 },
		execution: { wall_ms: 1000, tool_calls: 3, file_reads: 2, repeated_reads: 0, retries: 0, escalations: 0, compactions: 0 },
		result: { verification: "pass", proof_gate: "PASS", reviewer: "PASS", success: true },
		capabilities: { skills_disclosed: [], skills_used: [], mcps_disclosed: [], mcps_used: [] },
		jev_decisions: [],
		calls: [],
	};
}

describe("PRD-050 F3 — one incremental pass over the telemetry store", () => {
	it("joins every attempt with no per-attempt store re-read, and the fresh record wins over a stale row", async () => {
		readRunsCalls.length = 0;
		const root = tempDir();
		const suiteDir = fixtureSuite(root);
		const configDir = fixtureConfigRow(root, { id: "fixture-row" });
		// A stale row for the first attempt, written before the run starts.
		appendRecords(join(root, "out", "join-once", "telemetry.jsonl"), [staleRecord("golden-passes@fixture-row", "stale-session")]);

		const run = await runBench({
			cwd: PACKAGE_ROOT,
			config: fixtureConfig(root),
			suiteDir,
			configDir,
			configIds: ["fixture-row"],
			runId: "join-once",
			outDir: join(root, "out"),
			prepare: preparedWorkspaces(root).prepare,
			execute: stubExecutor({ completes: () => true, cost: () => 0.01, reported_success: () => true }),
			now: () => new Date("2026-09-19T00:00:00.000Z"),
		});

		expect(run.ledger).toHaveLength(3);
		// Three fresh rows plus the stale pre-append all land in the store.
		expect(run.report.telemetry_rows).toBe(4);
		// The join read the fresh 0.01 rows, not the stale 999: exactness preserved.
		expect(run.report.configs[0]?.effective_cost_total).toBeCloseTo(0.03, 6);
		// No whole-store re-read per attempt: the runner drains only new bytes.
		expect(readRunsCalls).toEqual([]);
	});

	it("drains every appended byte when readSync returns short reads", async () => {
		readRunsCalls.length = 0;
		fsRead.cap = 8;
		try {
			const root = tempDir();
			const suiteDir = fixtureSuite(root);
			const configDir = fixtureConfigRow(root, { id: "fixture-row" });

			const run = await runBench({
				cwd: PACKAGE_ROOT,
				config: fixtureConfig(root),
				suiteDir,
				configDir,
				configIds: ["fixture-row"],
				runId: "join-short-reads",
				outDir: join(root, "out"),
				prepare: preparedWorkspaces(root).prepare,
				execute: stubExecutor({ completes: () => true, cost: () => 0.01, reported_success: () => true }),
				now: () => new Date("2026-09-19T00:00:00.000Z"),
			});

			// Each record is far longer than the 8-byte cap: a single short read
			// would strand the rest of the store and lose the joins.
			expect(run.ledger).toHaveLength(3);
			expect(run.report.telemetry_rows).toBe(3);
			expect(run.report.configs[0]?.effective_cost_total).toBeCloseTo(0.03, 6);
		} finally {
			fsRead.cap = 0;
		}
	});

	it("joins a valid final record written without a trailing newline", async () => {
		readRunsCalls.length = 0;
		const root = tempDir();
		const suiteDir = fixtureSuite(root);
		const configDir = fixtureConfigRow(root, { id: "fixture-row" });

		const run = await runBench({
			cwd: PACKAGE_ROOT,
			config: fixtureConfig(root),
			suiteDir,
			configDir,
			configIds: ["fixture-row"],
			runId: "join-unterminated",
			outDir: join(root, "out"),
			prepare: preparedWorkspaces(root).prepare,
			// The last record is valid JSON without a line terminator; earlier rows
			// keep the JSONL separators so only the final-line behavior is exercised.
			execute: async (attempt) => {
				mkdirSync(dirname(attempt.telemetry_path), { recursive: true });
				const line = JSON.stringify(staleRecord(attempt.telemetry_task_id, attempt.session_id));
				appendFileSync(attempt.telemetry_path, attempt.task.id === "rubric-task" ? line : `${line}\n`);
				return { extensions: [], operator: "scripted", subscription_usage: 0, note: null };
			},
			now: () => new Date("2026-09-19T00:00:00.000Z"),
		});

		expect(run.ledger).toHaveLength(3);
		expect(run.report.telemetry_rows).toBe(3);
	});
});
