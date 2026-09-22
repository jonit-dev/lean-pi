/**
 * PRD-013 Phase 2 / AC-2, AC-3, AC-4 — deterministic-first boundary evaluation.
 *
 * The risks this covers are the ones that make a goal engine expensive or
 * dishonest: inference spent on a machine-decidable condition, a JEV fallback
 * that quietly reports completion, and a stalled boundary that spins instead of
 * stopping.
 */
import { describe, expect, it } from "vitest";
import { createJevClient } from "../../src/jev/client.js";
import { readDecisions } from "../../src/jev/log.js";
import {
	GOAL_SEMANTIC_FALLBACK,
	GOAL_SEMANTIC_QUESTION_ID,
	GOAL_SEMANTIC_SITE_ID,
	evaluateGoal,
	registerGoalSites,
	runGoalLoop,
	semanticQuestion,
	splitClauses,
} from "../../src/goal/index.js";
import { EvidenceStore } from "../../src/verify/evidence.js";
import { startStubJev, typedAnswers, type StubJev } from "../helpers/stub-jev.js";
import { HASH, fixtureCwd, goalConfig, newGoal, record, throwingJev, todos } from "./helpers.js";

/** A stub answer for the engine's one question, at a confidence `normal` accepts. */
function answer(choice: string): (body: Record<string, unknown>) => { answers: Record<string, unknown> } {
	return (body) => ({
		answers: typedAnswers(body, {
			[GOAL_SEMANTIC_QUESTION_ID]: {
				type: "choice",
				choice,
				probabilities: { [choice]: 0.95 },
				confidence: 0.95,
			},
		}),
	});
}

describe("PRD-013 Phase 2 — boundary evaluation", () => {
	it("AC-2: an all-machine goal with passing fresh evidence returns GOAL_MET and never calls JEV", async () => {
		const store = new EvidenceStore();
		record(store, { kind: "targeted_test", status: "pass" });
		record(store, { kind: "typecheck", status: "pass" });
		const { jev, calls } = throwingJev();

		const evaluation = await evaluateGoal(newGoal("targeted tests pass and typecheck passes"), {
			workspaceHash: HASH,
			evidence: store,
			jev,
			cwd: fixtureCwd(),
		});

		expect(evaluation.decision).toBe("stop");
		expect(evaluation.stop).toBe("GOAL_MET");
		expect(calls()).toBe(0);
		expect(evaluation.clauses.map((outcome) => outcome.clause.kind)).toEqual(["machine", "machine"]);
		expect(evaluation.clauses.map((outcome) => outcome.source)).toEqual(["evidence", "evidence"]);
	});

	it("AC-3: one semantic clause costs exactly one ask, and the answer flips the outcome", async () => {
		const cwd = fixtureCwd();
		const question = "targeted tests pass and the error message reads naturally to a user";

		const yes = await startStubJev([answer("yes")]);
		try {
			const config = goalConfig(cwd, { jev: { endpoint: yes.url, apiKey: "test-key", mode: "enabled" } });
			const store = new EvidenceStore();
			record(store, { kind: "targeted_test", status: "pass" });

			const met = await evaluateGoal(newGoal(question), {
				workspaceHash: HASH,
				evidence: store,
				jev: createJevClient({ config, cwd }),
				config,
				cwd,
			});

			expect(yes.requests).toHaveLength(1);
			const decisions = readDecisions(cwd);
			expect(decisions).toHaveLength(1);
			expect(decisions[0]!.siteId).toBe(GOAL_SEMANTIC_SITE_ID);
			expect(decisions[0]!.fallbackUsed).toBe(false);
			expect(met.stop).toBe("GOAL_MET");
		} finally {
			await yes.close();
		}

		const noCwd = fixtureCwd();
		const no = await startStubJev([answer("no")]);
		try {
			const config = goalConfig(noCwd, { jev: { endpoint: no.url, apiKey: "test-key", mode: "enabled" } });
			const store = new EvidenceStore();
			record(store, { kind: "targeted_test", status: "pass" });

			const open = await evaluateGoal(newGoal(question), {
				workspaceHash: HASH,
				evidence: store,
				jev: createJevClient({ config, cwd: noCwd }),
				config,
				cwd: noCwd,
			});

			expect(no.requests).toHaveLength(1);
			expect(open.decision).toBe("continue");
			expect(open.stop).toBeNull();
			expect(open.clauses.at(-1)!.satisfied).toBe(false);
		} finally {
			await no.close();
		}
	});

	it("AC-3: with JEV disabled the same goal stops BLOCKED naming the clause, well inside the budget", async () => {
		const cwd = fixtureCwd();
		let stub: StubJev | null = null;
		try {
			stub = await startStubJev([answer("yes")]);
			const config = goalConfig(cwd, { jev: { endpoint: stub.url, apiKey: "test-key", mode: "disabled" } });
			const store = new EvidenceStore();
			record(store, { kind: "targeted_test", status: "pass" });

			const evaluation = await evaluateGoal(newGoal("targeted tests pass and the error message reads naturally to a user", { max_turns: 4 }), {
				workspaceHash: HASH,
				evidence: store,
				jev: createJevClient({ config, cwd }),
				config,
				cwd,
			});

			expect(stub.requests).toHaveLength(0);
			expect(readDecisions(cwd)).toHaveLength(0);
			expect(evaluation.stop).toBe("BLOCKED");
			expect(evaluation.reason).toContain("the error message reads naturally to a user");
			// An undecidable clause is not a reason to spend the rest of the budget.
			expect(evaluation.turns_used).toBeLessThan(4);
		} finally {
			await stub?.close();
		}
	});

	it("AC-4: the loop takes turns with no user input, meets the goal, and stops BLOCKED when no work remains", async () => {
		const store = new EvidenceStore();
		record(store, { kind: "targeted_test", status: "fail" });
		const { jev, calls } = throwingJev();
		let turns = 0;

		const met = await runGoalLoop(newGoal("targeted tests pass"), {
			workspaceHash: HASH,
			evidence: store,
			jev,
			cwd: fixtureCwd(),
			todos: todos([{ id: "t1", text: "fix the failing assertion" }]),
			turn: async () => {
				turns += 1;
				record(store, { kind: "targeted_test", status: "pass" });
			},
		});

		expect(turns).toBe(1);
		expect(met.turns).toBe(2);
		expect(met.evaluations[0]!.decision).toBe("continue");
		expect(met.final.stop).toBe("GOAL_MET");
		expect(calls()).toBe(0);

		// A boundary at which nothing changed and nothing actionable is left stops
		// instead of looping, and names why the work is blocked.
		const stalled = new EvidenceStore();
		record(stalled, { kind: "targeted_test", status: "fail" });
		let extraTurns = 0;
		const cwd = fixtureCwd();
		const blocked = await runGoalLoop(newGoal("targeted tests pass"), {
			workspaceHash: HASH,
			evidence: stalled,
			jev,
			cwd,
			todos: todos([], [{ id: "t1", text: "apply the fix", blockedReason: "needs the owner" }]),
			turn: async () => {
				extraTurns += 1;
			},
		});

		expect(extraTurns).toBe(0);
		expect(blocked.turns).toBe(1);
		expect(blocked.final.stop).toBe("BLOCKED");
		expect(blocked.final.reason).toContain("needs the owner");
	});

	it("AC-3: the site is registered with a non-null deterministic fallback that never reports completion", () => {
		const site = registerGoalSites();
		expect(site.id).toBe(GOAL_SEMANTIC_SITE_ID);
		expect(site.consequence).toBe("normal");
		expect(site.returnType).toEqual(["Choice"]);
		const clause = splitClauses("the error message reads naturally to a user")[0]!;
		const [fallback] = site.fallback({
			siteId: GOAL_SEMANTIC_SITE_ID,
			reason: "no-credential",
			state: {},
			questions: [semanticQuestion(clause)],
		});
		expect(fallback).toMatchObject({ kind: "Choice", questionId: GOAL_SEMANTIC_QUESTION_ID, choice: GOAL_SEMANTIC_FALLBACK });
	});

	it("AC-4: stale evidence never satisfies a clause, so the goal keeps running", async () => {
		const store = new EvidenceStore();
		record(store, { kind: "targeted_test", status: "pass", hash: "hash-before-the-edit" });

		const evaluation = await evaluateGoal(newGoal("targeted tests pass"), { workspaceHash: HASH, evidence: store, todos: todos(), cwd: fixtureCwd() });

		expect(evaluation.decision).toBe("stop");
		expect(evaluation.stop).toBe("BLOCKED");
		expect(evaluation.reason).toContain("no fresh passing targeted_test evidence");
	});
});
