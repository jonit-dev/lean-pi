/**
 * PRD-013 Phase 3 / AC-5, AC-6 — limits and the two stops a user can trigger.
 *
 * The risk this covers is a budget check that runs *after* inference has already
 * been paid for, and an unsatisfiable clause that burns the whole budget instead
 * of being named once.
 */
import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../src/commands/registry.js";
import { createGoalStore, evaluateGoal, registerGoalCommands, runGoalLoop, sessionCost, type GoalBoundaryDeps } from "../../src/goal/index.js";
import { appendRun } from "../../src/telemetry/store.js";
import type { RunTelemetry } from "../../src/telemetry/record.js";
import { EvidenceStore } from "../../src/verify/evidence.js";
import { HASH, fixtureCwd, goalConfig, newGoal, record, throwingJev, todos } from "./helpers.js";

/**
 * The two fields PRD-015's reader requires of a row plus the one a limit reads:
 * `task_id`, `session_id` and the stored `cost.effective_cost`.
 */
function runWithCost(cost: number): RunTelemetry {
	return {
		task_id: "fixture-task",
		session_id: "fixture-session",
		usage: {},
		cost: { effective_cost: cost },
	} as unknown as RunTelemetry;
}

function failingEvidence(): EvidenceStore {
	const store = new EvidenceStore();
	record(store, { kind: "targeted_test", status: "fail" });
	return store;
}

describe("PRD-013 Phase 3 — limits and stop conditions", () => {
	it("AC-5: max_turns stops the second boundary with BUDGET_EXCEEDED and deactivates the goal", async () => {
		const cwd = fixtureCwd();
		const goals = createGoalStore(cwd);
		const { jev, calls } = throwingJev();
		const deps: GoalBoundaryDeps = {
			workspaceHash: HASH,
			evidence: failingEvidence(),
			jev,
			goals,
			cwd,
			// Even with actionable work, the cap wins: the limit check runs before
			// any evidence refresh or JEV call.
			todos: todos([{ id: "t1", text: "keep working" }]),
		};

		const goal = newGoal("targeted tests pass", { max_turns: 2 });
		const first = await evaluateGoal(goal, deps);
		expect(first.decision).toBe("continue");
		expect(first.turns_used).toBe(1);

		const second = await evaluateGoal(first.state, deps);
		expect(second.stop).toBe("BUDGET_EXCEEDED");
		expect(second.reason).toContain("turns 2/2");
		expect(second.state.active).toBe(false);
		expect(calls()).toBe(0);
		expect(goals.load()).toEqual(second.state);

		// A stopped goal takes no further automatic turn.
		let turns = 0;
		const after = await runGoalLoop(goal, { ...deps, turn: async () => { turns += 1; } });
		expect(turns).toBe(0);
		expect(after.turns).toBe(1);
		expect(after.final.stop).toBe("USER_STOPPED");
	});

	it("AC-5: accumulated telemetry cost past max_cost stops the next boundary, with JEV stubbed to throw", async () => {
		const cwd = fixtureCwd();
		appendRun(cwd, runWithCost(5));
		expect(sessionCost(cwd)).toBe(5);
		const { jev, calls } = throwingJev();

		const evaluation = await evaluateGoal(newGoal("targeted tests pass", { max_cost: 1 }), {
			workspaceHash: HASH,
			evidence: failingEvidence(),
			jev,
			cwd,
			todos: todos([{ id: "t1", text: "keep working" }]),
		});

		expect(evaluation.stop).toBe("BUDGET_EXCEEDED");
		expect(evaluation.reason).toContain("cost $5.00/$1.00");
		expect(evaluation.state.active).toBe(false);
		expect(calls()).toBe(0);
	});

	it("AC-6: /goal stop lands as USER_STOPPED mid-loop and takes no further turn", async () => {
		const cwd = fixtureCwd();
		const registry = createCommandRegistry();
		registerGoalCommands(registry, { cwd, config: goalConfig(cwd), costSoFar: () => 0 });
		await registry.dispatch("/goal targeted tests pass --max-turns 5", { cwd });
		const goals = createGoalStore(cwd);

		let turns = 0;
		const result = await runGoalLoop(goals.load()!, {
			workspaceHash: HASH,
			evidence: failingEvidence(),
			jev: throwingJev().jev,
			goals,
			cwd,
			todos: todos([{ id: "t1", text: "keep working" }]),
			turn: async () => {
				turns += 1;
				await registry.dispatch("/goal stop", { cwd });
			},
		});

		expect(turns).toBe(1);
		expect(result.turns).toBe(2);
		expect(result.final.stop).toBe("USER_STOPPED");
		expect(goals.load()!.active).toBe(false);
	});

	it("AC-6: a clause naming an unproducible verification kind is GOAL_IMPOSSIBLE, named once, without inference", async () => {
		const { jev, calls } = throwingJev();
		const evaluation = await evaluateGoal(newGoal("the browser_test passes"), {
			workspaceHash: HASH,
			jev,
			todos: todos([{ id: "t1", text: "keep working" }]),
		});

		expect(evaluation.stop).toBe("GOAL_IMPOSSIBLE");
		expect(evaluation.reason).toContain("the browser_test passes");
		expect(evaluation.reason).toContain("browser_test");
		expect(evaluation.state.active).toBe(false);
		expect(calls()).toBe(0);
	});
});
