/**
 * PRD-010 Phase 2 (E2): the enum→action mapping, the bounded gathering loop and
 * the §41 escalation ladder — AC-4, AC-5.
 */
import { describe, expect, it } from "vitest";
import { BackendRegistry } from "../../src/backends/index.js";
import { createJevClient, type JevClient } from "../../src/jev/client.js";
import { GAP_ACTIONS } from "../../src/proof/actions.js";
import { evaluateProofGate, type ProofOutcome } from "../../src/proof/gate.js";
import { criteriaOf } from "../../src/proof/packet.js";
import { escalateLadder, recover, type ProofReview } from "../../src/proof/recover.js";
import { review, type ReviewDeps } from "../../src/review/lane.js";
import type { ReviewPacket } from "../../src/review/schema.js";
import { registerVerifier, shellVerifier, verifierOutcome } from "../../src/verify/descriptors.js";
import type { ExecutionContract } from "../../src/compiler/contract.js";
import type { LeanPiConfig } from "../../src/core/types.js";
import { answerScript } from "../compiler/helpers.js";
import { startStubJev } from "../helpers/stub-jev.js";
import { tempDir } from "../helpers/fixtures.js";
import {
	FIXTURE_CWD,
	FIXTURE_HASH,
	choiceMap,
	gatherAttempts,
	proofConfig,
	proofContract,
	reviewAttempts,
	reviewSpy,
	storeOf,
	type ChoiceScript,
} from "./support.js";

async function scriptedClient(script: ChoiceScript): Promise<{ client: JevClient; close(): Promise<void> }> {
	const stub = await startStubJev([answerScript({ choices: choiceMap(script) })]);
	const cwd = tempDir("leanpi-proof-recover-jev-");
	return {
		client: createJevClient({ config: proofConfig(cwd, "enabled", { endpoint: stub.url, apiKey: "test-key" }), cwd }),
		close: () => stub.close(),
	};
}

const AFFIRMATIVE: ChoiceScript = {
	demonstrates: "YES",
	contradiction: "NO",
	staticForRuntime: "NO",
	unevidencedPath: "NO",
};

/** A criterion whose runtime evidence is the only thing missing. */
const runtimeVerification = {
	required: ["targeted_test", "runtime_smoke"],
	criteria: [{ id: "AC-1", verifiers: ["targeted_test", "runtime_smoke"], scope: "tests/proof/runtime.test.ts" }],
};
const runtimePassed = {
	kind: "targeted_test",
	status: "pass" as const,
	criterion: ["AC-1"],
	scope: "tests/proof/runtime.test.ts",
};
const OUTCOME: ProofOutcome = { workspaceHash: FIXTURE_HASH, changedFiles: ["src/runtime.ts"], summary: "runtime change" };

describe("AC-4 — a gap answer runs the mapped verifier", () => {
	it("runs runtime_smoke for RUNTIME_TEST_REQUIRED, records it, and re-enters the gate to PASS", async () => {
		// PRD-022 owns this kind in production; a real shell verifier stands in so
		// the round spawns a command and produces a record rather than a call count.
		registerVerifier("runtime_smoke", shellVerifier(""));
		const contract = proofContract(runtimeVerification, 1);
		const store = storeOf(FIXTURE_HASH, [runtimePassed]);
		const scripted = await scriptedClient({ ...AFFIRMATIVE, gap: "RUNTIME_TEST_REQUIRED" });
		try {
			const result = await evaluateProofGate(criteriaOf(contract), OUTCOME, {
				contract,
				store,
				jev: scripted.client,
				cwd: FIXTURE_CWD,
				commands: { runtime_smoke: "printf runtime-ok" },
			});

			const gathered = gatherAttempts(result.attempts);
			expect(gathered).toHaveLength(1);
			expect(gathered[0]!.command).toBe("printf runtime-ok");
			expect(gathered[0]!.criterion).toBe("AC-1");
			expect(result.rounds).toBe(1);
			expect(result.actions[0]!.round).toBe(1);

			const recorded = store.forCriterion("AC-1").filter((record) => record.kind === "runtime_smoke");
			expect(recorded).toHaveLength(1);
			expect(recorded[0]!.status).toBe("pass");
			expect(recorded[0]!.criterion).toEqual(["AC-1"]);
			expect(result.criteria[0]!.coverage.satisfied).toBe(true);
			expect(result.decision).toBe("PASS");
		} finally {
			await scripted.close();
		}
	});

	it("runs no verifier when the answer is NONE", async () => {
		const contract = proofContract(runtimeVerification, 1);
		const store = storeOf(FIXTURE_HASH, [runtimePassed]);
		const scripted = await scriptedClient({ ...AFFIRMATIVE, gap: "NONE" });
		try {
			const result = await evaluateProofGate(criteriaOf(contract), OUTCOME, {
				contract,
				store,
				jev: scripted.client,
				cwd: FIXTURE_CWD,
				commands: { runtime_smoke: "printf runtime-ok" },
			});

			expect(result.decision).not.toBe("PASS");
			expect(gatherAttempts(result.attempts)).toEqual([]);
			expect(result.rounds).toBe(0);
			expect(result.actions[0]!.action.executor).toBe("none");
			expect(store.current(FIXTURE_HASH).map((record) => record.kind)).toEqual(["targeted_test"]);
		} finally {
			await scripted.close();
		}
	});
});

describe("AC-5 — the loop is bounded and terminates on the ladder", () => {
	const verification = { required: ["runtime_smoke"], criteria: [{ id: "AC-2", verifiers: ["runtime_smoke"] }] };
	const script = { ...AFFIRMATIVE, gap: "RUNTIME_TEST_REQUIRED" } as const;
	const spy = () => reviewSpy({ QUICK_REVIEW: "FIX_REQUIRED", STRONG_REVIEW: "ESCALATE" });

	it("spends exactly semantic_review_rounds rounds, then walks QUICK_REVIEW → STRONG_REVIEW → BLOCKED", async () => {
		// PRD-022's facility is absent here, so every round is a real attempt that
		// measures nothing: the evidence stays short and the ladder is the only way
		// left. Registered explicitly so this case cannot depend on test order.
		registerVerifier("runtime_smoke", { run: async (descriptor) => verifierOutcome(descriptor, "not_run") });
		const contract = proofContract(verification, 2);
		const store = storeOf(FIXTURE_HASH, []);
		const reviewer = spy();
		const scripted = await scriptedClient(script);
		try {
			const result = await evaluateProofGate(criteriaOf(contract), OUTCOME, {
				contract,
				store,
				jev: scripted.client,
				review: reviewer.review,
				cwd: FIXTURE_CWD,
			});

			const gathered = gatherAttempts(result.attempts);
			expect(result.rounds).toBe(2);
			expect(gathered).toHaveLength(2);
			// Each round ran the mapped verifier; with no runner registered for it the
			// attempt is a real `not_run` record, which is why the evidence stays short.
			expect(gathered.map((attempt) => attempt.status)).toEqual(["not_run", "not_run"]);
			expect(reviewAttempts(result.attempts).map((attempt) => [attempt.level, attempt.decision])).toEqual([
				["QUICK_REVIEW", "FIX_REQUIRED"],
				["STRONG_REVIEW", "ESCALATE"],
			]);
			expect(reviewer.levels).toEqual(["QUICK_REVIEW", "STRONG_REVIEW"]);

			expect(result.decision).toBe("BLOCKED");
			const criterion = result.criteria[0]!;
			expect(criterion.decision).toBe("BLOCKED");
			expect(criterion.reasons.join(" ")).toContain("AC-2");
			expect(criterion.reasons.join(" ")).toContain("RUNTIME_TEST_REQUIRED");

			// The ladder added no record: every record in the store came from a round.
			expect(store.current(FIXTURE_HASH)).toHaveLength(gathered.length);
		} finally {
			await scripted.close();
		}
	});

	it("performs zero rounds with semantic_review_rounds: 0, whatever maxAttempts says", async () => {
		const contract = proofContract(verification, 0);
		const store = storeOf(FIXTURE_HASH, []);
		const reviewer = spy();
		const scripted = await scriptedClient(script);
		// The integration pass adds `proof` to `LeanPiConfig`; if the gate preferred
		// it over the contract's own bound this case would spend five rounds.
		const config = { ...proofConfig(tempDir("leanpi-proof-ms-"), "disabled"), proof: { maxAttempts: 5 } } as LeanPiConfig;
		try {
			const result = await evaluateProofGate(criteriaOf(contract), OUTCOME, {
				contract,
				store,
				jev: scripted.client,
				review: reviewer.review,
				config,
				cwd: FIXTURE_CWD,
			});

			expect(result.rounds).toBe(0);
			expect(gatherAttempts(result.attempts)).toEqual([]);
			expect(reviewAttempts(result.attempts).map((attempt) => attempt.level)).toEqual(["QUICK_REVIEW", "STRONG_REVIEW"]);
			expect(result.decision).toBe("BLOCKED");
			expect(store.current(FIXTURE_HASH)).toEqual([]);
		} finally {
			await scripted.close();
		}
	});

	it("falls back to the config default only when the contract omits the bound", async () => {
		registerVerifier("runtime_smoke", { run: async (descriptor) => verifierOutcome(descriptor, "not_run") });
		const contract = proofContract(verification, 2);
		// The §8 contract's own field removed: `LeanPiConfig.proof.maxAttempts` is
		// the compiler-side default PRD-010 documents for exactly this case.
		delete (contract.limits as { semantic_review_rounds?: number }).semantic_review_rounds;
		const store = storeOf(FIXTURE_HASH, []);
		const reviewer = spy();
		const scripted = await scriptedClient(script);
		const config = { ...proofConfig(tempDir("leanpi-proof-ms-"), "disabled"), proof: { maxAttempts: 1 } } as LeanPiConfig;
		try {
			const result = await evaluateProofGate(criteriaOf(contract), OUTCOME, {
				contract,
				store,
				jev: scripted.client,
				review: reviewer.review,
				config,
				cwd: FIXTURE_CWD,
			});

			expect(result.rounds).toBe(1);
			expect(reviewer.levels).toEqual(["QUICK_REVIEW", "STRONG_REVIEW"]);
			expect(result.decision).toBe("BLOCKED");
		} finally {
			await scripted.close();
		}
	});
});

describe("the round plan", () => {
	it("gathers for a gatherable sibling before ending on an unprovable one", async () => {
		// AC-2 has no verifier mapped at all, so it can only ever end on a review
		// rung. AC-1 can still be measured — the round must go to AC-1 first.
		const contract = proofContract(
			{ required: ["runtime_smoke"], criteria: [{ id: "AC-1", verifiers: ["runtime_smoke"] }, { id: "AC-2" }] },
			1,
		);
		registerVerifier("runtime_smoke", shellVerifier(""));
		const store = storeOf(FIXTURE_HASH, []);
		const scripted = await scriptedClient({ ...AFFIRMATIVE, gap: "RUNTIME_TEST_REQUIRED" });
		try {
			const result = await evaluateProofGate(criteriaOf(contract), OUTCOME, {
				contract,
				store,
				jev: scripted.client,
				cwd: FIXTURE_CWD,
				commands: { runtime_smoke: "printf runtime-ok" },
			});

			// The single round went to the criterion that could still be measured.
			expect(result.actions[0]!.criterion).toBe("AC-1");
			expect(result.rounds).toBe(1);
			expect(result.criteria.find((entry) => entry.id === "AC-1")!.decision).toBe("PASS");
			// AC-2 never had a verifier to run, so once the bound was spent it ended on
			// the ladder — the round was not wasted on a check its contract never named.
			expect(result.criteria.find((entry) => entry.id === "AC-2")!.decision).toBe("BLOCKED");
			expect(result.decision).toBe("BLOCKED");
		} finally {
			await scripted.close();
		}
	});
});

describe("recover — the table is the only dispatch", () => {
	const criterion = { id: "AC-1", required: ["runtime_smoke"] };

	it("runs the ladder for a REVIEW_REQUIRED gap", async () => {
		const reviewer = reviewSpy({ QUICK_REVIEW: "FIX_REQUIRED", STRONG_REVIEW: "FIX_REQUIRED" });
		const outcome = await recover(
			{ criterion, category: "REVIEW_REQUIRED", action: GAP_ACTIONS.REVIEW_REQUIRED, round: 1 },
			{ workspaceHash: FIXTURE_HASH, review: reviewer.review },
		);

		expect(outcome.status).toBe("blocked");
		expect(outcome.record).toBeNull();
		expect(reviewer.levels).toEqual(["QUICK_REVIEW", "STRONG_REVIEW"]);
		expect(outcome.attempts.map((attempt) => attempt.kind)).toEqual(["review", "review"]);
		expect(outcome.reason).toContain("AC-1");
	});

	it("cannot gather without a store", async () => {
		const outcome = await recover(
			{ criterion, category: "RUNTIME_TEST_REQUIRED", action: GAP_ACTIONS.RUNTIME_TEST_REQUIRED, round: 1 },
			{ workspaceHash: FIXTURE_HASH },
		);

		expect(outcome.status).toBe("blocked");
		expect(outcome.attempts).toEqual([]);
		expect(outcome.reason).toContain("store");
	});

	it("blocks a category whose action names no verifier", async () => {
		const outcome = await recover(
			{ criterion, category: "DIFF_INSPECTION_REQUIRED", action: GAP_ACTIONS.DIFF_INSPECTION_REQUIRED, round: 1 },
			{ workspaceHash: FIXTURE_HASH },
		);

		expect(outcome.status).toBe("blocked");
		expect(outcome.reason).toBe(GAP_ACTIONS.DIFF_INSPECTION_REQUIRED.unavailableReason);
	});
});

describe("the §41 ladder", () => {
	it("stops at the first rung that passes", async () => {
		const reviewer = reviewSpy({ QUICK_REVIEW: "PASS" });
		const ladder = await escalateLadder(["AC-1"], { workspaceHash: FIXTURE_HASH, review: reviewer.review });

		expect(reviewer.levels).toEqual(["QUICK_REVIEW"]);
		expect(ladder.attempts).toHaveLength(1);
		expect(ladder.verdicts).toHaveLength(1);
		expect(ladder.reason).toContain("QUICK_REVIEW");
	});

	it("reports an unwired lane instead of pretending to review", async () => {
		const ladder = await escalateLadder(["AC-1"], { workspaceHash: FIXTURE_HASH });

		expect(ladder.attempts).toEqual([]);
		expect(ladder.verdicts).toEqual([]);
		expect(ladder.reason).toContain("no reviewer lane");
	});
});

describe("the lane seam", () => {
	it("accepts PRD-011's review() unchanged at both rungs", async () => {
		// The gate never imports the reviewer lane; this proves the binding it is
		// handed is the lane's own signature, so the integration pass is a closure
		// and not an adapter.
		const calls: string[] = [];
		const config = proofConfig(tempDir("leanpi-proof-lane-"), "disabled");
		const contract: ExecutionContract = proofContract(
			{ required: ["runtime_smoke"], criteria: [{ id: "AC-1", verifiers: ["runtime_smoke"] }] },
			2,
		);
		const deps: ReviewDeps = {
			registry: new BackendRegistry(config),
			cwd: FIXTURE_CWD,
			runner: async () => {
				calls.push("runner");
				return { status: "ok", changedFiles: [], summary: JSON.stringify({ decision: "FIX_REQUIRED", findings: [] }) };
			},
		};
		const packet: ReviewPacket = {
			objective: "prove the criterion",
			acceptance_criteria: [{ id: "AC-1", text: "the criterion holds" }],
			final_diff: "",
			changed_files: ["src/runtime.ts"],
			verification_results: [],
			known_warnings: [],
			executor_summary: "runtime change",
		};
		const binding: ProofReview<ReviewPacket> = {
			packet,
			run: (boundPacket, level, mode) => review(boundPacket, level, mode, deps),
		};
		const store = storeOf(FIXTURE_HASH, []);
		const scripted = await scriptedClient({ ...AFFIRMATIVE, gap: "RUNTIME_TEST_REQUIRED" });
		try {
			const result = await evaluateProofGate(criteriaOf(contract), OUTCOME, {
				contract,
				store,
				jev: scripted.client,
				cwd: FIXTURE_CWD,
				review: binding,
			});

			expect(reviewAttempts(result.attempts).map((attempt) => [attempt.level, attempt.decision])).toEqual([
				["QUICK_REVIEW", "FIX_REQUIRED"],
				["STRONG_REVIEW", "FIX_REQUIRED"],
			]);
			expect(calls).toHaveLength(2);
			expect(result.decision).toBe("BLOCKED");
		} finally {
			await scripted.close();
		}
	});
});
