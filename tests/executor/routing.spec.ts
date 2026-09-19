/**
 * BUG_REVIEW F1 — the adaptive router decides what the executor dispatches.
 *
 * PRD-020's `selectRoute()` had no caller: the lane resolved a role through the
 * backend registry and the advertised cost-aware choice never ran. These cases
 * drive `runExecutor` with a clearing source of its own (the bundled ranking is
 * PRD-024's concern, not this wiring's) and assert the two halves of the fix:
 * the cheapest clearing candidate is the identity that reaches the worker, and
 * a capability gap leaves the pool's chain in charge while still being recorded.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackendRegistry } from "../../src/backends/index.js";
import type { WorkerTaskPacket, WorkerTurnOutcome } from "../../src/backends/worker.js";
import type { RunWorkerTurnOptions } from "../../src/backends/registry.js";
import type { ExecutionContract } from "../../src/compiler/contract.js";
import { loadConfig } from "../../src/core/config.js";
import type { LeanPiConfig, ModelRole } from "../../src/core/types.js";
import { runExecutor, ROUTE_SITE_ID } from "../../src/executor/index.js";
import type { ClearingSource } from "../../src/routing/candidates.js";
import type { ReviewRunner } from "../../src/review/lane.js";
import type { RouteCandidate } from "../../src/routing/cost.js";
import { fakeExec, VERIFY_COMMANDS } from "./helpers.js";
import { tempDir } from "../helpers/fixtures.js";

/** A workspace with a git repository, so the verifier's dirty check has something to read. */
function workspace(): string {
	const cwd = tempDir("leanpi-route-");
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "routed", version: "1.0.0" }));
	writeFileSync(join(cwd, "src", "target.ts"), "export const value = 1;\n");
	for (const argv of [
		["init", "-q", "-b", "main"],
		["config", "user.email", "fixture@example.com"],
		["config", "user.name", "Fixture"],
		["add", "-A"],
		["commit", "-q", "-m", "fixture"],
	]) {
		execFileSync("git", argv, { cwd });
	}
	return cwd;
}

/** Two reachable backends, so "the routed one ran" is a choice and not the only option. */
function twoBackendConfig(cwd: string): LeanPiConfig {
	return loadConfig(cwd, {
		configPath: null,
		backends: {
			local: { type: "native", baseUrl: "http://127.0.0.1:1/v1", model: "mid" },
			premium: { type: "native", baseUrl: "http://127.0.0.1:2/v1", model: "big" },
		},
		models: {
			quick: { backend: "local", model: "cheap" },
			balanced: { backend: "local", model: "mid" },
			strong: { backend: "premium", model: "big" },
		},
	});
}

function candidate(backend: string, model: string, price: number, roles: ModelRole[]): RouteCandidate {
	return {
		id: `${backend}/${model}`,
		backend,
		model,
		billing: "metered",
		quota_class: null,
		coding_score: 90,
		price_input_per_mtok: price,
		price_output_per_mtok: price,
		roles,
		priority: 0,
	};
}

const CONTRACT: ExecutionContract = {
	task: {
		type: "bugfix",
		prd_required: false,
		planning_decision: "DIRECT_EXECUTION",
		execution_complexity: "MEDIUM",
		review_risk: "R0",
		required_capability: { min_coding_index: 70 },
		user_request: "fix the off-by-one",
		objective: "fix the off-by-one",
		acceptance_criteria: [{ id: "AC-1", text: "fix the off-by-one" }],
	},
	routing: { executor_class: "balanced", executor_backend: "unresolved", reviewer_class: "none" },
	reasoning: { effort: "medium" },
	capabilities: { skills: [], mcps: [], lsp: false, rtk: "off" },
	context: { strategy: "targeted", budget_tokens: 12_000 },
	verification: { required: ["typecheck"] },
	limits: { execution_attempts: 1, max_escalations: 1, semantic_review_rounds: 0, isolation: "none" },
};

interface Dispatch {
	packet: WorkerTaskPacket;
	options: RunWorkerTurnOptions;
}

/** A worker that edits a real file, so the verifier sees a workspace change. */
function recordingWorker(cwd: string, seen: Dispatch[]): (packet: WorkerTaskPacket, options: RunWorkerTurnOptions) => Promise<WorkerTurnOutcome> {
	return async (packet, options) => {
		seen.push({ packet, options });
		writeFileSync(join(cwd, "src", "target.ts"), `export const value = ${seen.length + 1};\n`);
		return { status: "completed", backend: "local", result: { status: "ok", changedFiles: ["src/target.ts"], summary: "edited" }, attempts: [] };
	};
}

/** PRD-011's floor reviews even a `reviewer_class: none` contract; this answers it. */
const REVIEW_PASSES: ReviewRunner = async () => ({ status: "ok", changedFiles: [], summary: JSON.stringify({ decision: "PASS", findings: [] }) });

describe("F1 — the executor dispatches the identity the router chose", () => {
	it("pins the cheapest clearing candidate and holds the rest of the pool out", async () => {
		const cwd = workspace();
		const config = twoBackendConfig(cwd);
		const seen: Dispatch[] = [];
		// `premium/big` is the role map's `strong` binding and the expensive one;
		// `local/cheap` clears the same bar for less, so the router must pick it.
		const clearing: ClearingSource = () => ({
			candidates: [candidate("premium", "big", 30, ["strong"]), candidate("local", "cheap", 1, ["quick"])],
		});

		const outcome = await runExecutor(CONTRACT, {
			registry: new BackendRegistry(config),
			cwd,
			config,
			clearing,
			worker: recordingWorker(cwd, seen),
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
			reviewRunner: REVIEW_PASSES,
		});

		expect(outcome.status).toBe("completed");
		expect(seen).toHaveLength(1);
		expect(seen[0]!.packet.model).toBe("cheap");
		expect(seen[0]!.options.exclude).toContain("premium");
		expect(seen[0]!.options.exclude).not.toContain("local");
		// The prediction that decided it is recorded with the run (§26's five terms).
		expect(outcome.route_cost).toBeDefined();
		expect(outcome.route_cost!.monetary).toBeGreaterThan(0);
		expect(outcome.sites.find((row) => row.site === ROUTE_SITE_ID)).toMatchObject({ answer: "local/cheap", fallbackUsed: false });
	});

	it("records a capability gap instead of silently bypassing the choice", async () => {
		const cwd = workspace();
		const config = twoBackendConfig(cwd);
		const seen: Dispatch[] = [];
		const clearing: ClearingSource = ({ required }) => ({
			candidates: [],
			capability_gap: { requested: required.min_coding_index, best_available: 40, reason: "no ranked model cleared the required coding floor" },
		});

		const outcome = await runExecutor(CONTRACT, {
			registry: new BackendRegistry(config),
			cwd,
			config,
			clearing,
			worker: recordingWorker(cwd, seen),
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
			reviewRunner: REVIEW_PASSES,
		});

		// The turn still runs on the pool's own chain — an unranked model is not a
		// reason to refuse work — but the row says the router did not decide it.
		expect(outcome.status).toBe("completed");
		expect(seen[0]!.packet.model).toBeUndefined();
		expect(seen[0]!.options.exclude).toEqual([]);
		expect(outcome.route_cost).toBeUndefined();
		const row = outcome.sites.find((entry) => entry.site === ROUTE_SITE_ID);
		expect(row?.fallbackUsed).toBe(true);
		expect(String(row?.answer)).toContain("capability_gap");
	});
});
