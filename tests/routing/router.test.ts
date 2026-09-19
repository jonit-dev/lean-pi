/**
 * AC-3, AC-4 and AC-5: specialist roles, adaptive effort through the request
 * PRD-008's worker receives, and the JEV sites over the deterministic path.
 */
import { describe, expect, it } from "vitest";
import { BackendRegistry, runWorkerTurn } from "../../src/backends/index.js";
import type { LeanPiConfig } from "../../src/core/types.js";
import { createJevClient, type JevClient } from "../../src/jev/client.js";
import { dispatchRequest, selectRoute, type RouteDecision } from "../../src/routing/index.js";
import type { RunTelemetry } from "../../src/telemetry/record.js";
import { installStubCli, setStubScript } from "../backends/helpers.js";
import { startStubJev, type StubJev, type StubJevResponder } from "../helpers/stub-jev.js";
import { bucket, fixtureContract, rankingRecord, routingConfig } from "./fixture.js";

const RANKING = [
	rankingRecord({ model_id: "generic-model", backend_hint: "claude", coding_score: 75, input: 1, output: 3 }),
	rankingRecord({ model_id: "ts-model", backend_hint: "codex", coding_score: 80, input: 1, output: 3, specializations: ["typescript"] }),
	rankingRecord({ model_id: "py-model", backend_hint: "opencode", coding_score: 78, input: 1, output: 3, specializations: ["python"] }),
	rankingRecord({ model_id: "weak-ts", backend_hint: "local", coding_score: 40, input: 0, output: 0, specializations: ["typescript"] }),
];

const BACKENDS: Record<string, Record<string, unknown>> = {
	claude: { type: "external_harness", command: "claude", quota_class: "scarce-premium", priority: 20 },
	codex: { type: "external_harness", command: "codex", quota_class: "premium", priority: 15, effort_param: "reasoning_effort" },
	opencode: { type: "external_harness", command: "opencode", quota_class: "low-cost", priority: 10 },
	local: { type: "native", provider: "llama.cpp", model: "weak-ts", marginal_cost: 0 },
};

const MODELS = {
	balanced: { backend: "claude", model: "generic-model" },
	specialist: { backend: "codex", model: "ts-model" },
	quick: { backend: "opencode", model: "py-model" },
	strong: { backend: "local", model: "weak-ts" },
};

/** Pins make each role's ref explicit, so the preference group is unambiguous. */
const ROLES = {
	balanced: { min_coding_index: 70, pin: "generic-model" },
	specialist: { min_coding_index: 70, pin: "ts-model" },
	quick: { min_coding_index: 50, pin: "py-model" },
	strong: { min_coding_index: 70, pin: "weak-ts" },
};

/**
 * Three clearing candidates whose predicted costs tie at every complexity, so
 * only the role preference and the tie band can separate them.
 */
const HISTORY: RunTelemetry[] = (["LOW", "MEDIUM", "HIGH"] as const).flatMap((complexity) => [
	...bucket(5, { backend: "claude", model: "generic-model", executor_class: "balanced", complexity, wall_ms: 4_000 }),
	...bucket(5, { backend: "codex", model: "ts-model", executor_class: "specialist", complexity, wall_ms: 5_000 }),
	...bucket(5, { backend: "opencode", model: "py-model", executor_class: "quick", complexity, wall_ms: 6_000 }),
]);

function fixture(spec: { specialists?: Record<string, string>; routing?: Record<string, unknown>; backends?: Record<string, Record<string, unknown>> } = {}) {
	return routingConfig({
		ranking: RANKING,
		backends: spec.backends ?? BACKENDS,
		models: { ...MODELS, ...(spec.specialists ? { specialists: spec.specialists } : {}) },
		capability: { roles: ROLES },
		quota_shadow_usd: { "scarce-premium": 0.004, premium: 0.003, "low-cost": 0.002 },
		latency_usd_per_sec: 0.001,
		routing: spec.routing ?? {},
	});
}

const SPECIALISTS = { typescript: "specialist", python: "quick" };

describe("AC-3 — specialists are a preference inside the clearing set", () => {
	it("sends each language to its bound model, and both to the matrix role without the entries", async () => {
		const { config, cwd } = fixture({ specialists: SPECIALISTS });
		const typescript = await selectRoute({
			contract: fixtureContract({ complexity: "MEDIUM", executor_class: "balanced", required: { min_coding_index: 70, specialization: "typescript" } }),
			config,
			cwd,
			history: HISTORY,
		});
		const python = await selectRoute({
			contract: fixtureContract({ complexity: "MEDIUM", executor_class: "balanced", required: { min_coding_index: 70, specialization: "python" } }),
			config,
			cwd,
			history: HISTORY,
		});
		expect(typescript.selected?.candidate.id).toBe("ts-model");
		expect(python.selected?.candidate.id).toBe("py-model");
		// Every specialist is inside the tie band, so the preference — not the price — decided.
		expect(typescript.finalists).toContain("ts-model");

		const generic = fixture({ routing: {} });
		const without = await selectRoute({
			contract: fixtureContract({ complexity: "MEDIUM", executor_class: "balanced", required: { min_coding_index: 70, specialization: "typescript" } }),
			config: generic.config,
			cwd: generic.cwd,
			history: HISTORY,
		});
		expect(without.selected?.candidate.id).toBe("generic-model");
	});

	it("skips a specialist bound to a below-bar model in favour of the generic role", async () => {
		const { config, cwd } = fixture({ specialists: { rust: "strong" } });
		const decision = await selectRoute({
			contract: fixtureContract({ complexity: "MEDIUM", executor_class: "balanced", required: { min_coding_index: 70, specialization: "rust" } }),
			config,
			cwd,
			history: HISTORY,
		});
		expect(decision.selected?.candidate.id).toBe("generic-model");
		// The below-bar model is never in the scored set at all.
		expect(decision.candidates.map((entry) => entry.candidate.id)).not.toContain("weak-ts");
	});

	it("falls through to the matrix role for an unknown language, without error", async () => {
		const { config, cwd } = fixture({ specialists: SPECIALISTS });
		const decision = await selectRoute({
			contract: fixtureContract({ complexity: "MEDIUM", executor_class: "balanced", required: { min_coding_index: 70, specialization: "cobol" } }),
			config,
			cwd,
			history: HISTORY,
		});
		expect(decision.selected?.candidate.id).toBe("generic-model");
	});
});

describe("AC-4 — effort scales with complexity and rides the dispatched request", () => {
	async function typescriptRoute(complexity: "LOW" | "HIGH", executor: "quick" | "strong"): Promise<{ decision: RouteDecision; config: LeanPiConfig }> {
		const { config, cwd } = fixture({ specialists: SPECIALISTS });
		const decision = await selectRoute({
			contract: fixtureContract({ complexity, executor_class: executor, required: { min_coding_index: 70, specialization: "typescript" } }),
			config,
			cwd,
			history: HISTORY,
		});
		return { decision, config };
	}

	it("puts minimal effort on a low-complexity contract and high on a high-complexity one", async () => {
		const low = await typescriptRoute("LOW", "quick");
		const high = await typescriptRoute("HIGH", "strong");
		expect(low.decision.selected?.candidate.backend).toBe("codex");
		expect(low.decision.effort).toBe("minimal");
		expect(high.decision.effort).toBe("high");
		const lowRequest = dispatchRequest({ objective: "route this task", role: "quick" }, low.decision, low.config) as Record<string, unknown>;
		const highRequest = dispatchRequest({ objective: "route this task", role: "quick" }, high.decision, high.config) as Record<string, unknown>;
		expect(lowRequest.reasoning_effort).toBe("minimal");
		expect(highRequest.reasoning_effort).toBe("high");
	});

	it("sends no effort parameter to a backend that declares none, which still executes", async () => {
		const cli = installStubCli();
		const pool = { ...BACKENDS, claude: { ...BACKENDS.claude, command: cli.bin.claude } };
		const { config, cwd } = fixture({ backends: pool });
		const decision = await selectRoute({
			contract: fixtureContract({ complexity: "MEDIUM", executor_class: "balanced", required: { min_coding_index: 70, specialization: "cobol" } }),
			config,
			cwd,
			history: HISTORY,
		});
		expect(decision.selected?.candidate.backend).toBe("claude");
		expect(dispatchRequest({ objective: "route this task", role: "balanced" }, decision, config)).toEqual({
			objective: "route this task",
			role: "balanced",
		});

		const request = dispatchRequest({ objective: "create routed.txt", role: "balanced", files: ["routed.txt"] }, decision, config);
		const restore = setStubScript(cli.recordPath, { files: { "routed.txt": "routed\n" } });
		const outcome = await runWorkerTurn(request, { registry: new BackendRegistry(config), cwd });
		restore();
		expect(outcome.status).toBe("completed");
		expect(cli.records().map((record) => record.vendor)).toEqual(["claude"]);
	});
});

describe("AC-5 — the JEV sites sit above the deterministic path", () => {
	/** The three sites off: the shipped path, with a live JEV client that must stay silent. */
	async function withStubJev(
		responder: StubJevResponder,
		routing: Record<string, unknown>,
	): Promise<{ client: JevClient; stub: StubJev; config: LeanPiConfig; cwd: string }> {
		const stub = await startStubJev([responder]);
		const { config, cwd } = fixture({ specialists: SPECIALISTS, routing });
		const live = { ...config, jev: { ...config.jev, endpoint: stub.url, apiKey: "test-key", mode: "enabled" as const } };
		return { client: createJevClient({ config: live, cwd }), stub, config: live, cwd };
	}

	const namedChoice = (choice: string): StubJevResponder => (body) => {
		const questions = (body.questions ?? {}) as Record<string, { type?: string; criteria?: unknown }>;
		const answers: Record<string, unknown> = {};
		for (const [id, question] of Object.entries(questions)) {
			if (question.type === "choice") {
				const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>);
				answers[id] = { type: "choice", choice: options.includes(choice) ? choice : choice, probabilities: {}, confidence: 0.95 };
			} else {
				answers[id] = { type: "noul", noul: 0.9 };
			}
		}
		return { answers };
	};

	const contract = fixtureContract({ complexity: "MEDIUM", executor_class: "balanced", required: { min_coding_index: 70, specialization: "typescript" } });

	it("is unchanged by the fallbacks and issues zero JEV calls when the sites are off", async () => {
		const { client, stub, config, cwd } = await withStubJev(namedChoice("py-model"), {
			tie_band_usd: 0.05,
			sites: { "routing.quota_preference": false, "routing.reasoning_effort": false, "routing.delegation_worth": false },
		});
		const decision = await selectRoute({ contract, config, cwd, history: HISTORY, client, slices: 3 });
		expect(stub.requests).toHaveLength(0);
		// The specialist still wins on the deterministic path, at the table's effort, inline-or-not by slices.
		expect(decision.selected?.candidate.id).toBe("ts-model");
		expect(decision.effort).toBe("medium");
		expect(decision.effort_source).toBe("fallback");
		expect(decision.delegation).toBe("delegate");
		expect(decision.delegation_source).toBe("fallback");
		for (const row of decision.telemetry) expect(row.fallback_used).toBe(true);
	});

	it("reorders inside the tie band when the site is enabled and confident", async () => {
		const { client, stub, config, cwd } = await withStubJev(namedChoice("generic-model"), {
			tie_band_usd: 0.05,
			sites: { "routing.quota_preference": true, "routing.reasoning_effort": false, "routing.delegation_worth": false },
		});
		const decision = await selectRoute({ contract, config, cwd, history: HISTORY, client, slices: 1 });
		expect(stub.requests).toHaveLength(1);
		expect(decision.finalists).toContain("generic-model");
		expect(decision.selected?.candidate.id).toBe("generic-model");
		const row = decision.telemetry.find((entry) => entry.site_id === "routing.quota_preference");
		expect(row).toMatchObject({ answer: "generic-model", fallback_used: false });
	});

	it("ignores an answer naming a candidate outside the clearing set", async () => {
		const { client, stub, config, cwd } = await withStubJev(namedChoice("not-a-candidate"), {
			tie_band_usd: 0.05,
			sites: { "routing.quota_preference": true, "routing.reasoning_effort": false, "routing.delegation_worth": false },
		});
		const decision = await selectRoute({ contract, config, cwd, history: HISTORY, client, slices: 1 });
		expect(stub.requests).toHaveLength(1);
		expect(decision.selected?.candidate.id).toBe(decision.finalists[0]);
		expect(decision.telemetry.find((entry) => entry.site_id === "routing.quota_preference")?.fallback_used).toBe(true);
	});

	it("takes the registered fallback when the client itself falls back", async () => {
		const { client, config, cwd } = await withStubJev(namedChoice("py-model"), {
			tie_band_usd: 0.05,
			sites: { "routing.quota_preference": true, "routing.reasoning_effort": true, "routing.delegation_worth": true },
		});
		// JEV off at the client: every site resolves through its own registered fallback.
		client.setMode("disabled");
		const decision = await selectRoute({ contract, config, cwd, history: HISTORY, client, slices: 3 });
		expect(decision.selected?.candidate.id).toBe(decision.finalists[0]);
		expect(decision.effort).toBe("medium");
		expect(decision.delegation).toBe("delegate");
		for (const row of decision.telemetry) expect(row.fallback_used).toBe(true);
	});

	it("escalates with a recorded capability gap and dispatches nothing when no model clears", async () => {
		const { client, stub, config, cwd } = await withStubJev(namedChoice("generic-model"), {
			sites: { "routing.quota_preference": true, "routing.reasoning_effort": true, "routing.delegation_worth": true },
		});
		const impossible = fixtureContract({ complexity: "HIGH", executor_class: "strong", required: { min_coding_index: 99 } });
		const decision = await selectRoute({ contract: impossible, config, cwd, history: HISTORY, client, slices: 3 });
		expect(stub.requests).toHaveLength(0);
		expect(decision.selected).toBeNull();
		expect(decision.candidates).toEqual([]);
		expect(decision.route_cost).toBeNull();
		expect(decision.capability_gap).toMatchObject({ requested: 99 });
		expect(decision.escalation).toBe("USER_INPUT");
		expect(decision.reason).toContain("capability_gap");
	});
});
