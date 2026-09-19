/**
 * PRD-023 Phase 1 — AC-3, AC-4, AC-5.
 *
 * The deterministic path is the shipped default: with JEV configured off, the
 * run finishes through the six registered fallbacks and never opens a request.
 * The adversarial run then proves the budget gate, not the answer, terminates
 * exploration. The last case proves a drop is reversible byte for byte.
 */
import { describe, expect, it } from "vitest";
import { EXPLORATION_SITE_IDS, objectivePattern, snippetTextOf } from "../../src/exploration/index.js";
import { getSite } from "../../src/jev/registry.js";
import type { JevResult } from "../../src/jev/types.js";
import { adversarialResponder, answersOf, groundTruthFixture, harness, loopFixture, scriptedClient } from "./helpers.js";

/** Every snippet dropped at site 4; everything else confirmed. */
function dropEverySnippet() {
	return scriptedClient((siteId, questions): JevResult[] =>
		questions.map(
			(question): JevResult =>
				question.kind === "Score"
					? { kind: "Score", questionId: question.id, score: 3, legend: {}, confidence: 0.95 }
					: question.kind === "Choice"
						? {
								kind: "Choice",
								questionId: question.id,
								choice: Object.keys(question.options).includes("DROP") ? "DROP" : Object.keys(question.options)[0]!,
								probabilities: {},
								confidence: siteId === "explore.snippet_relevance" ? 0.95 : 0.2,
							}
						: { kind: "Noul", questionId: question.id, value: 0.5, confidence: 0 },
		),
	);
}

describe("PRD-023 AC-3 — JEV disabled by configuration degrades honestly", () => {
	it("returns a non-empty deterministic selection, names all six fallbacks, and asks nothing", async () => {
		const fixture = groundTruthFixture();
		const h = await harness({ cwd: fixture.cwd, objective: fixture.objective, mode: "disabled" });
		const result = await h.run();

		expect(result.files.length).toBeGreaterThan(0);
		expect(result.files.map((file) => file.path)).toContain("src/game/torpedo.ts");
		expect(h.asks()).toBe(0);
		expect(h.stub.requests).toHaveLength(0);

		expect(new Set(result.degradations.map((degradation) => degradation.site))).toEqual(new Set(EXPLORATION_SITE_IDS));
		for (const degradation of result.degradations) {
			expect(degradation.fallback.length).toBeGreaterThan(0);
			expect(degradation.reason.length).toBeGreaterThan(0);
		}
		for (const site of EXPLORATION_SITE_IDS) {
			expect(typeof getSite(site).fallback).toBe("function");
		}
		// Reversibility does not depend on JEV: the deterministic floor drops
		// snippets too, and every drop is stored and resolvable.
		expect(result.droppedRefs.length).toBeGreaterThan(0);
		for (const dropped of result.droppedRefs) {
			expect(h.artifacts.expand(dropped.ref).toString("utf8")).toHaveLength(dropped.bytes);
		}
		await h.close();
	});

	it("adds PRD-018 symbol evidence to the candidates it names, and survives a failing port", async () => {
		const fixture = groundTruthFixture();
		const failing = await harness({
			cwd: fixture.cwd,
			objective: fixture.objective,
			mode: "disabled",
			symbols: () => {
				throw new Error("no language server");
			},
		});
		const withoutSymbols = await failing.run();
		await failing.close();

		const symboled = await harness({
			cwd: fixture.cwd,
			objective: fixture.objective,
			mode: "disabled",
			symbols: () => [{ path: "src/game/wake.ts", count: 3 }],
		});
		const withSymbols = await symboled.run();
		await symboled.close();

		// A failing port costs evidence, never the run.
		expect(withoutSymbols.files.length).toBeGreaterThan(0);
		expect(withoutSymbols.files.map((file) => file.path)).toContain("src/game/torpedo.ts");
		const baseline = withoutSymbols.files.find((file) => file.path === "src/game/wake.ts")?.symbolHits ?? 0;
		expect(withSymbols.files.find((file) => file.path === "src/game/wake.ts")?.symbolHits).toBe(baseline + 3);
	});

	it("names the missing client when JEV is configured on but never constructed", async () => {
		const fixture = groundTruthFixture();
		const h = await harness({ cwd: fixture.cwd, objective: fixture.objective, noClient: true });
		const result = await h.run();

		expect(result.files.length).toBeGreaterThan(0);
		expect(h.asks()).toBe(0);
		expect(h.stub.requests).toHaveLength(0);
		expect(result.degradations.map((degradation) => degradation.reason)).toEqual(EXPLORATION_SITE_IDS.map(() => "no-jev-client"));
		await h.close();
	});

	it("bounds every round's candidate scan and the file reads it can produce", async () => {
		const fixture = loopFixture();
		const h = await harness({ cwd: fixture.cwd, objective: fixture.objective, mode: "disabled" });
		const result = await h.run({ settings: { maxCandidates: 2 } });

		expect(result.roundLog.length).toBeGreaterThan(0);
		for (const round of result.roundLog) expect(round.candidates).toBeLessThanOrEqual(2);
		expect(result.unfilteredCandidateCount).toBeLessThanOrEqual(2 * result.rounds);
		expect(result.filesRead).toBeLessThanOrEqual(result.unfilteredCandidateCount);
		await h.close();
	});
});

describe("PRD-023 AC-4 — the budget, not the answer, terminates exploration", () => {
	it("stops at budget_exhausted inside every ceiling under a maximum-score, NEED_MORE stub", async () => {
		const fixture = loopFixture();
		const h = await harness({ cwd: fixture.cwd, objective: fixture.objective, responders: [adversarialResponder()] });
		const result = await h.run({ budget: { maxRounds: 3, maxFilesRead: 5, maxBytesIntoContext: 2_000 } });

		expect(result.stopReason).toBe("budget_exhausted");
		expect(result.rounds).toBeLessThanOrEqual(3);
		expect(result.filesRead).toBeLessThanOrEqual(5);
		expect(result.bytes).toBeLessThanOrEqual(2_000);
		// The ceiling is real: the bytes were actually charged, and they add up.
		expect(result.bytes).toBeGreaterThan(0);
		expect(result.bytes).toBe(
			[...result.files.map((file) => file.contextBytes), ...result.snippets.map((snippet) => snippet.contextBytes)].reduce((total, bytes) => total + bytes, 0),
		);
		// What was written into the working state is exactly what was charged.
		const written = h.selection();
		expect(written?.bytes).toBe(result.bytes);
		expect(written?.bytes).toBeLessThanOrEqual(2_000);
		expect(written?.files.map((file) => file.path)).toEqual(result.files.map((file) => file.path));
		await h.close();
	});

	it("still stops at budget_exhausted with repository-default budget, reaching the file ceiling", async () => {
		const fixture = loopFixture();
		const h = await harness({ cwd: fixture.cwd, objective: fixture.objective, responders: [adversarialResponder()] });
		const result = await h.run();

		expect(result.stopReason).toBe("budget_exhausted");
		expect(result.filesRead).toBe(5);
		expect(result.rounds).toBeLessThanOrEqual(3);
		expect(result.bytes).toBeLessThanOrEqual(24_000);
		await h.close();
	});
});

describe("PRD-023 AC-5 — a dropped snippet is stored before it is dropped", () => {
	it("resolves the artifact ref to the raw grep output, byte for byte", async () => {
		const fixture = groundTruthFixture();
		const h = await harness({ cwd: fixture.cwd, objective: fixture.objective, client: dropEverySnippet() });
		const result = await h.run();

		expect(result.snippets).toHaveLength(0);
		const dropped = result.droppedRefs.find((entry) => entry.kind === "snippet" && entry.reason === "site4-drop");
		expect(dropped).toBeDefined();

		// The raw output as the harness produced it, captured independently of the governor.
		const hits = h.search.grep({ pattern: objectivePattern(fixture.objective), root: "src/game", maxFiles: 64 });
		const hit = hits.find((entry) => entry.path === dropped!.path);
		expect(hit).toBeDefined();
		const raw = snippetTextOf(hit!);

		expect(dropped!.sourceRef).toBe(`grep:${dropped!.path}`);
		expect(dropped!.bytes).toBe(Buffer.byteLength(raw, "utf8"));
		expect(h.artifacts.expand(dropped!.ref).toString("utf8")).toBe(raw);
		expect(h.artifacts.refFor(raw, "explore-snippet")).toBe(dropped!.ref);
		await h.close();
	});

	it("keeps the inline part of an over-cap snippet and references the overflow", async () => {
		const fixture = groundTruthFixture();
		const h = await harness({
			cwd: fixture.cwd,
			objective: fixture.objective,
			client: scriptedClient((_siteId, questions) => answersOf(questions, { score: 3, choice: "KEEP" })),
		});
		const result = await h.run({ settings: { snippetBytesPerFile: 40 } });

		const overflow = result.droppedRefs.find((entry) => entry.kind === "snippet-overflow");
		expect(overflow).toBeDefined();
		expect(h.artifacts.expand(overflow!.ref).toString("utf8").length).toBeGreaterThan(0);
		expect(result.snippets.length).toBeGreaterThan(0);
		await h.close();
	});
});

