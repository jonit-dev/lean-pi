/**
 * PRD-023 Phase 4 — AC-6.
 *
 * The candidate list is the whole deliverable: a ranked set for PRD-009's
 * verifier selection, with no regression scope and no pass/fail claim anywhere
 * on it. The unrelated test is excluded because it never qualifies — an
 * unrelated name collision cannot be promoted into a candidate, by JEV or
 * otherwise, which the fallback-forced run proves from the other side.
 */
import { describe, expect, it } from "vitest";
import { harness, scoreEveryone, testRelevanceFixture } from "./helpers.js";

const EXERCISING = "src/game/torpedo.test.ts";
const UNRELATED = "packages/legacy/tests/legacy-torpedo.spec.ts";

/** A result key that would be a regression-scope or pass/fail claim. */
const CLAIM_KEY = /scope|pass|fail|verif|expected/i;

function claimKeys(result: object): string[] {
	return Object.keys(result).filter((key) => CLAIM_KEY.test(key));
}

describe("PRD-023 AC-6 — the candidate test set, and nothing more", () => {
	it("ranks the exercising test first and excludes the identifier-only collision", async () => {
		const fixture = testRelevanceFixture();
		const h = await harness({ cwd: fixture.cwd, objective: fixture.objective, responders: [scoreEveryone(3)] });
		const result = await h.run();

		expect(result.candidateTests.map((test) => test.path)).toContain(EXERCISING);
		expect(result.candidateTests[0]!.path).toBe(EXERCISING);
		expect(result.candidateTests.map((test) => test.path)).not.toContain(UNRELATED);
		expect(claimKeys(result)).toEqual([]);
		await h.close();
	});

	it("excludes it through the deterministic fallback too, so the exclusion is not the stub's answer", async () => {
		const fixture = testRelevanceFixture();
		const h = await harness({ cwd: fixture.cwd, objective: fixture.objective, mode: "disabled" });
		const result = await h.run();

		expect(result.candidateTests[0]!.path).toBe(EXERCISING);
		expect(result.candidateTests.map((test) => test.path)).not.toContain(UNRELATED);
		expect(h.asks()).toBe(0);
		await h.close();
	});

	it("fails the shape check when a claim field is present, so the check is not silently ignored", () => {
		const withClaim = { candidateTests: [], regressionScope: "BROADER_SUITE_REQUIRED" };
		expect(claimKeys(withClaim)).toEqual(["regressionScope"]);
		expect(() => expect(claimKeys(withClaim)).toEqual([])).toThrow();
	});
});
