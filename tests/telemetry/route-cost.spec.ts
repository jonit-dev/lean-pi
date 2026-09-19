/**
 * BUG_REVIEW F1 — the router's prediction must reach the run record.
 *
 * PRD-020's `route_cost` is a prediction about the identity a run was
 * dispatched at, so it is only meaningful attached to that run's §52 record.
 * The executor lane carries the block on `ExecutorOutcome.route_cost` and the
 * turn entry point writes it; a turn no router decided stays without one, which
 * is what makes the assertion non-vacuous.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearLanes, registerLane } from "../../src/commands/session.js";
import { compileTask } from "../../src/compiler/index.js";
import type { ExecutorOutcome } from "../../src/executor/index.js";
import { createRunCollector } from "../../src/telemetry/collect.js";
import { runTurnWithTelemetry } from "../../src/telemetry/emit.js";
import type { RouteCostBlock } from "../../src/telemetry/record.js";
import { readRuns } from "../../src/telemetry/store.js";
import { fixtureConfig } from "./fixture.js";

const REQUEST = "wire the adaptive router into the executor lane";

const PACKET = {
	repository: { languages: ["typescript"], project_type: "single", package_manager: "pnpm", dirty: false },
	task: { user_request: REQUEST },
	workspace: { changed_files: ["src/routing/router.ts"], likely_modules: ["src/routing"], test_runners: ["vitest"], lsp_available: false, git_branch: "main" },
};

/** The five §26 terms the router predicted for the identity that ran. */
const PREDICTED: RouteCostBlock = { monetary: 0.5, quota_shadow: 0.25, local_compute: 0, latency: 0.125, predicted_retry: 0.1 };

function workspace(): string {
	const cwd = mkdtempSync(join(tmpdir(), "leanpi-route-cost-"));
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "route-cost", version: "1.0.0" }));
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Fixture"], { cwd });
	execFileSync("git", ["add", "-A"], { cwd });
	execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd });
	return cwd;
}

/** One lane stands in for the executor: it compiles the contract, then reports what it did. */
function laneWith(executor: Partial<ExecutorOutcome> | undefined): void {
	clearLanes();
	registerLane({
		name: "fixture.executor",
		async run(turn, context) {
			context.contract = await compileTask(turn.text, PACKET);
			if (executor) context.executor = executor as unknown as ExecutorOutcome;
		},
	});
}

afterEach(() => clearLanes());

describe("F1 — the routed prediction is persisted with the run it decided", () => {
	it("writes the executor's route_cost block onto the turn's record", async () => {
		const cwd = workspace();
		laneWith({ route_cost: PREDICTED });
		const collector = createRunCollector({ taskId: "route-cost", sessionId: "session-1" });
		await runTurnWithTelemetry(
			{ text: REQUEST },
			{ config: fixtureConfig(cwd), cwd },
			{ collector, verdict: { verification: "pass", proof_gate: "pass", reviewer: "pass", success: true } },
		);
		const record = readRuns(cwd).at(-1) as unknown as Record<string, unknown> | undefined;
		expect(record?.route_cost).toEqual(PREDICTED);
	});

	it("leaves the block absent when no router decided the turn", async () => {
		const cwd = workspace();
		laneWith(undefined);
		const collector = createRunCollector({ taskId: "no-route", sessionId: "session-2" });
		await runTurnWithTelemetry(
			{ text: REQUEST },
			{ config: fixtureConfig(cwd), cwd },
			{ collector, verdict: { verification: "pass", proof_gate: "pass", reviewer: "pass", success: true } },
		);
		const record = readRuns(cwd).at(-1) as unknown as Record<string, unknown> | undefined;
		expect(record).toBeDefined();
		expect(record?.route_cost).toBeUndefined();
	});
});
