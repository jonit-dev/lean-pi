/**
 * E2 (PRD-015 Phase 2): `/cost` answers "what did this session cost per verified
 * success".
 *
 * Covers AC-5 by dispatching the real slash command through the command registry
 * (PRD-016's), over a session with two runs — one that passed the proof gate and
 * one that failed. The failed run must not enter the denominator, which is what
 * distinguishes the printed figure from the wrong one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { commandRegistry } from "../../src/commands/registry.js";
import { readDecisions } from "../../src/jev/log.js";
import { aggregateTelemetry } from "../../src/telemetry/aggregate.js";
import { registerCostCommand } from "../../src/telemetry/cost.js";
import { telemetryPath } from "../../src/telemetry/store.js";
import { startStubJev, typedAnswers, type StubJev, type StubJevResponder } from "../helpers/stub-jev.js";
import { fixtureConfig, fixtureCwd, registerFixtureSites, runFixtureTask } from "./fixture.js";

const responder: StubJevResponder = (body) => {
	const ids = Object.keys((body.questions ?? {}) as Record<string, unknown>);
	if (ids.includes("risk")) return { status: 500 };
	if (ids.includes("complexity")) return { answers: typedAnswers(body), usage: { input_tokens: 580, output_tokens: 20 } };
	return { answers: typedAnswers(body), usage: { input_tokens: 390, output_tokens: 10 } };
};

describe("/cost (PRD-015)", () => {
	let stub: StubJev;

	beforeAll(async () => {
		stub = await startStubJev([responder]);
	});

	afterAll(async () => {
		await stub.close();
	});

	afterEach(() => {
		if (commandRegistry.has("cost")) commandRegistry.unregister("cost");
	});

	it("reports both task rows, the session total and cost per verified success (AC-5)", async () => {
		const cwd = fixtureCwd();
		registerFixtureSites();
		const config = fixtureConfig(cwd, { jevUrl: stub.url });
		await runFixtureTask({ cwd, taskId: "cost-task-1", sessionId: "session-cost", success: true, config });
		await runFixtureTask({ cwd, taskId: "cost-task-2", sessionId: "session-cost", success: false, config });

		registerCostCommand(commandRegistry, { cwd, sessionId: "session-cost" });
		expect(commandRegistry.has("cost")).toBe(true);

		const report = await commandRegistry.dispatch("/cost", { cwd });
		expect(report.ok).toBe(true);
		// Both rows, in run order.
		expect(report.text.indexOf("cost-task-1")).toBeLessThan(report.text.indexOf("cost-task-2"));
		// Total is the sum of the two stored `effective_cost` values, and only the
		// successful run divides it: the failed one would have made it $0.126200.
		const total = 0.1262 + 0.1262;
		expect(report.text).toContain("runs: 2");
		expect(report.text).toContain("session total: $0.252400");
		expect(report.text).toContain("verified successes: 1");
		expect(report.text).toContain("effective cost per verified success: $0.252400");
		const aggregate = aggregateTelemetry(cwd, { sessionId: "session-cost" });
		expect(aggregate.costPerVerifiedSuccess).toBe(total);
		expect(aggregate.verifiedSuccesses).toBe(1);

		const detail = await commandRegistry.dispatch("/cost cost-task-1", { cwd });
		expect(detail.ok).toBe(true);
		expect(detail.text).toContain("task cost-task-1 (session session-cost)");
		expect(detail.text).toContain("usage: input=10000 cached_input=20000 output=2000 reasoning=0 jev=1000 local_gpu_s=10 external_harness_calls=1 subscription=1");
		expect(detail.text).toContain("cost: api=$0.066000 jev=$0.000200 quota=$0.050000 effective=$0.126200");
		expect(detail.text).toContain("execution: wall=1200ms tool_calls=4 file_reads=3 repeated_reads=1 retries=1 escalations=0 compactions=1");
		expect(detail.text).toContain("result: verification=pass proof_gate=pass reviewer=pass success=true");
		expect(detail.text).toContain("jev_decisions: fixture.planning");
	});

	it("prints n/a for a session with no verified success, and names the store for an unknown task", async () => {
		const cwd = fixtureCwd();
		registerFixtureSites();
		const config = fixtureConfig(cwd, { jevUrl: stub.url });
		await runFixtureTask({ cwd, taskId: "failed-1", sessionId: "session-none", success: false, config });
		registerCostCommand(commandRegistry, { cwd, sessionId: "session-none" });

		const report = await commandRegistry.dispatch("/cost", { cwd });
		expect(report.ok).toBe(true);
		expect(report.text).toContain("verified successes: 0");
		expect(report.text).toContain("effective cost per verified success: n/a");

		const missing = await commandRegistry.dispatch("/cost no-such-task", { cwd });
		expect(missing.ok).toBe(false);
		expect(missing.text).toContain('no telemetry record for task "no-such-task"');
		expect(missing.text).toContain(telemetryPath(cwd));

		// A project with no store at all is not an error either.
		const emptyCwd = fixtureCwd();
		registerCostCommand(commandRegistry, { cwd: emptyCwd });
		const empty = await commandRegistry.dispatch("/cost", { cwd: emptyCwd });
		expect(empty.ok).toBe(true);
		expect(empty.text).toContain(`no telemetry recorded yet in ${telemetryPath(emptyCwd)}`);
	});

	it("folds the store and PRD-002's decision log into one aggregate", async () => {
		const cwd = fixtureCwd();
		registerFixtureSites();
		await runFixtureTask({ cwd, taskId: "agg-1", sessionId: "session-agg", success: true, config: fixtureConfig(cwd, { jevUrl: stub.url }) });

		const aggregate = aggregateTelemetry(cwd);
		expect(aggregate.runs).toBe(1);
		expect(aggregate.effectiveCostUsd).toBe(0.1262);
		expect(aggregate.costPerVerifiedSuccess).toBe(0.1262);
		// FR-055's separation and §25's discriminant, per call.
		expect(aggregate.byBackendType.native).toMatchObject({ calls: 1, inputTokens: 10_000, outputTokens: 2_000, costUsd: 0.066 });
		expect(aggregate.byBackendType.external_harness).toMatchObject({ calls: 1, costUsd: 0 });
		expect(aggregate.byBilling.metered).toMatchObject({ calls: 1, costUsd: 0.066 });
		expect(aggregate.byBilling.subscription?.calls).toBe(1);

		// §56's JEV metrics, folded from the decision log: two answered, one fell back.
		const decisions = readDecisions(cwd);
		expect(aggregate.jev).toMatchObject({ decisions: decisions.length, answered: 2, fallbacks: 1, tokens: 1_000 });
		expect(aggregate.jev.fallbackRate).toBeCloseTo(1 / 3, 10);
		expect(Object.keys(aggregate.jev.sites).sort()).toEqual(["fixture.complexity", "fixture.planning", "fixture.review_risk"]);
		expect(aggregate.jev.sites["fixture.review_risk"]).toEqual({ decisions: 1, fallbacks: 1, tokens: 0 });
		expect(aggregate.jev.sites["fixture.planning"]).toEqual({ decisions: 1, fallbacks: 0, tokens: 400 });
		expect(aggregate.jev.tokenShare).toBeCloseTo(1_000 / 13_000, 10);
	});
});
