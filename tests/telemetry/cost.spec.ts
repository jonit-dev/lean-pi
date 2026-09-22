/**
 * E2 (PRD-015 Phase 2): `/cost` answers "what did this session cost per verified
 * success".
 *
 * Covers AC-5 by dispatching the real slash command through the command registry
 * (PRD-016's), over a session with two runs — one that passed the proof gate and
 * one that failed. The failed run must not enter the denominator, which is what
 * distinguishes the printed figure from the wrong one.
 */
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BackendRegistry, runWorkerTurn, type BackendInvocation } from "../../src/backends/index.js";
import { commandRegistry } from "../../src/commands/registry.js";
import { ConfigError, loadConfig } from "../../src/core/config.js";
import type { LeanPiConfig } from "../../src/core/types.js";
import { readDecisions } from "../../src/jev/log.js";
import { aggregateTelemetry } from "../../src/telemetry/aggregate.js";
import { callsFromMessages, createRunCollector, feedInvocation, type CallUsage } from "../../src/telemetry/collect.js";
import { registerCostCommand, renderRun } from "../../src/telemetry/cost.js";
import { emitRunTelemetry } from "../../src/telemetry/emit.js";
import { priceCall, priceRun, resolveCostConfig, type CostConfig } from "../../src/telemetry/pricing.js";
import type { CallRow } from "../../src/telemetry/record.js";
import { appendRun, readRuns, telemetryPath } from "../../src/telemetry/store.js";
import { startStubJev, typedAnswers, type StubJev, type StubJevResponder } from "../helpers/stub-jev.js";
import { startStubBackend } from "../helpers/stub-backend.js";
import { fixtureConfig, fixtureCwd, registerFixtureSites, runFixtureTask } from "./fixture.js";
import { fixtureRepo, gitInit, nativeBackend, writeConfig } from "../helpers/fixtures.js";
import { fixtureContract, runRecord } from "../routing/fixture.js";

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
		expect(detail.text).toContain("usage: input=10000 cached_input=20000 cache_write=0 output=2000 reasoning=0 jev=1000 local_gpu_s=10 external_harness_calls=1 subscription=1");
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

	it("bills each assistant message's own model, not the model bound at turn start (F3)", () => {
		// One backend priced, one registered with no `cost:` block at all.
		const cost = resolveCostConfig({
			backends: { api: { cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }, spare: {} },
		} as unknown as LeanPiConfig);
		const { calls } = callsFromMessages(
			[
				{ role: "assistant", provider: "api", model: "claude-sonnet-4", usage: { input: 1_000, cacheRead: 0, cacheWrite: 400, output: 100, reasoning: 40 }, content: [] },
				{ role: "assistant", provider: "spare", model: "gpt-5-unlisted", usage: { input: 500, cacheRead: 0, cacheWrite: 0, output: 20 }, content: [] },
				{ role: "assistant", usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 }, content: [] },
			],
			{ backend: "api", model: "claude-sonnet-4" },
		);

		// Three rows under three identities, not three copies of the turn-start ref:
		// the message's own, then the model it switched to, then the ref as fallback.
		expect(calls.map((call) => `${call.backend}/${call.model}`)).toEqual([
			"api/claude-sonnet-4",
			"spare/gpt-5-unlisted",
			"api/claude-sonnet-4",
		]);

		// 1000 input + 400 cache writes + 100 output = $0.006. Dropping the cache
		// writes would price it $0.0045, and billing Pi's `output` whole on top of
		// its `reasoning` subset would price it $0.0066.
		expect(priceCall(calls[0]!, cost)).toBe(0.006);
		// No rate card for the model it switched to, and none is invented.
		expect(priceCall(calls[1]!, cost)).toBe(0);
	});

	it("reports the paths a Pi-driven turn read, so re-reads are countable (4a)", () => {
		// `execution.file_reads`/`repeated_reads` were structurally always 0: the
		// collector's `noteFileRead` had no production caller, so the only two
		// counters that could show a re-read never moved. The paths come off the
		// same message list the tool count does.
		const { fileReads } = callsFromMessages(
			[
				{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }] },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", name: "read", arguments: { path: "src/a.ts", offset: 40 } },
						{ type: "toolCall", name: "execute", arguments: { command: "ls" } },
					],
				},
				{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/b.ts" } }] },
			],
			{ backend: "api", model: "claude-sonnet-4" },
		);
		// Order and repeats are kept: the collector is what collapses a repeat into
		// `repeated_reads`, and it can only do that if it sees the second read.
		expect(fileReads).toEqual(["src/a.ts", "src/a.ts", "src/b.ts"]);
	});

	it("names the unpriced calls and the population it totalled (F3)", async () => {
		const cwd = fixtureCwd();
		registerFixtureSites();
		const config = fixtureConfig(cwd, { jevUrl: stub.url });
		await runFixtureTask({ cwd, taskId: "scoped-1", sessionId: "session-a", success: true, config });
		// A second run whose executor ran on a model the rate card does not list:
		// one call left at $0 with its tokens intact. No `pricing` provenance, the
		// way a row written before that field existed reads — the fallback the
		// report has to keep honest rather than treat as a zero rate.
		const base = readRuns(cwd, { sessionId: "session-a" })[0]!;
		const priced = base.calls.find((call) => call.billing === "metered")!;
		const unlisted = { ...priced, model: "gpt-5-unlisted", costUsd: 0 };
		delete unlisted.pricing;
		appendRun(cwd, { ...base, task_id: "scoped-2", session_id: "session-b", calls: [unlisted] });

		// Registered without a session id: the report covers both sessions and says so.
		registerCostCommand(commandRegistry, { cwd });
		const report = await commandRegistry.dispatch("/cost", { cwd });
		expect(report.ok).toBe(true);
		expect(report.text).toContain("runs: 2");
		expect(report.text).not.toContain("session total:");
		expect(report.text).toContain("all sessions total:");
		expect(report.text).toContain("unpriced: 1 metered call(s) with missing or unrecorded rates (api/gpt-5-unlisted)");

		// The single-record view discloses it too; the priced run says nothing.
		const unpriced = await commandRegistry.dispatch("/cost scoped-2", { cwd });
		expect(unpriced.text).toContain("unpriced: 1 metered call(s) with missing or unrecorded rates (api/gpt-5-unlisted)");
		const detail = await commandRegistry.dispatch("/cost scoped-1", { cwd });
		expect(detail.text).not.toContain("unpriced:");

		// Filtered to one session, the label is the session's again.
		registerCostCommand(commandRegistry, { cwd, sessionId: "session-a" });
		const scoped = await commandRegistry.dispatch("/cost", { cwd });
		expect(scoped.text).toContain("runs: 1");
		expect(scoped.text).toContain("session total:");
	});
});

/**
 * A4 + COST-1: the operator's declared cost surface must survive `loadConfig`.
 * The fixture above injects `jev.usd_per_mtok` and `cost:` onto the config
 * object, which is exactly why the drop went unnoticed — this reads a real file.
 */
describe("A4 + COST-1 — the declared cost surface round-trips through loadConfig", () => {
	it("keeps jev.usd_per_mtok and carries the top-level cost: block into pricing", () => {
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { api: { type: "native", baseUrl: "http://127.0.0.1:9/v1", cost: { input: 3, output: 15 } } },
			models: { balanced: { backend: "api", model: "claude-sonnet-4" } },
			jev: { usd_per_mtok: 0.2 },
			cost: {
				quota_shadow_usd: { "scarce-premium": 0.05 },
				local_usd_per_gpu_sec: 0.001,
				latency_usd_per_sec: 0.002,
			},
		});

		const config = loadConfig(cwd, {}, { XDG_CONFIG_HOME: join(agentDir, "xdg") });
		const cost = resolveCostConfig(config);
		expect(cost.jev_usd_per_mtok).toBe(0.2);
		expect(cost.quota_shadow_usd?.["scarce-premium"]).toBe(0.05);
		expect(cost.local_usd_per_gpu_sec).toBe(0.001);
		expect(cost.latency_usd_per_sec).toBe(0.002);
		// The per-backend Pi `cost` block still wins its own home.
		expect(cost.backends?.api).toMatchObject({ input: 3, output: 15 });

		// 1M JEV tokens at the declared $0.2/Mtok is $0.2, not the old $0.
		const priced = priceRun(
			{
				calls: [],
				usage: {
					input_tokens: 0,
					cached_input_tokens: 0,
					output_tokens: 0,
					reasoning_tokens: 0,
					jev_tokens: 1_000_000,
					local_gpu_seconds: 0,
					external_harness_calls: 0,
					subscription_usage: 0,
				},
				wallMs: 1000,
			},
			cost,
		);
		expect(priced.jev_usd).toBe(0.2);
		expect(priced.effective_cost).toBe(0.202);
	});
});

/**
 * COST-4: a configured monetary rate is an operator's declaration, so an
 * invalid one is a named load error naming the key — never a silent clamp to
 * 0 that makes a typo look free, and never a negative rate that credits spend.
 * A legitimate `0` stays valid.
 */
describe("COST-4 — invalid monetary rates fail load with a named ConfigError", () => {
	const BASE = {
		backends: { api: { type: "native", baseUrl: "http://127.0.0.1:9/v1" } },
		models: { balanced: { backend: "api", model: "m" } },
	};

	function tryLoad(block: Record<string, unknown>): { ok: boolean; config?: LeanPiConfig; error?: Error } {
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, { ...BASE, ...block });
		try {
			return { ok: true, config: loadConfig(cwd, {}, { XDG_CONFIG_HOME: join(agentDir, "xdg") }) };
		} catch (error) {
			return { ok: false, error: error as Error };
		}
	}

	function expectRejected(block: Record<string, unknown>, pathFragment: string): void {
		const result = tryLoad(block);
		expect(result.ok).toBe(false);
		expect(result.error).toBeInstanceOf(ConfigError);
		expect(result.error?.message).toContain(pathFragment);
	}

	it("rejects a negative per-model rate and names the offending key", () => {
		expectRejected({ cost: { models: { m: { input: -3 } } } }, "cost.models.m.input");
	});

	it("rejects a non-finite per-model rate", () => {
		expectRejected({ cost: { models: { m: { output: Number.POSITIVE_INFINITY } } } }, "cost.models.m.output");
	});

	it("rejects a negative run-level policy rate", () => {
		expectRejected({ cost: { local_usd_per_gpu_sec: -0.001 } }, "cost.local_usd_per_gpu_sec");
		expectRejected({ cost: { latency_usd_per_sec: -1 } }, "cost.latency_usd_per_sec");
	});

	it("rejects a negative or non-finite quota shadow price", () => {
		expectRejected({ cost: { quota_shadow_usd: { premium: -0.05 } } }, "cost.quota_shadow_usd.premium");
		expectRejected({ cost: { quota_shadow_usd: { premium: Number.NaN } } }, "cost.quota_shadow_usd.premium");
	});

	it("rejects a negative JEV rate", () => {
		expectRejected({ jev: { usd_per_mtok: -0.2 } }, "jev.usd_per_mtok");
	});

	it("rejects a negative backend cache-write rate", () => {
		const block = { backends: { api: { type: "native", baseUrl: "http://127.0.0.1:9/v1", cost: { input: 1, cacheWrite: -2 } } } };
		expectRejected(block, "backends.api.cost.cacheWrite");
	});

	it("accepts a legitimate zero rate and prices from it", () => {
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			...BASE,
			cost: { models: { m: { input: 0 } }, local_usd_per_gpu_sec: 0 },
			jev: { usd_per_mtok: 0 },
		});
		const config = loadConfig(cwd, {}, { XDG_CONFIG_HOME: join(agentDir, "xdg") });
		expect(resolveCostConfig(config).models?.m?.input).toBe(0);
		expect(resolveCostConfig(config).jev_usd_per_mtok).toBe(0);
	});
});

describe("COST-2 — a native run's cache-write tokens survive to the stored record", () => {
	it("carries cacheWrite from the Pi loop through invocation, store, pricing and the breakdown", async () => {
		// A real Pi loop against the stub HTTP provider: the usage chunk is the
		// actual boundary where cache-write tokens enter LeanPi.
		const stub = await startStubBackend([
			{ text: "done", usage: { prompt_tokens: 1_000, completion_tokens: 100, cached_tokens: 200, cache_write_tokens: 400 } },
		]);
		const { cwd } = fixtureRepo();
		gitInit(cwd);
		writeConfig(cwd, {
			backends: {
				local: nativeBackend(stub.baseUrl, { model: "local-code", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }),
			},
			models: { quick: { backend: "local", model: "local-code" } },
		});
		const config = loadConfig(cwd);
		const captured: BackendInvocation[] = [];
		const registry = new BackendRegistry(config, { onInvocation: (record) => captured.push(record) });

		const outcome = await runWorkerTurn({ objective: "say done", role: "quick" }, { registry, cwd });
		await stub.close();
		expect(outcome.status).toBe("completed");

		// Normalization: the invocation the run emitted carries the quantity.
		expect(captured).toHaveLength(1);
		expect(captured[0]!.usage?.cacheWriteTokens).toBe(400);

		// Feed exactly that invocation through the accumulator and the one writer.
		const collector = createRunCollector({ taskId: "cost2", sessionId: "session-cost2" });
		feedInvocation(collector, captured[0]!);
		const record = emitRunTelemetry(
			collector,
			fixtureContract({ complexity: "LOW", executor_class: "quick" }),
			{ verification: "pass", proof_gate: "pass", reviewer: "pass", success: true },
			{ cwd, cost: resolveCostConfig(config) },
		);
		expect(record).toBeDefined();

		// Persisted round-trip: the stored row and run totals expose it.
		const stored = readRuns(cwd)[0]!;
		expect(stored.calls).toHaveLength(1);
		expect(stored.calls[0]!.cacheWriteTokens).toBe(400);
		expect(stored.usage.cache_write_tokens).toBe(400);

		// Hand-computed: input 400 @ $3, cache read 200 @ $0.3, cache write
		// 400 @ $3.75, output 100 @ $15 = (1200 + 60 + 1500 + 1500)/1e6.
		expect(stored.cost.api_usd).toBe(0.00426);
		// Dropping cache writes would price $0.00276; input and output are not
		// counted a second time through the cache buckets.
		expect(stored.usage.input_tokens).toBe(400);
		expect(stored.usage.cached_input_tokens).toBe(200);
		expect(stored.usage.output_tokens).toBe(100);

		// Rendered breakdown names the cache-write quantity.
		expect(renderRun(stored)).toContain("cache_write=400");
	});
});

/**
 * COST-3: the dollar total cannot express a subscription pool call or a local
 * GPU-second — both price at 0 — nor a metered call that recorded no usage.
 * The aggregate report names those volumes and labels the figure as a
 * configured valuation, so $0 is never read as "nothing happened" or "free".
 */
describe("COST-3 — the aggregate report names the volume a dollar total cannot", () => {
	function call(overrides: Partial<CallRow>): CallRow {
		return {
			timestamp: "2026-09-21T00:00:00.000Z",
			backend: "b",
			backend_type: "native",
			model: "m",
			role: "balanced",
			inputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
			...overrides,
		};
	}

	it("shows subscription/local volume, labels unmeasured metered calls, and marks the figure a valuation", async () => {
		const cwd = fixtureCwd();
		appendRun(cwd, {
			...runRecord({ backend: "claude", model: "premium", success: true }, 1),
			task_id: "sub-only",
			session_id: "s-sub",
			calls: [call({ backend: "claude", backend_type: "external_harness", model: "premium", role: "review_quick", billing: "subscription" })],
		});
		appendRun(cwd, {
			...runRecord({ backend: "local", model: "local-code", local_gpu_seconds: 10, success: true }, 2),
			task_id: "local-only",
			session_id: "s-local",
			calls: [call({ backend: "local", model: "local-code", billing: "local" })],
		});
		// A metered call that recorded no usage: unknown, not free.
		const ghost = runRecord({ backend: "api", model: "ghost", success: false }, 3);
		appendRun(cwd, {
			...ghost,
			task_id: "unmeasured",
			session_id: "s-unmeasured",
			usage: { ...ghost.usage, external_harness_calls: 0, subscription_usage: 0, local_gpu_seconds: 0 },
			calls: [call({ backend: "api", model: "ghost", billing: "metered" })],
		});

		registerCostCommand(commandRegistry, { cwd });
		const report = await commandRegistry.dispatch("/cost", { cwd });
		expect(report.ok).toBe(true);
		// Legitimate zero-cost volume is named, not hidden behind $0.000000.
		expect(report.text).toContain("subscription 1 call(s)");
		expect(report.text).toContain("local 1 call(s)");
		expect(report.text).toContain("10 local gpu-s");
		// A metered call with no recorded usage is labelled unmeasured.
		expect(report.text).toContain("unmeasured: 1 metered call(s)");
		// The total is a configured valuation, never presented as an invoice.
		expect(report.text).toContain("configured post-run valuation");
		// The truth is preserved: those runs cost $0.
		expect(report.text).toContain("all sessions total: $0.000000");
	});
});

/**
 * COST-3 review: a metered call's `$0` has three different meanings — the
 * operator declared a zero (or a rate so small the charge rounds to zero), the
 * model has no configured rate at all, or the call reported no usage. Guessing
 * from `costUsd === 0` mislabels the first as unknown and misses the cache-only
 * case entirely. The writer records the provenance, and the report reads it.
 */
describe("COST-3 — the report classifies a zero by provenance, not by the number", () => {
	function emit(cwd: string, cost: CostConfig, usage: CallUsage, model = "m", backend = "api"): void {
		const collector = createRunCollector({ taskId: `prov-${Math.random().toString(36).slice(2)}`, sessionId: "s-prov" });
		collector.add({ backend, model, type: "native", role: "balanced", usage });
		emitRunTelemetry(collector, fixtureContract({ complexity: "LOW", executor_class: "quick" }), {
			verification: "pass",
			proof_gate: "pass",
			reviewer: "pass",
			success: true,
		}, { cwd, cost });
	}

	async function report(cwd: string): Promise<string> {
		registerCostCommand(commandRegistry, { cwd });
		const result = await commandRegistry.dispatch("/cost", { cwd });
		expect(result.ok).toBe(true);
		return result.text;
	}

	it("persists the measured cache-read and reasoning buckets on the call row", () => {
		const cwd = fixtureCwd();
		emit(cwd, { models: { m: { input: 1, cachedInput: 1, output: 1 } } }, {
			inputTokens: 10,
			cachedInputTokens: 20,
			cacheWriteTokens: 30,
			outputTokens: 40,
			reasoningTokens: 5,
		});
		const row = readRuns(cwd)[0]!.calls[0]!;
		expect(row.cachedInputTokens).toBe(20);
		expect(row.reasoningTokens).toBe(5);
	});

	it("does not call a configured zero rate 'no configured rate'", async () => {
		const cwd = fixtureCwd();
		emit(cwd, { models: { m: { input: 0, output: 0 } } }, { inputTokens: 1_000, outputTokens: 100 });
		expect(await report(cwd)).not.toContain("unpriced");
	});

	it("does not call a declared rate that rounds a positive charge to zero 'unknown'", async () => {
		const cwd = fixtureCwd();
		emit(cwd, { models: { m: { input: 0.000001, output: 0.000001 } } }, { inputTokens: 1, outputTokens: 0 });
		expect(await report(cwd)).not.toContain("unpriced");
	});

	it("discloses a cache-write-only call whose cache rate is missing", async () => {
		const cwd = fixtureCwd();
		emit(cwd, { models: { m: { input: 3 } } }, { cacheWriteTokens: 400 });
		const text = await report(cwd);
		expect(text).toContain("unpriced");
		expect(text).toContain("api/m");
	});

	it("classifies a cache-read-only call with a missing cache rate as unpriced, not unmeasured", async () => {
		const cwd = fixtureCwd();
		emit(cwd, { models: { m: { input: 3 } } }, { cachedInputTokens: 500 });
		const text = await report(cwd);
		expect(text).toContain("unpriced");
		expect(text).not.toContain("unmeasured");
	});

	it("still discloses a metered call with no usage at all", async () => {
		const cwd = fixtureCwd();
		emit(cwd, { models: { m: { input: 3 } } }, {});
		expect(await report(cwd)).toContain("unmeasured");
	});

	it("reads an old record with no provenance field with honest uncertainty", async () => {
		const cwd = fixtureCwd();
		const legacy = runRecord({ backend: "api", model: "m", success: false }, 9);
		appendRun(cwd, {
			...legacy,
			task_id: "legacy",
			session_id: "s-legacy",
			calls: [
				{
					timestamp: "2026-09-21T00:00:00.000Z",
					backend: "api",
					backend_type: "native",
					model: "m",
					role: "balanced",
					inputTokens: 500,
					outputTokens: 10,
					costUsd: 0,
				},
			],
		});
		const text = await report(cwd);
		expect(text).toContain("missing or unrecorded rates");
		expect(text).not.toContain("no configured rate");
	});
});
