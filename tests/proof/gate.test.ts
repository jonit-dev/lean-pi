/**
 * PRD-010 Phase 1 (E1): the per-criterion packet, the atomic questions, and a
 * decision made by code — AC-1, AC-2, AC-3, AC-6, AC-7.
 */
import { describe, expect, it } from "vitest";
import { createTaskState } from "../../src/compiler/state.js";
import { createArtifactStore } from "../../src/context/artifacts.js";
import { createJevClient, type JevClient } from "../../src/jev/client.js";
import { getSite } from "../../src/jev/registry.js";
import { evaluateProofGate, registerProofSites, type ProofOutcome } from "../../src/proof/gate.js";
import { criteriaOf, type ProofCriterion } from "../../src/proof/packet.js";
import {
	MISSING_PROOF_SITE_ID,
	PROOF_GAP_CATEGORIES,
	SUFFICIENCY_QUESTION_IDS,
	SUFFICIENCY_SITE_ID,
} from "../../src/proof/questions.js";
import { answerScript } from "../compiler/helpers.js";
import { startStubJev } from "../helpers/stub-jev.js";
import { tempDir } from "../helpers/fixtures.js";
import { falseCompletion } from "./fixtures/false-completion.js";
import { FIXTURE_HASH, choiceMap, proofConfig, proofContract, reviewSpy, storeOf, type ChoiceScript } from "./support.js";

/** A real JEV client answering the atomic questions from `script`, against a stub endpoint. */
async function scriptedClient(script: ChoiceScript): Promise<{ client: JevClient; close(): Promise<void> }> {
	const stub = await startStubJev([answerScript({ choices: choiceMap(script) })]);
	const cwd = tempDir("leanpi-proof-jev-");
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

const coveredCriterion = { id: "AC-1", verifiers: ["targeted_test"], scope: "tests/proof/covered.test.ts" };
const coveredRecord = { kind: "targeted_test", status: "pass" as const, criterion: ["AC-1"], scope: "tests/proof/covered.test.ts" };

describe("AC-1 — each criterion is judged on its own records", () => {
	it("splits a proved criterion from an unproved sibling and keeps the packets apart", async () => {
		const contract = proofContract(
			// The second criterion declares no verifier: the contract maps no check to
			// it, so nothing can be gathered and only a review could decide it.
			{ required: ["targeted_test"], criteria: [coveredCriterion, { id: "AC-2" }] },
			1,
		);
		const criteria = criteriaOf(contract);
		const store = storeOf(FIXTURE_HASH, [coveredRecord]);
		const outcome: ProofOutcome = { workspaceHash: FIXTURE_HASH, changedFiles: ["src/covered.ts"], summary: "covered" };
		const scripted = await scriptedClient({ ...AFFIRMATIVE, gap: "REVIEW_REQUIRED" });
		try {
			const together = await evaluateProofGate(criteria, outcome, { contract, store, jev: scripted.client });

			expect(together.criteria.map((result) => [result.id, result.decision])).toEqual([
				["AC-1", "PASS"],
				["AC-2", "MISSING_PROOF"],
			]);
			expect(together.decision).toBe("MISSING_PROOF");

			// The first criterion's packet holds its own record and nothing else; the
			// second's holds no evidence at all, so no sibling record can evidence it.
			expect(together.criteria[0]!.packet.evidence).toEqual([
				{ kind: "targeted_test", status: "pass", scope: "tests/proof/covered.test.ts", exitCode: null },
			]);
			expect(together.criteria[1]!.packet.evidence).toEqual([]);
			expect(together.criteria[1]!.packet.known_gaps).toEqual([]);

			// The sibling's outcome cannot move the first criterion: judged alone, its
			// result is byte-for-byte the same.
			const alone = await evaluateProofGate([criteria[0]! as ProofCriterion], outcome, { contract, store, jev: scripted.client });
			expect(alone.criteria[0]).toEqual(together.criteria[0]);
			expect(alone.decision).toBe("PASS");
		} finally {
			await scripted.close();
		}
	});
});

describe("AC-2 — a false completion is rejected", () => {
	it("never passes an asserted-but-unmeasured feature, and names a verification category", async () => {
		const fixture = falseCompletion(0);
		expect(fixture.store.current(FIXTURE_HASH).map((record) => record.kind)).toEqual([...fixture.recorded]);

		const scripted = await scriptedClient({ ...AFFIRMATIVE, gap: "TARGETED_TEST_REQUIRED" });
		try {
			const result = await evaluateProofGate(fixture.criteria, fixture.outcome, {
				contract: fixture.contract,
				store: fixture.store,
				jev: scripted.client,
			});

			expect(result.decision).not.toBe("PASS");
			expect(["MISSING_PROOF", "BLOCKED"]).toContain(result.decision);
			// The action is a category and a target, not prose.
			expect(result.actions[0]!.category).toBe("TARGETED_TEST_REQUIRED");
			expect(result.actions[0]!.action.target).toBe("targeted_test");
			expect(result.criteria[0]!.reasons.join(" ")).toContain("TARGETED_TEST_REQUIRED");
			// The control is not vacuous: the criterion's packet carries the claim,
			// no evidence, and the check that would have proved it is named absent.
			expect(result.criteria[0]!.packet.evidence).toEqual([]);
			expect(result.criteria[0]!.packet.claims).toEqual([{ source: "executor", text: "feature implemented and working" }]);
			expect(result.criteria[0]!.packet.known_gaps).toEqual(["not_run: targeted_test"]);
		} finally {
			await scripted.close();
		}
	});
});

describe("AC-3 — contradiction is a hard fail", () => {
	const verification = { required: ["targeted_test"], criteria: [coveredCriterion] };
	const outcome: ProofOutcome = { workspaceHash: FIXTURE_HASH };
	const conflicting = [
		coveredRecord,
		// Advisory: the contract does not require `full_suite`, so it is not in this
		// criterion's mandatory set and the aggregate stays a pass.
		{ kind: "full_suite", status: "fail" as const, criterion: ["AC-1"], scope: coveredRecord.scope },
	];

	it("fails a self-contradicting packet while every JEV answer is optimistic", async () => {
		const contract = proofContract(verification, 1);
		const store = storeOf(FIXTURE_HASH, conflicting);
		const scripted = await scriptedClient({ ...AFFIRMATIVE, gap: "REGRESSION_TEST_REQUIRED" });
		try {
			const result = await evaluateProofGate(criteriaOf(contract), outcome, { contract, store, jev: scripted.client });
			const criterion = result.criteria[0]!;

			expect(criterion.aggregate).toBe("pass");
			expect(criterion.coverage.satisfied).toBe(true);
			expect(criterion.decision).toBe("FAILED");
			expect(result.decision).toBe("FAILED");
			expect(criterion.contradiction).toMatchObject({
				scope: coveredRecord.scope,
				passing: { kind: "targeted_test" },
				failing: { kind: "full_suite" },
			});
			expect(criterion.reasons.join(" ")).toContain("full_suite");
		} finally {
			await scripted.close();
		}
	});

	it("passes the identical packet once the conflicting record is gone", async () => {
		const contract = proofContract(verification, 1);
		const clean = storeOf(FIXTURE_HASH, [coveredRecord]);
		const scripted = await scriptedClient({ ...AFFIRMATIVE, gap: "REGRESSION_TEST_REQUIRED" });
		try {
			const result = await evaluateProofGate(criteriaOf(contract), outcome, { contract, store: clean, jev: scripted.client });
			expect(result.criteria[0]!.contradiction).toBeNull();
			expect(result.criteria[0]!.decision).toBe("PASS");
			expect(result.decision).toBe("PASS");
		} finally {
			await scripted.close();
		}
	});

	it("fails a deterministic failure no matter how optimistic the answers are", async () => {
		const contract = proofContract(verification, 1);
		const store = storeOf(FIXTURE_HASH, [{ ...coveredRecord, status: "fail" }]);
		const scripted = await scriptedClient({ ...AFFIRMATIVE, gap: "NONE" });
		try {
			const result = await evaluateProofGate(criteriaOf(contract), outcome, { contract, store, jev: scripted.client });
			expect(result.criteria[0]!.aggregate).toBe("deterministic_failure");
			expect(result.criteria[0]!.decision).toBe("FAILED");
			expect(result.decision).toBe("FAILED");
		} finally {
			await scripted.close();
		}
	});
});

describe("PRD-050 — sufficiency answers block false completion", () => {
	for (const [answer, reason] of [
		["staticForRuntime", "static where runtime behavior is required"],
		["unevidencedPath", "an important execution path has no evidence"],
	] as const) {
		it(`rejects PASS when ${answer} is YES`, async () => {
			const contract = proofContract({ required: ["targeted_test"], criteria: [coveredCriterion] }, 1);
			const scripted = await scriptedClient({ ...AFFIRMATIVE, [answer]: "YES", gap: "REVIEW_REQUIRED" });
			try {
				const result = await evaluateProofGate(criteriaOf(contract), { workspaceHash: FIXTURE_HASH }, {
					contract,
					store: storeOf(FIXTURE_HASH, [coveredRecord]),
					jev: scripted.client,
				});
				expect(result.criteria[0]!.decision).toBe("MISSING_PROOF");
				expect(result.criteria[0]!.reasons.join(" ")).toContain(reason);
			} finally {
				await scripted.close();
			}
		});
	}
});

describe("AC-6 — JEV off still gates, and a JEV answer is consumed", () => {
	it("rejects the false completion through the coverage rule, with both sites on their fallback", async () => {
		const fixture = falseCompletion(0);
		const cwd = tempDir("leanpi-proof-off-");
		const client = createJevClient({ config: proofConfig(cwd, "disabled"), cwd });

		const result = await evaluateProofGate(fixture.criteria, fixture.outcome, {
			contract: fixture.contract,
			store: fixture.store,
			jev: client,
		});

		expect(result.decision).not.toBe("PASS");
		expect(result.actions[0]!.category).toBe("TARGETED_TEST_REQUIRED");
		const sufficiency = result.telemetry.find((row) => row.site_id === SUFFICIENCY_SITE_ID)!;
		const gap = result.telemetry.find((row) => row.site_id === MISSING_PROOF_SITE_ID)!;
		expect(sufficiency.fallback_used).toBe(true);
		expect(gap.fallback_used).toBe(true);
		expect(gap.answer).toBe("TARGETED_TEST_REQUIRED");
	});

	it("flips PASS to MISSING_PROOF when the answer changes and nothing else does", async () => {
		const contract = proofContract({ required: ["targeted_test"], criteria: [coveredCriterion] }, 1);
		const store = storeOf(FIXTURE_HASH, [coveredRecord]);
		const outcome: ProofOutcome = { workspaceHash: FIXTURE_HASH };
		const optimistic = await scriptedClient({ ...AFFIRMATIVE, gap: "REVIEW_REQUIRED" });
		const pessimistic = await scriptedClient({ ...AFFIRMATIVE, demonstrates: "NO", gap: "REVIEW_REQUIRED" });
		try {
			const decisionFor = async (client: JevClient) =>
				(await evaluateProofGate(criteriaOf(contract), outcome, { contract, store, jev: client })).criteria[0]!;

			const passed = await decisionFor(optimistic.client);
			expect(passed.decision).toBe("PASS");
			expect(passed.answers.demonstrates).toBe("YES");

			const denied = await decisionFor(pessimistic.client);
			expect(denied.decision).toBe("MISSING_PROOF");
			expect(denied.answers.demonstrates).toBe("NO");
			// Everything deterministic about the criterion is identical: only the
			// answer moved it.
			expect(denied.aggregate).toBe(passed.aggregate);
			expect(denied.coverage).toEqual(passed.coverage);
		} finally {
			await optimistic.close();
			await pessimistic.close();
		}
	});
});

describe("AC-7 — an unavailable facility reads as a gap", () => {
	it("never passes a criterion whose only runtime evidence is unavailable", async () => {
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-proof-artifacts-") });
		const ref = artifacts.store("no browser facility is available", "browser_test", "browser_test");
		const contract = proofContract({ required: ["runtime_smoke"], criteria: [{ id: "AC-1", verifiers: ["runtime_smoke"] }] }, 0);
		const store = storeOf(FIXTURE_HASH, [
			{ kind: "runtime_smoke", status: "unavailable", criterion: ["AC-1"], scope: "ui", artifactRef: ref },
		]);
		const outcome: ProofOutcome = { workspaceHash: FIXTURE_HASH };
		const scripted = await scriptedClient({ ...AFFIRMATIVE, gap: "UI_VERIFICATION_REQUIRED" });
		try {
			const result = await evaluateProofGate(criteriaOf(contract), outcome, {
				contract,
				store,
				jev: scripted.client,
				artifacts,
			});
			const criterion = result.criteria[0]!;

			expect(["MISSING_PROOF", "BLOCKED"]).toContain(criterion.decision);
			expect(result.decision).toBe("BLOCKED");
			expect(criterion.aggregate).toBe("incomplete");
			// Never under `evidence` — the record is a missing facility, not a
			// measurement — and named under `known_gaps` with its reason.
			expect(criterion.packet.evidence.some((entry) => entry.kind === "runtime_smoke")).toBe(false);
			expect(criterion.packet.known_gaps).toContain("unavailable: runtime_smoke (no browser facility is available)");
			// The missing capability is named, as a category and a target.
			expect(criterion.reasons.join(" ")).toContain("UI_VERIFICATION_REQUIRED");
			expect(result.actions[0]!.category).toBe("UI_VERIFICATION_REQUIRED");
			expect(result.actions[0]!.action.target).toBe("browser_test");
			// No round was spent and no record was invented: the store is untouched.
			expect(result.rounds).toBe(0);
			expect(store.forCriterion("AC-1")).toHaveLength(1);
		} finally {
			await scripted.close();
		}
	});
});

describe("the two decision sites", () => {
	it("registers both with the §38 question sets, a high consequence and a non-null fallback", () => {
		registerProofSites();
		// Idempotent: a compiler compiles many tasks in one process.
		registerProofSites();

		const sufficiency = getSite(SUFFICIENCY_SITE_ID);
		expect(sufficiency.consequence).toBe("high");
		expect(sufficiency.returnType).toEqual(["Choice", "Choice", "Choice", "Choice"]);
		expect(sufficiency.questions.map((question) => question.id)).toEqual(Object.values(SUFFICIENCY_QUESTION_IDS));
		// The declared fallback is the coverage rule, and it is a real function.
		expect(typeof sufficiency.fallback).toBe("function");

		const gap = getSite(MISSING_PROOF_SITE_ID);
		expect(gap.consequence).toBe("high");
		expect(gap.questions).toHaveLength(1);
		expect(Object.keys(gap.questions[0]!.options)).toEqual([...PROOF_GAP_CATEGORIES]);
		expect(typeof gap.fallback).toBe("function");
	});

	it("keeps the coverage fallback strictly more conservative than an optimistic answer", async () => {
		const contract = proofContract({ required: ["targeted_test"], criteria: [coveredCriterion] }, 0);
		const store = storeOf(FIXTURE_HASH, []);
		// JEV off: the fallback answers, and it must refuse the criterion no
		// measurement covers.
		const result = await evaluateProofGate(criteriaOf(contract), { workspaceHash: FIXTURE_HASH }, { contract, store });
		expect(result.decision).toBe("BLOCKED");
		expect(result.criteria[0]!.answers.demonstrates).toBe("NO");
		expect(result.criteria[0]!.packet.known_gaps).toContain("not_run: targeted_test");
	});
});

describe("staleness is a §39 clause of its own", () => {
	it("refuses a criterion whose record no longer matches the workspace", async () => {
		const contract = proofContract({ required: ["targeted_test"], criteria: [coveredCriterion] }, 0);
		const store = storeOf(FIXTURE_HASH, [{ ...coveredRecord, hash: "stale".repeat(16) }]);
		const scripted = await scriptedClient({ ...AFFIRMATIVE, gap: "TARGETED_TEST_REQUIRED" });
		try {
			const result = await evaluateProofGate(criteriaOf(contract), { workspaceHash: FIXTURE_HASH }, { contract, store, jev: scripted.client });
			const criterion = result.criteria[0]!;

			expect(criterion.decision).not.toBe("PASS");
			expect(criterion.aggregate).toBe("deterministic_failure");
			// Reported as a gap with its kind, never dropped and never counted as evidence.
			expect(criterion.packet.known_gaps).toContain("stale: targeted_test");
			expect(criterion.packet.evidence).toEqual([]);
		} finally {
			await scripted.close();
		}
	});
});

describe("the required review is part of PASS", () => {
	const verification = { required: ["targeted_test"], criteria: [coveredCriterion] };
	const outcome: ProofOutcome = { workspaceHash: FIXTURE_HASH };

	it("holds a criterion when the contract demands a review that has not passed", async () => {
		const contract = proofContract(verification, 1);
		contract.routing.reviewer_class = "review_quick";
		const store = storeOf(FIXTURE_HASH, [coveredRecord]);
		const scripted = await scriptedClient({ ...AFFIRMATIVE, gap: "REVIEW_REQUIRED" });
		try {
			const undecided = await evaluateProofGate(criteriaOf(contract), outcome, { contract, store, jev: scripted.client });
			expect(undecided.criteria[0]!.decision).toBe("MISSING_PROOF");
			expect(undecided.criteria[0]!.reasons.join(" ")).toContain("review");

			const passed = await evaluateProofGate(criteriaOf(contract), outcome, {
				contract,
				store,
				jev: scripted.client,
				reviewVerdicts: [{ verdict: { decision: "PASS" } }],
			});
			expect(passed.criteria[0]!.decision).toBe("PASS");

			const finding = await evaluateProofGate(criteriaOf(contract), outcome, {
				contract,
				store,
				jev: scripted.client,
				reviewVerdicts: [{ verdict: { decision: "PASS" } }, { verdict: { decision: "FIX_REQUIRED", findings: [{ criterion: "AC-1" }] } }],
			});
			expect(finding.criteria[0]!.decision).not.toBe("PASS");
		} finally {
			await scripted.close();
		}
	});

	it("mirrors each ladder verdict into the review slice without inventing evidence", async () => {
		const contract = proofContract({ required: ["runtime_smoke"], criteria: [{ id: "AC-1", verifiers: ["runtime_smoke"] }] }, 0);
		const store = storeOf(FIXTURE_HASH, []);
		const spy = reviewSpy({ QUICK_REVIEW: "FIX_REQUIRED", STRONG_REVIEW: "ESCALATE" });
		const scripted = await scriptedClient({ ...AFFIRMATIVE, gap: "RUNTIME_TEST_REQUIRED" });
		try {
			const state = createTaskState();
			const result = await evaluateProofGate(criteriaOf(contract), outcome, {
				contract,
				store,
				jev: scripted.client,
				review: spy.review,
				state,
			});
			expect(spy.levels).toEqual(["QUICK_REVIEW", "STRONG_REVIEW"]);
			expect(state.review().verdicts).toEqual(["FIX_REQUIRED", "ESCALATE"]);
			expect(result.decision).toBe("BLOCKED");
			// The ladder wrote no evidence: the store is exactly as the fixture left it.
			expect(store.current(FIXTURE_HASH)).toEqual([]);
		} finally {
			await scripted.close();
		}
	});
});
