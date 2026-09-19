/**
 * AC-6 and AC-7: historical calibration and the routing consequence of a
 * repeated failure signature.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendRun, resolveCostConfig, round6 } from "../../src/telemetry/index.js";
import type { RunTelemetry } from "../../src/telemetry/record.js";
import { bucketStats, classifyRouteFailure as classifyFailure, routeFailureSignature as failureSignature, selectRoute, type AttemptFailure } from "../../src/routing/index.js";
import { bucket, fixtureContract, rankingRecord, routingConfig } from "./fixture.js";

const RANKING = [
	rankingRecord({ model_id: "premium-fast", backend_hint: "claude", coding_score: 88, input: 3, output: 15 }),
	rankingRecord({ model_id: "budget-code", backend_hint: "opencode", coding_score: 75, input: 0.5, output: 1.5 }),
];

const BACKENDS = {
	claude: { type: "external_harness", command: "claude", quota_class: "scarce-premium", priority: 20 },
	opencode: { type: "external_harness", command: "opencode", quota_class: "low-cost", priority: 10 },
};

const MODELS = {
	strong: { backend: "claude", model: "premium-fast" },
	quick: { backend: "opencode", model: "budget-code" },
};

function fixture() {
	return routingConfig({
		ranking: RANKING,
		backends: BACKENDS,
		models: MODELS,
		quota_shadow_usd: { "scarce-premium": 0.002, "low-cost": 0.004 },
		latency_usd_per_sec: 0.001,
	});
}

const CONTRACT = fixtureContract({ complexity: "MEDIUM", executor_class: "balanced" });

/** Both buckets calibrated at 2000ms; only the retry outcomes differ. */
function calibrated(retriesOnClaude: number): RunTelemetry[] {
	return [
		...bucket(5, { backend: "claude", model: "premium-fast", executor_class: "strong", wall_ms: 2_000, retries: retriesOnClaude }),
		...bucket(5, { backend: "opencode", model: "budget-code", executor_class: "quick", wall_ms: 2_000, retries: 0 }),
	];
}

const REPEATED: AttemptFailure[] = [
	{ failure: "exit", command: "vitest run tests/x", exitCode: 1, assertion: "expected 1 to be 2", location: "src/a.ts:10" },
];
const OTHER: AttemptFailure[] = [{ failure: "parse", command: "typecheck", exitCode: null, location: "src/b.ts:4" }];

describe("AC-6 — predicted_retry comes from the bucket's observed outcomes", () => {
	it("derives the rate from the stored retry outcomes, and the term from the rate", async () => {
		const { config, cwd } = fixture();
		const history = calibrated(1);
		const key = { role: "strong", complexity: "MEDIUM" as const, backend: "claude" };
		const stats = bucketStats({
			history,
			key,
			min_bucket_runs: 5,
			matrix_retry_rate: 0.2,
			fallback: { latency_ms: 20_000, local_gpu_seconds: 30, input_tokens: 8_000, output_tokens: 1_500 },
		});
		expect(stats.calibration).toBe("telemetry");
		expect(stats.runs).toBe(5);
		expect(stats.retry_rate).toBe(1);
		expect(stats.latency_p50_ms).toBe(2_000);

		const decision = await selectRoute({ contract: CONTRACT, config, cwd, history });
		// The retrying backend's own prediction carries the observed preference.
		const retrying = decision.candidates.find((entry) => entry.candidate.id === "premium-fast")!;
		expect(retrying.prediction.calibration).toBe("telemetry");
		expect(retrying.prediction.predicted_retry).toBe(
			round6(1 * (retrying.prediction.monetary + retrying.prediction.quota_shadow + retrying.prediction.local_compute)),
		);
		expect(decision.selected?.candidate.id).toBe("budget-code");

		// Every observed retry, none of them: the term follows the store, not a constant.
		const clean = await selectRoute({ contract: CONTRACT, config, cwd, history: calibrated(0) });
		const cleaned = clean.candidates.find((entry) => entry.candidate.id === "premium-fast")!;
		expect(cleaned.prediction.predicted_retry).toBe(0);
		expect(cleaned.prediction.predicted_retry).not.toBe(retrying.prediction.predicted_retry);
		expect(clean.selected?.candidate.id).toBe("premium-fast");
	});

	it("flips the selected backend when the bucket's outcomes change", async () => {
		const { config, cwd } = fixture();
		const retrying = await selectRoute({ contract: CONTRACT, config, cwd, history: calibrated(1) });
		const clean = await selectRoute({ contract: CONTRACT, config, cwd, history: calibrated(0) });
		expect(retrying.selected?.candidate.backend).toBe("opencode");
		expect(clean.selected?.candidate.backend).toBe("claude");
	});

	it("returns the matrix default with insufficient-history for a thin bucket", async () => {
		const { config, cwd } = fixture();
		const thin = [...bucket(2, { backend: "claude", model: "premium-fast", executor_class: "strong", wall_ms: 2_000, retries: 1 })];
		const decision = await selectRoute({ contract: CONTRACT, config, cwd, history: thin });
		expect(decision.calibration).toBe("insufficient-history");
		const winner = decision.selected!;
		expect(decision.route_cost?.predicted_retry).toBe(round6(0.2 * (winner.prediction.monetary + winner.prediction.quota_shadow + winner.prediction.local_compute)));
		expect(winner.prediction.calibration).toBe("insufficient-history");
	});

	it("reads the telemetry store when no history is passed", async () => {
		const { config, cwd } = fixture();
		for (const run of calibrated(1)) appendRun(cwd, run, resolveCostConfig(config));
		// No `history` argument: the project's store is the calibration source.
		const fromStore = await selectRoute({ contract: CONTRACT, config, cwd });
		expect(fromStore.candidates.find((entry) => entry.candidate.id === "premium-fast")?.prediction.calibration).toBe("telemetry");
		expect(fromStore.selected?.candidate.id).toBe("budget-code");
	});

	it("holds no retry-rate literal outside the shipped defaults", () => {
		const dir = join(import.meta.dirname, "..", "..", "src", "routing");
		const offenders = ["calibration.ts", "config.ts", "cost.ts", "router.ts", "sites.ts", "candidates.ts"]
			.filter((file) => /retry[_a-z]*\s*[:=]\s*[0-9]/.test(readFileSync(join(dir, file), "utf8")))
			.map((file) => file);
		expect(offenders).toEqual([]);
	});
});

describe("AC-7 — a repeated failure signature moves the route", () => {
	it("classifies a repeated signature and dispatches a different backend", async () => {
		const { config, cwd } = fixture();
		const history = calibrated(0);
		const plain = await selectRoute({ contract: CONTRACT, config, cwd, history });
		const repeated = await selectRoute({
			contract: CONTRACT,
			config,
			cwd,
			history,
			priorAttempts: [...REPEATED, ...REPEATED],
		});
		expect(repeated.failure?.class).toBe("repeated-signature");
		expect(repeated.failure?.signature).toBe(failureSignature(REPEATED[0]!));
		expect(repeated.escalation).toBe("SWITCH_BACKEND");
		expect(repeated.selected?.candidate.backend).not.toBe(plain.selected?.candidate.backend);
	});

	it("raises effort instead when no other backend is clearing", async () => {
		const { config, cwd } = fixture();
		const history = calibrated(0);
		const solo = fixtureContract({ complexity: "MEDIUM", executor_class: "balanced", required: { min_coding_index: 85 } });
		const plain = await selectRoute({ contract: solo, config, cwd, history });
		expect(plain.selected?.candidate.id).toBe("premium-fast");
		expect(plain.candidates).toHaveLength(1);
		const repeated = await selectRoute({ contract: solo, config, cwd, history, priorAttempts: [...REPEATED, ...REPEATED] });
		expect(repeated.escalation).toBe("INCREASE_REASONING");
		expect(repeated.effort).toBe("high");
		expect(plain.effort).toBe("medium");
	});

	it("leaves the route alone for an unrelated new signature", async () => {
		const { config, cwd } = fixture();
		const history = calibrated(0);
		const plain = await selectRoute({ contract: CONTRACT, config, cwd, history });
		const fresh = await selectRoute({ contract: CONTRACT, config, cwd, history, priorAttempts: OTHER });
		expect(fresh.failure?.class).toBe("new-signature");
		expect(fresh.escalation).toBeNull();
		expect(fresh.selected?.candidate.id).toBe(plain.selected?.candidate.id);
		expect(fresh.effort).toBe(plain.effort);
	});

	it("normalizes a signature deterministically before comparing it", () => {
		const first = classifyFailure(REPEATED[0]!, [], []);
		const noisy = classifyFailure({ ...REPEATED[0]!, assertion: "  Expected 1 TO BE 2  ", command: "VITEST RUN  tests/x" }, [], []);
		expect(noisy.class).toBe("new-signature");
		expect(failureSignature({ ...REPEATED[0]!, assertion: "Expected 1 TO BE 2", command: "vitest   run tests/x" })).toBe(first.signature);
		const known = classifyFailure(REPEATED[0]!, [], [first.signature]);
		expect(known.class).toBe("known-signature");
		expect(known.escalation).toBeNull();
	});
});
