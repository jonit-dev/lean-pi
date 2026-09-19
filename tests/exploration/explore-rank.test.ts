/**
 * PRD-023 Phase 2 — AC-1.
 *
 * The reduction is measured inside one run, not asserted as a constant: the
 * same result carries `filesRead` and the count of every deterministic
 * candidate the run produced. The controls keep that measurement honest — the
 * fixture is not trivially small, the deterministic path is compared, and a
 * path JEV invented is discarded instead of read.
 */
import { describe, expect, it } from "vitest";
import type { JevClient } from "../../src/jev/client.js";
import type { Fixture, ExploreHarness } from "./helpers.js";
import { groundTruthFixture, harness, scriptedClient } from "./helpers.js";

/** Ground truth at maximum relevance, everything else low; NEED_MORE so the loop keeps looking. */
function rankedClient(fixture: Fixture, fabricate?: string): JevClient {
	const truth = new Set(fixture.groundTruth);
	return scriptedClient((siteId, questions) => {
		const answers = questions.map((question) => {
			if (question.kind === "Score") {
				return { kind: "Score" as const, questionId: question.id, score: truth.has(question.id.slice("candidate:".length)) ? 3 : 1, legend: {}, confidence: 0.95 };
			}
			if (question.kind === "Choice") {
				const options = Object.keys(question.options);
				const choice =
					siteId === "explore.subsystem_order" && options.includes("src/game")
						? "src/game"
						: options.includes("NEED_MORE")
							? "NEED_MORE"
							: options.includes("SKIP")
								? "SKIP"
								: options[0]!;
				return { kind: "Choice" as const, questionId: question.id, choice, probabilities: {}, confidence: 0.95 };
			}
			return { kind: "Noul" as const, questionId: question.id, value: 1, confidence: 1 };
		});
		if (fabricate && siteId === "explore.candidate_relevance") {
			answers.push({ kind: "Score", questionId: `candidate:${fabricate}`, score: 3, legend: {}, confidence: 0.99 });
		}
		return answers;
	});
}

describe("PRD-023 AC-1 — governed reads are strictly fewer than the unfiltered candidates", () => {
	it("records both counts from one run and keeps every ground-truth file in the selection", async () => {
		const fixture = groundTruthFixture();
		const h: ExploreHarness = await harness({ cwd: fixture.cwd, objective: fixture.objective, client: rankedClient(fixture) });
		const result = await h.run();

		expect(result.filesRead).toBeGreaterThan(0);
		expect(result.unfilteredCandidateCount).toBeGreaterThanOrEqual(8);
		expect(result.filesRead).toBeLessThan(result.unfilteredCandidateCount);
		expect(result.filesRead).toBe(result.files.length);
		expect(result.bytes).toBeLessThanOrEqual(24_000);
		for (const path of fixture.groundTruth) {
			expect(result.files.map((file) => file.path)).toContain(path);
		}
		await h.close();
	});

	it("holds on the deterministic-only path too, so the bound is structural rather than JEV's doing", async () => {
		const fixture = groundTruthFixture();
		const h = await harness({ cwd: fixture.cwd, objective: fixture.objective, mode: "disabled" });
		const result = await h.run();

		expect(result.unfilteredCandidateCount).toBeGreaterThanOrEqual(8);
		expect(result.filesRead).toBeLessThan(result.unfilteredCandidateCount);
		for (const path of fixture.groundTruth) {
			expect(result.files.map((file) => file.path)).toContain(path);
		}
		await h.close();
	});

	it("discards a candidate path JEV invented and never reads it", async () => {
		const fixture = groundTruthFixture();
		const fabricated = "src/game/jev-imagined.ts";
		const h = await harness({ cwd: fixture.cwd, objective: fixture.objective, client: rankedClient(fixture, fabricated) });
		const result = await h.run();

		expect(result.files.map((file) => file.path)).not.toContain(fabricated);
		expect(h.reads()).not.toContain(fabricated);
		const malformed = result.decisions.filter((decision) => decision.reason === "malformed-path");
		expect(malformed.map((decision) => decision.questionId)).toContain(`candidate:${fabricated}`);
		expect(result.files.length).toBeGreaterThan(0);
		await h.close();
	});
});
