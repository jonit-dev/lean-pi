/**
 * AC-1 and AC-2: the predicted `route_cost` block on a real PRD-015 record, and
 * quota shadow pricing moving the route in both directions.
 */
import { describe, expect, it } from "vitest";
import { createRunCollector, emitRunTelemetry, readRuns, renderRun, resolveCostConfig, round6, appendRun } from "../../src/telemetry/index.js";
import { selectRoute, withRouteCost } from "../../src/routing/index.js";
import { bucket, fixtureContract, rankingRecord, routingConfig } from "./fixture.js";

const RANKING = [
	rankingRecord({ model_id: "premium-fast", backend_hint: "claude", coding_score: 88, input: 3, output: 15 }),
	rankingRecord({ model_id: "budget-code", backend_hint: "opencode", coding_score: 75, input: 0.5, output: 1.5 }),
	rankingRecord({ model_id: "local-code", backend_hint: "local", coding_score: 40, input: 0, output: 0 }),
	// Metered, so its predicted cost is the only one that moves with the effort's token count.
	rankingRecord({ model_id: "api-model", backend_hint: "api", coding_score: 90, input: 5, output: 20 }),
];

const BACKENDS = {
	claude: { type: "external_harness", command: "claude", quota_class: "scarce-premium", priority: 20 },
	opencode: { type: "external_harness", command: "opencode", quota_class: "low-cost", priority: 10 },
	local: { type: "native", provider: "llama.cpp", model: "local-code", marginal_cost: 0 },
	api: { type: "native", provider: "openai", model: "api-model" },
};

/** PRD-024 binds a ranked record only through the spelling the config declares. */
const MODELS = {
	quick: { backend: "opencode", model: "budget-code" },
	strong: { backend: "claude", model: "premium-fast" },
	specialist: { backend: "api", model: "api-model" },
};

/** A medium task, with the two subscription buckets the calibration reads. */
function mediumFixture(quotaShadow: Record<string, number>) {
	const { config, cwd } = routingConfig({
		ranking: RANKING,
		backends: BACKENDS,
		models: MODELS,
		quota_shadow_usd: quotaShadow,
		latency_usd_per_sec: 0.001,
		local_usd_per_gpu_sec: 0.0001,
	});
	const history = [
		...bucket(5, { backend: "claude", model: "premium-fast", executor_class: "strong", wall_ms: 2_000, retries: 0 }),
		...bucket(5, { backend: "opencode", model: "budget-code", executor_class: "quick", wall_ms: 20_000, retries: 0 }),
	];
	return { config, cwd, history, contract: fixtureContract({ complexity: "MEDIUM", executor_class: "balanced" }) };
}

describe("AC-1 — the predicted route_cost block is stored beside the measured cost", () => {
	it("records the five §26 terms summing to the predicted total, distinct from effective_cost", async () => {
		const { config, cwd, history, contract } = mediumFixture({ "scarce-premium": 0.001, "low-cost": 0.010 });
		const decision = await selectRoute({ contract, config, cwd, history });
		expect(decision.selected?.candidate.id).toBe("premium-fast");

		// A real run record, written by PRD-015's collector and emitter.
		const collector = createRunCollector({ taskId: "t1", sessionId: "s1" });
		collector.add({
			backend: "claude",
			model: "premium-fast",
			type: "external_harness",
			role: "balanced",
			billing: "subscription",
			quotaClass: "scarce-premium",
			usage: { inputTokens: 1_000, outputTokens: 200 },
		});
		collector.addWallMs(5_000);
		const record = emitRunTelemetry(
			collector,
			contract,
			{ verification: "pass", proof_gate: "pass", reviewer: "pass", success: true },
			{ cwd, cost: resolveCostConfig(config) },
		);
		expect(record).toBeDefined();
		// PRD-015 computes no prediction; the block is this PRD's, attached afterwards.
		expect(record?.route_cost).toBeUndefined();

		const stored = withRouteCost(record!, decision);
		const block = stored.route_cost;
		expect(block).toBeDefined();
		expect(round6(block!.monetary + block!.quota_shadow + block!.local_compute + block!.latency + block!.predicted_retry)).toBe(
			decision.selected!.prediction.route_cost,
		);
		expect(block!.quota_shadow).toBe(resolveCostConfig(config).quota_shadow_usd["scarce-premium"]);
		expect(stored.cost.effective_cost).toBe(record!.cost.effective_cost);
		expect(stored.cost.effective_cost).toBeGreaterThan(0);
		expect(decision.selected!.prediction.route_cost).not.toBe(stored.cost.effective_cost);
		// `/cost` renders the measurement only: attaching a prediction changes no line.
		expect(renderRun(stored)).toBe(renderRun(record!));

		// The block survives the store round-trip, still independently stored.
		appendRun(cwd, stored, resolveCostConfig(config));
		const reread = readRuns(cwd).filter((row) => row.task_id === "t1");
		expect(reread).toHaveLength(2);
		expect(reread[1]?.route_cost).toEqual(block);
		expect(reread[1]?.cost.effective_cost).toBe(record!.cost.effective_cost);
	});

	it("stores a prediction that moves with effort while the measurement does not", async () => {
		const { config, cwd, history } = mediumFixture({ "scarce-premium": 0.001, "low-cost": 0.010 });
		// A floor only the metered model clears, so the prediction is not priced at zero.
		const required = { min_coding_index: 89 };
		const low = await selectRoute({ contract: fixtureContract({ complexity: "LOW", executor_class: "quick", required }), config, cwd, history });
		const high = await selectRoute({ contract: fixtureContract({ complexity: "HIGH", executor_class: "strong", required }), config, cwd, history });
		expect(low.selected!.candidate.id).toBe("api-model");
		expect(low.effort).toBe("minimal");
		expect(high.effort).toBe("high");
		expect(low.selected!.prediction.monetary).toBeGreaterThan(0);
		expect(low.selected!.prediction.route_cost).not.toBe(high.selected!.prediction.route_cost);
		expect(high.selected!.prediction.route_cost).toBeGreaterThan(low.selected!.prediction.route_cost);
	});
});

describe("AC-2 — the shadow price re-routes the identical task, in both directions", () => {
	it("selects the scarce-premium backend at baseline, the cheaper one when the price rises, and back", async () => {
		const baseline = mediumFixture({ "scarce-premium": 0.001, "low-cost": 0.010 });
		const first = await selectRoute(baseline);
		expect(first.selected?.candidate.backend).toBe("claude");
		expect(first.route_cost?.quota_shadow).toBe(0.001);

		const raised = mediumFixture({ "scarce-premium": 0.040, "low-cost": 0.010 });
		const second = await selectRoute(raised);
		expect(second.selected?.candidate.backend).toBe("opencode");
		expect(second.route_cost?.quota_shadow).toBe(0.01);

		const restored = await selectRoute(baseline);
		expect(restored.selected?.candidate.backend).toBe("claude");
	});

	it("scores the same quota class key PRD-015 prices estimated_quota_cost from", async () => {
		const { config, cwd, history, contract } = mediumFixture({ "scarce-premium": 0.007, "low-cost": 0.010 });
		const decision = await selectRoute({ contract, config, cwd, history });
		expect(decision.selected?.candidate.quota_class).toBe("scarce-premium");
		expect(decision.route_cost?.quota_shadow).toBe(resolveCostConfig(config).quota_shadow_usd["scarce-premium"]);
	});
});
