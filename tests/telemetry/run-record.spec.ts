/**
 * E1 (PRD-015 Phase 1): a completed run leaves one priced, persisted record.
 *
 * Covers AC-1, AC-2, AC-3, AC-4 and AC-6: the fixture drives the session's turn
 * entry point (never `emitRunTelemetry` directly), the assertions read
 * `.leanpi/telemetry.jsonl` back from disk, and the money values are the AC's
 * hand computation.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aggregateTelemetry } from "../../src/telemetry/aggregate.js";
import { billedRefs, createRunCollector, feedInvocation } from "../../src/telemetry/collect.js";
import { emitRunTelemetry } from "../../src/telemetry/emit.js";
import { resolveCostConfig } from "../../src/telemetry/pricing.js";
import type { RunTelemetry } from "../../src/telemetry/record.js";
import { appendRun, readRuns, telemetryPath } from "../../src/telemetry/store.js";
import { startStubJev, typedAnswers, type StubJev, type StubJevResponder } from "../helpers/stub-jev.js";
import { fixtureConfig, fixtureCwd, registerFixtureSites, runFixtureTask } from "./fixture.js";

/** The stub answers the first two sites (400 + 600 JEV tokens) and refuses the third. */
const responder: StubJevResponder = (body) => {
	const ids = Object.keys((body.questions ?? {}) as Record<string, unknown>);
	if (ids.includes("risk")) return { status: 500 };
	if (ids.includes("complexity")) return { answers: typedAnswers(body), usage: { input_tokens: 580, output_tokens: 20 } };
	return { answers: typedAnswers(body), usage: { input_tokens: 390, output_tokens: 10 } };
};

/** Every key AC-1 enumerates; a missing or `undefined` field fails. */
const REQUIRED_PATHS = [
	"task_id",
	"session_id",
	"route.complexity",
	"route.executor_class",
	"route.reviewer_class",
	"route.reasoning",
	"prd_used",
	"executor_backend",
	"executor_model",
	"reviewer_backend",
	"reviewer_model",
	"usage.input_tokens",
	"usage.cached_input_tokens",
	"usage.output_tokens",
	"usage.reasoning_tokens",
	"usage.jev_tokens",
	"usage.local_gpu_seconds",
	"usage.external_harness_calls",
	"usage.subscription_usage",
	"cost.api_usd",
	"cost.jev_usd",
	"cost.estimated_quota_cost",
	"cost.effective_cost",
	"execution.wall_ms",
	"execution.tool_calls",
	"execution.file_reads",
	"execution.repeated_reads",
	"execution.retries",
	"execution.escalations",
	"execution.compactions",
	"result.verification",
	"result.proof_gate",
	"result.reviewer",
	"result.success",
	"capabilities.skills_disclosed",
	"capabilities.skills_used",
	"capabilities.mcps_disclosed",
	"capabilities.mcps_used",
	"jev_decisions",
	"calls",
];

function valueAt(record: RunTelemetry, path: string): unknown {
	return path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], record);
}

function storedLines(cwd: string): RunTelemetry[] {
	const text = readFileSync(telemetryPath(cwd), "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as RunTelemetry);
}

describe("run telemetry record (PRD-015)", () => {
	let stub: StubJev;

	beforeAll(async () => {
		stub = await startStubJev([responder]);
	});

	afterAll(async () => {
		await stub.close();
	});

	it("writes one complete, priced record for a fixture run (AC-1, AC-2, AC-6)", async () => {
		const cwd = fixtureCwd();
		registerFixtureSites();
		const config = fixtureConfig(cwd, { jevUrl: stub.url });
		const { collector, context, decisions } = await runFixtureTask({
			cwd,
			taskId: "fixture-task-1",
			sessionId: "session-1",
			success: true,
			config,
		});

		// AC-1: exactly one line, and every enumerated key is present.
		const lines = storedLines(cwd);
		expect(lines).toHaveLength(1);
		const record = lines[0] as RunTelemetry;
		for (const path of REQUIRED_PATHS) {
			expect(valueAt(record, path), `${path} must be present`).not.toBeUndefined();
		}
		expect(record.task_id).toBe("fixture-task-1");
		expect(record.session_id).toBe("session-1");
		expect(record.prd_used).toBe("docs/PRDs/v1/PRD-015-cost-telemetry.md");
		expect(["LOW", "MEDIUM", "HIGH"]).toContain(record.route.complexity);
		expect(record.route.executor_class).toBe("balanced");
		expect(record.executor_backend).toBe("api");
		expect(record.executor_model).toBe("claude-sonnet-4");
		expect(record.reviewer_backend).toBe("codex");
		expect(record.reviewer_model).toBe("gpt-5-codex");
		expect(record.usage).toEqual({
			input_tokens: 10_000,
			cached_input_tokens: 20_000,
			output_tokens: 2_000,
			reasoning_tokens: 0,
			jev_tokens: 1_000,
			local_gpu_seconds: 10,
			external_harness_calls: 1,
			subscription_usage: 1,
		});
		expect(record.execution).toEqual({
			wall_ms: 1200,
			tool_calls: 4,
			file_reads: 3,
			repeated_reads: 1,
			retries: 1,
			escalations: 0,
			compactions: 1,
		});
		expect(record.result).toEqual({ verification: "pass", proof_gate: "pass", reviewer: "pass", success: true });
		expect(record.capabilities).toEqual({
			skills_disclosed: ["ponytail"],
			skills_used: ["ponytail"],
			mcps_disclosed: ["mcp-fixture"],
			mcps_used: ["mcp-fixture"],
		});

		// AC-2: the hand computation of the fixture's fixed usage.
		//   input 10,000 @ $3/Mtok = 0.03 | cached 20,000 @ $0.30/Mtok = 0.006
		//   output 2,000 @ $15/Mtok = 0.03 | jev 1,000 @ $0.20/Mtok = 0.0002
		//   one scarce-premium call @ $0.05 | 10 gpu-seconds @ $0.001/s = 0.01 | latency rate 0
		expect(record.cost).toEqual({ api_usd: 0.066, jev_usd: 0.0002, estimated_quota_cost: 0.05, effective_cost: 0.1262 });

		// The per-call rows PRD-016 filters on: type, model, tokens, class and run id.
		expect(record.calls).toHaveLength(2);
		expect(record.calls[0]).toMatchObject({
			backend: "api",
			backend_type: "native",
			model: "claude-sonnet-4",
			role: "balanced",
			inputTokens: 10_000,
			outputTokens: 2_000,
			costUsd: 0.066,
			quotaClass: "scarce-premium",
			runId: "fixture-task-1",
			billing: "metered",
		});
		// The subscription-pool call is not metered: FR-055's separation, per row.
		expect(record.calls[1]).toMatchObject({ backend: "codex", backend_type: "external_harness", costUsd: 0, billing: "subscription" });

		// AC-6: two sites answered, one fell back; Σ row tokens == usage.jev_tokens.
		expect(record.jev_decisions.map((row) => row.site_id)).toEqual(["fixture.planning", "fixture.complexity", "fixture.review_risk"]);
		for (const row of record.jev_decisions) {
			for (const value of [row.site_id, row.answer, row.confidence, row.fallback_used, row.tokens]) {
				expect(value).not.toBeUndefined();
			}
		}
		expect(record.jev_decisions.map((row) => row.fallback_used)).toEqual([false, false, true]);
		expect(record.jev_decisions.reduce((sum, row) => sum + row.tokens, 0)).toBe(record.usage.jev_tokens);
		expect(record.jev_decisions.map((row) => row.tokens)).toEqual([400, 600, 0]);
		// The projection is PRD-002's log, row for row, not a second store.
		expect(decisions.map((row) => row.siteId)).toEqual(record.jev_decisions.map((row) => row.site_id));
		expect(decisions.map((row) => row.fallbackUsed)).toEqual([false, false, true]);

		// Emission is idempotent per run: re-entering the emitter cannot double-count.
		const reemitted = emitRunTelemetry(
			collector,
			context.contract as NonNullable<typeof context.contract>,
			{ verification: "pass", proof_gate: "pass", reviewer: "pass", success: true },
			{ cwd, cost: resolveCostConfig(config) },
		);
		expect(reemitted).toBeUndefined();
		expect(storedLines(cwd)).toHaveLength(1);
	});

	it("prices the quota shadow field as a pass-through input (AC-3)", async () => {
		const cwd = fixtureCwd();
		registerFixtureSites();
		await runFixtureTask({
			cwd,
			taskId: "fixture-task-shadow-0",
			sessionId: "session-2",
			success: true,
			config: fixtureConfig(cwd, { jevUrl: stub.url, shadowUsd: 0 }),
		});

		const [record] = storedLines(cwd);
		expect(record?.cost.estimated_quota_cost).toBe(0);
		expect(record?.cost.effective_cost).toBe(0.0762);
		expect((record?.cost.effective_cost ?? 0) - 0.1262).toBeCloseTo(-0.05, 10);
	});

	it("persists runs a fresh process can query by task_id (AC-4)", async () => {
		const cwd = fixtureCwd();
		registerFixtureSites();
		const config = fixtureConfig(cwd, { jevUrl: stub.url });
		await runFixtureTask({ cwd, taskId: "fixture-task-1", sessionId: "session-1", success: true, config });
		await runFixtureTask({ cwd, taskId: "fixture-task-2", sessionId: "session-1", success: false, config });

		expect(storedLines(cwd)).toHaveLength(2);
		const inProcess = readRuns(cwd, { taskId: "fixture-task-1" });
		expect(inProcess).toHaveLength(1);
		expect(inProcess[0]?.cost.effective_cost).toBe(0.1262);

		// A new Node process, a new store handle: the record is on disk, not in memory.
		const childReader = [
			"const fs = require('fs');",
			"const rows = fs.readFileSync(process.argv[1], 'utf8').split('\\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));",
			"const hit = rows.filter((row) => row.task_id === process.argv[2]);",
			"process.stdout.write(JSON.stringify(hit.map((row) => [row.task_id, row.session_id, row.cost.effective_cost])));",
		].join(" ");
		const output = execFileSync(process.execPath, ["-e", childReader, telemetryPath(cwd), "fixture-task-1"], { encoding: "utf8" });
		expect(JSON.parse(output)).toEqual([["fixture-task-1", "session-1", 0.1262]]);

		// PRD-016's filter: the session sees both runs, a task filter sees one.
		expect(readRuns(cwd, { sessionId: "session-1" })).toHaveLength(2);
		expect(readRuns(cwd, { sessionId: "session-2" })).toHaveLength(0);
	});

	it("still emits a complete record, all rows on fallback, when JEV is disabled (AC-6)", async () => {
		const cwd = fixtureCwd();
		registerFixtureSites();
		const requestsBefore = stub.requests.length;
		await runFixtureTask({
			cwd,
			taskId: "fixture-task-nojev",
			sessionId: "session-3",
			success: false,
			config: fixtureConfig(cwd, { jevUrl: stub.url, jevMode: "disabled" }),
		});

		const [record] = storedLines(cwd);
		expect(stub.requests.length).toBe(requestsBefore);
		expect(record?.usage.jev_tokens).toBe(0);
		expect(record?.cost.jev_usd).toBe(0);
		expect(record?.cost.effective_cost).toBe(0.126);
		expect(record?.result.success).toBe(false);
		expect(record?.jev_decisions.map((row) => row.fallback_used)).toEqual([true, true, true]);
		expect(record?.jev_decisions.reduce((sum, row) => sum + row.tokens, 0)).toBe(record?.usage.jev_tokens);
		expect(record?.calls).toHaveLength(2);
		for (const path of REQUIRED_PATHS) {
			expect(valueAt(record as RunTelemetry, path), `${path} must be present`).not.toBeUndefined();
		}
	});

	it("degrades to zero totals instead of throwing on a missing or partial store", () => {
		const cwd = fixtureCwd();
		const empty = aggregateTelemetry(cwd);
		expect(empty).toMatchObject({ runs: 0, effectiveCostUsd: 0, verifiedSuccesses: 0, costPerVerifiedSuccess: null, apiUsd: 0, jevUsd: 0, quotaUsd: 0 });
		expect(empty.jev).toMatchObject({ decisions: 0, fallbacks: 0, fallbackRate: 0, tokens: 0 });
		expect(readRuns(cwd)).toEqual([]);

		// A crash mid-write leaves a truncated final line; the rows that parse survive,
		// and the next append closes the fragment off instead of gluing onto it.
		mkdirSync(join(cwd, ".leanpi"), { recursive: true });
		writeFileSync(telemetryPath(cwd), '{"task_id":"partial","session_');
		expect(aggregateTelemetry(cwd).runs).toBe(0);
		appendRun(cwd, { task_id: "complete", session_id: "s", usage: {}, cost: { effective_cost: 0.5 } } as RunTelemetry);
		expect(readRuns(cwd).map((run) => run.task_id)).toEqual(["complete"]);
		expect(aggregateTelemetry(cwd)).toMatchObject({ runs: 1, effectiveCostUsd: 0.5 });
	});

	it("bills a backend invocation into the run's calls, usage and wall time", () => {
		// The projection production runs depend on: a compiled run's executor calls
		// PRD-008's sink and the record must carry them, or `/cost` reads zero.
		const collector = createRunCollector({ taskId: "accounting", sessionId: "s-1" });
		feedInvocation(collector, {
			backend: "claude",
			model: "claude-model",
			billing: "subscription",
			role: "balanced",
			wallMs: 1_200,
			exitCode: 0,
			usage: { inputTokens: 100, cachedInputTokens: 900, outputTokens: 93, reasoningTokens: 40 },
		});
		feedInvocation(collector, { backend: "local", billing: "local", role: "balanced", wallMs: 300, exitCode: 0, tokens: 50 });

		expect(collector.calls()).toHaveLength(2);
		expect(collector.usage()).toMatchObject({ input_tokens: 150, cached_input_tokens: 900, output_tokens: 93, reasoning_tokens: 40 });
		expect(collector.execution().wall_ms).toBe(1_500);
		// The call's own identity decides the record's type and billing, not a restatement.
		expect(collector.calls()[0]).toMatchObject({ type: "external_harness", billing: "subscription" });
		expect(collector.calls()[1]).toMatchObject({ type: "native", billing: "local" });
		// The billed executor is the last executor-role call, read off the calls.
		expect(billedRefs(collector.calls()).executor?.model).toBe("local");
	});
});