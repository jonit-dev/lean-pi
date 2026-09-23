/**
 * PRD-050 G3 — the executor clarification path, driven through the real lane.
 *
 * A `USER_INPUT` escalation asks JEV whether the ambiguity is material: `ask`
 * blocks with `outcome.question`, `proceed` blocks with `outcome.assumption`
 * recorded instead. Both cases run `runExecutor` end to end, so the asserted
 * fields are the ones a real turn reports.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerTurnOutcome } from "../../src/backends/worker.js";
import {
	CLARIFICATION_SITE_ID,
	ESCALATION_SITE_ID,
	FAILURE_SITE_ID,
	RETRY_SITE_ID,
	RETRY_USEFULNESS_THRESHOLD,
	runExecutor,
} from "../../src/executor/index.js";
import type { ExecutorWorker } from "../../src/executor/lane.js";
import type { ExecutionContract } from "../../src/compiler/contract.js";
import { choice, fakeExec, harness, multiBackendConfig, quickContract, score, scriptedJev, VERIFY_COMMANDS, type ExecHarness } from "./helpers.js";

const open: ExecHarness[] = [];

afterEach(async () => {
	while (open.length > 0) await open.pop()?.close();
});

/** A contract that fails the same verifier twice, so the repeat reaches the escalation gate. */
async function failingContract(h: ExecHarness): Promise<ExecutionContract> {
	const base = await quickContract(h, "fix the failing check");
	return {
		...base,
		task: { ...base.task, prd_required: false, execution_complexity: "LOW", review_risk: "R0" },
		routing: { ...base.routing, executor_class: "quick", reviewer_class: "none" },
		verification: { required: ["typecheck", "affected_tests"] },
		limits: { ...base.limits, execution_attempts: 4, max_escalations: 3 },
	};
}

/** A worker that always edits, so every attempt reaches the verifiers and fails identically. */
function editingWorker(cwd: string): ExecutorWorker {
	return async () => {
		writeFileSync(join(cwd, "src", "target.ts"), "export const value = 2;\n");
		return { status: "completed", backend: "first", result: { status: "ok", changedFiles: ["src/target.ts"], summary: "edited" }, attempts: [] } satisfies WorkerTurnOutcome;
	};
}

async function runClarification(h: ExecHarness, contract: ExecutionContract, clarification: string) {
	return runExecutor(contract, {
		registry: h.registry,
		cwd: h.cwd,
		config: h.config,
		store: h.store,
		artifacts: h.artifacts,
		jev: scriptedJev({
			[ESCALATION_SITE_ID]: () => choice("escalation_category", "USER_INPUT"),
			[FAILURE_SITE_ID]: () => choice("failure_category", "likely_logic_bug"),
			[RETRY_SITE_ID]: () => score("retry_useful", RETRY_USEFULNESS_THRESHOLD + 1),
			[CLARIFICATION_SITE_ID]: () => choice("clarify", clarification),
		}),
		worker: editingWorker(h.cwd),
		exec: fakeExec({ pass: false }),
		verifyCommands: VERIFY_COMMANDS,
	});
}

describe("PRD-050 G3 — the USER_INPUT clarification path", () => {
	it("ask blocks with outcome.question carrying the objective", async () => {
		const h = await harness({ config: multiBackendConfig });
		open.push(h);
		const outcome = await runClarification(h, await failingContract(h), "ask");

		expect(outcome.status).toBe("blocked");
		expect(outcome.escalations).toEqual(["USER_INPUT"]);
		expect(outcome.question).toContain("fix the failing check");
		expect(outcome.question).toContain("needs clarification");
		expect(outcome.assumption).toBeUndefined();
	});

	it("proceed blocks with outcome.assumption recorded and no question", async () => {
		const h = await harness({ config: multiBackendConfig });
		open.push(h);
		const outcome = await runClarification(h, await failingContract(h), "proceed");

		expect(outcome.status).toBe("blocked");
		expect(outcome.escalations).toEqual(["USER_INPUT"]);
		expect(outcome.assumption).toContain("fix the failing check");
		expect(outcome.question).toBeUndefined();
	});
});
