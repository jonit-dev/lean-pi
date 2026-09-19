/**
 * PRD-013 Phase 4 / AC-7 — the PRD-derived goal.
 *
 * The risks this covers are a snapshot-once derivation that ignores a criterion
 * PRD-012 reopens, a criterion that "stays met" because one record said `pass`
 * while another said `fail`, and a bare `/goal` inventing a goal when nothing
 * can be derived.
 */
import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../src/commands/registry.js";
import {
	createGoalStore,
	evaluateGoal,
	prdGoalSource,
	registerGoalCommands,
	splitClauses,
	type GoalBoundaryDeps,
} from "../../src/goal/index.js";
import { createPrdState, readPrdState, transitionCriterion, writePrdState } from "../../src/prd/state.js";
import { EvidenceStore } from "../../src/verify/evidence.js";
import { HASH, fixtureCwd, goalConfig, newGoal, record, throwingJev } from "./helpers.js";

const CRITERIA = ["AC-1", "AC-2", "AC-3"] as const;

const PRD_BODY = `# PRD-101 — Goal fixture

## Acceptance Criteria

- [ ] AC-1 [local; actor: agent]: the cache returns a hit after a warm — verification: \`npx vitest run tests/prd/cache.spec.ts\`
- [ ] AC-2 [local; actor: agent]: the metrics counter increments — verification: \`npx vitest run tests/prd/metrics.spec.ts\`
- [ ] AC-3 [local; actor: agent]: the docs list the flag — verification: \`npx vitest run tests/prd/docs.spec.ts\`
`;

function stagedPrd(cwd: string): void {
	writePrdState(
		cwd,
		createPrdState({
			prdId: "PRD-101",
			prdPath: "docs/PRDs/v1/PRD-101-goal-fixture.md",
			body: PRD_BODY,
			artifactRef: "artifact://prd/101",
			skillSource: "builtin-fallback",
			requiredCapability: { min_coding_index: 20 },
		}),
	);
}

/** Every criterion verified, as PRD-012 records a criterion whose evidence passed. */
function verifyAll(cwd: string): void {
	const state = readPrdState(cwd)!;
	for (const id of CRITERIA) {
		transitionCriterion(state, id, { status: "VERIFIED", evidenceRef: `artifact://evidence/${id}` });
	}
	writePrdState(cwd, state);
}

/** A fresh pass attributed to one criterion, over the criterion's own command surface. */
function pass(store: EvidenceStore, id: string, scope: string): void {
	record(store, { kind: "targeted_test", status: "pass", criterion: [id], scope });
}

describe("PRD-013 Phase 4 — the PRD-derived goal", () => {
	it("AC-7: bare /goal derives exactly the remaining criteria, and meets the goal only when all pass", async () => {
		const cwd = fixtureCwd();
		stagedPrd(cwd);
		const registry = createCommandRegistry();
		registerGoalCommands(registry, { cwd, config: goalConfig(cwd), prd: () => readPrdState(cwd), costSoFar: () => 0 });

		const derived = await registry.dispatch("/goal", { cwd });
		expect(derived.ok).toBe(true);
		for (const id of CRITERIA) expect(derived.text).toContain(id);

		const goal = createGoalStore(cwd).load()!;
		const clauses = splitClauses(goal.text);
		expect(clauses.map((clause) => clause.criterion)).toEqual([...CRITERIA]);
		expect(clauses.every((clause) => clause.kind === "machine")).toBe(true);

		const { jev, calls } = throwingJev();
		const store = new EvidenceStore();
		pass(store, "AC-1", "npx vitest run tests/prd/cache.spec.ts");
		pass(store, "AC-2", "npx vitest run tests/prd/metrics.spec.ts");
		const deps: GoalBoundaryDeps = {
			workspaceHash: HASH,
			evidence: store,
			prd: prdGoalSource(() => readPrdState(cwd)),
			jev,
		};

		const partial = await evaluateGoal(newGoal(goal.text), deps);
		expect(partial.decision).toBe("continue");
		expect(partial.clauses.map((outcome) => outcome.clause.criterion)).toEqual([...CRITERIA]);
		expect(partial.clauses.find((outcome) => outcome.clause.criterion === "AC-3")!.satisfied).toBe(false);

		pass(store, "AC-3", "npx vitest run tests/prd/docs.spec.ts");
		verifyAll(cwd);
		const met = await evaluateGoal(newGoal(goal.text), deps);
		expect(met.stop).toBe("GOAL_MET");
		// Every criterion was decided by the proof gate over fresh evidence: no
		// inference was bought for a fact ordinary code settles.
		expect(calls()).toBe(0);

		// A criterion PRD-012 reopens re-enters the goal at the next boundary
		// instead of staying met.
		const reopened = readPrdState(cwd)!;
		transitionCriterion(reopened, "AC-2", { status: "REOPENED", reason: "a later measurement disagreed" });
		writePrdState(cwd, reopened);
		const afterReopen = await evaluateGoal(newGoal(goal.text), deps);
		expect(afterReopen.decision).toBe("continue");
		expect(afterReopen.reason).toContain("AC-2");

		// Contradictory evidence keeps the goal running even though PRD-012 still
		// says VERIFIED: sufficiency is the gate's decision, not a raw lookup.
		verifyAll(cwd);
		record(store, {
			kind: "targeted_test",
			status: "fail",
			criterion: ["AC-2"],
			scope: "npx vitest run tests/prd/metrics.spec.ts",
		});
		const contradicted = await evaluateGoal(newGoal(goal.text), deps);
		expect(contradicted.decision).toBe("continue");
		expect(contradicted.reason).toContain("AC-2");
	});

	it("AC-7: with no active PRD, bare /goal prints usage while an explicit goal still runs", async () => {
		const cwd = fixtureCwd();
		const registry = createCommandRegistry();
		registerGoalCommands(registry, { cwd, config: goalConfig(cwd), prd: () => readPrdState(cwd), costSoFar: () => 0 });

		const bare = await registry.dispatch("/goal", { cwd });
		expect(bare.ok).toBe(false);
		expect(bare.text).toContain("no active PRD");
		expect(createGoalStore(cwd).load()).toBeNull();

		const explicit = await registry.dispatch("/goal build passes", { cwd });
		expect(explicit.ok).toBe(true);
		const store = new EvidenceStore();
		record(store, { kind: "build", status: "pass" });

		const evaluation = await evaluateGoal(createGoalStore(cwd).load()!, {
			workspaceHash: HASH,
			evidence: store,
			prd: prdGoalSource(() => readPrdState(cwd)),
			jev: throwingJev().jev,
		});
		expect(evaluation.stop).toBe("GOAL_MET");
	});
});
