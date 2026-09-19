/**
 * PRD-023 Phase 3 — AC-2, AC-7.
 *
 * AC-2 contrasts with AC-4 on the same loop fixture: the identical repository
 * that runs to the ceiling under a `NEED_MORE` stub stops after the round that
 * accepted the ground truth once the stop site says so. AC-7 then pins the two
 * remaining loop decisions — subsystem choice and sibling expansion — including
 * the `Noul` fallback that must reproduce the deterministic breadth order.
 */
import { describe, expect, it } from "vitest";
import type { JevClient } from "../../src/jev/client.js";
import type { JevResult } from "../../src/jev/types.js";
import { harness, loopFixture, multiSubsystemFixture, scriptedClient } from "./helpers.js";
import type { StubJevResponder } from "../helpers/stub-jev.js";

const GROUND_TRUTH = "src/loop/phase0/alpha.ts";

/** `ENOUGH_EVIDENCE` once the ground truth is in the evidence summary, `NEED_MORE` before it. */
function enoughOnceTruthAccepted(): StubJevResponder {
	return (body) => {
		const state = (body.state ?? {}) as { acceptedFiles?: string[] };
		const questions = (body.questions ?? {}) as Record<string, { type?: string; criteria?: Record<string, string> }>;
		const answers: Record<string, unknown> = {};
		for (const [id, question] of Object.entries(questions)) {
			if (question.type === "choice") {
				const options = Object.keys(question.criteria ?? {});
				const choice = options.includes("ENOUGH_EVIDENCE")
					? (state.acceptedFiles ?? []).includes(GROUND_TRUTH)
						? "ENOUGH_EVIDENCE"
						: "NEED_MORE"
					: options.includes("KEEP")
						? "KEEP"
						: options.includes("SKIP")
							? "SKIP"
							: options[0]!;
				answers[id] = { type: "choice", choice, probabilities: { [choice]: 0.98 }, confidence: 0.98 };
				continue;
			}
			if (question.type === "score") {
				answers[id] = { type: "score", score: 3, legend: {}, confidence: 0.95 };
				continue;
			}
			answers[id] = { type: "noul", noul: 0.5 };
		}
		return { answers };
	};
}

/** A no-socket JEV that answers the subsystem root, the sibling classes and nothing else notably. */
function multiClient(options: { implicated: number; confidence?: number; sibling: "EXPAND" | "SKIP"; root: string }): JevClient {
	return scriptedClient((siteId, questions): JevResult[] =>
		questions.map((question): JevResult => {
			if (question.kind === "Noul") {
				return { kind: "Noul", questionId: question.id, value: options.implicated, confidence: options.confidence ?? (options.implicated === 1 ? 1 : 0) };
			}
			if (question.kind === "Score") {
				return { kind: "Score", questionId: question.id, score: 3, legend: {}, confidence: 0.95 };
			}
			const choices = Object.keys(question.options);
			const pick = (value: string): JevResult => ({ kind: "Choice", questionId: question.id, choice: choices.includes(value) ? value : choices[0]!, probabilities: {}, confidence: 0.95 });
			if (siteId === "explore.subsystem_order") return pick(options.root);
			if (siteId === "explore.sibling_expansion") return pick(question.id.endsWith(":caller") ? "SKIP" : options.sibling);
			if (siteId === "explore.sufficiency") return pick("NEED_MORE");
			return pick("KEEP");
		}),
	);
}

describe("PRD-023 AC-2 — the stop site ends a loop that never converges on its own", () => {
	it("stops with enough_evidence below maxRounds and still holds the ground truth", async () => {
		const fixture = loopFixture();
		const h = await harness({ cwd: fixture.cwd, objective: fixture.objective, responders: [enoughOnceTruthAccepted()] });
		const result = await h.run();

		expect(result.stopReason).toBe("enough_evidence");
		expect(result.rounds).toBeLessThan(3);
		expect(result.roundLog[0]!.added).toBeGreaterThan(0);
		expect(result.files.map((file) => file.path)).toContain(GROUND_TRUTH);
		await h.close();
	});
});

describe("PRD-023 AC-7 — subsystem order and sibling expansion", () => {
	it("targets the ground-truth subsystem first, unlike the recorded deterministic order, and expands the test sibling", async () => {
		const fixture = multiSubsystemFixture();
		const h = await harness({
			cwd: fixture.cwd,
			objective: fixture.objective,
			client: multiClient({ implicated: 1, sibling: "EXPAND", root: "packages/gamma" }),
		});
		const result = await h.run();

		const deterministic = result.subsystemOrder.deterministic;
		expect(deterministic).toContain("packages/gamma");
		expect(deterministic.indexOf("packages/gamma")).toBeGreaterThan(0);
		expect(result.subsystemOrder.chosen).not.toEqual(deterministic);
		expect(result.roundTargets[0]).toBe("packages/gamma");
		expect(fixture.groundTruth[0]!.startsWith(result.roundTargets[0]!)).toBe(true);

		const sibling = result.files.find((file) => file.path === "packages/gamma/src/engine.test.ts");
		expect(sibling?.siblingClass).toBe("test");
		expect(sibling?.siblingOf).toBe("packages/gamma/src/engine.ts");
		expect(result.filesRead).toBe(2);
		await h.close();
	});

	it("reads zero extra files when the sibling site answers SKIP", async () => {
		const fixture = multiSubsystemFixture();
		const h = await harness({
			cwd: fixture.cwd,
			objective: fixture.objective,
			client: multiClient({ implicated: 1, sibling: "SKIP", root: "packages/gamma" }),
		});
		const result = await h.run();

		expect(result.files.map((file) => file.path)).toEqual(["packages/gamma/src/engine.ts"]);
		expect(result.files.every((file) => file.siblingOf === undefined)).toBe(true);
		expect(result.filesRead).toBe(1);
		await h.close();
	});

	it("falls back to the deterministic breadth order on a Noul answer and still completes", async () => {
		const fixture = multiSubsystemFixture();
		// Both a confident "no root stands out" and an unconfident coin flip must
		// resolve to the deterministic order.
		for (const answer of [
			{ implicated: 0.1, confidence: 0.9 },
			{ implicated: 0.5, confidence: 0 },
		]) {
			const h = await harness({
				cwd: fixture.cwd,
				objective: fixture.objective,
				client: multiClient({ ...answer, sibling: "SKIP", root: "packages/gamma" }),
			});
			const result = await h.run();

			expect(result.subsystemOrder.chosen).toEqual(result.subsystemOrder.deterministic);
			expect(result.roundTargets[0]).toBe(result.subsystemOrder.deterministic[0]);
			expect(result.rounds).toBeLessThanOrEqual(3);
			expect(result.files.map((file) => file.path)).toContain(fixture.groundTruth[0]);
			await h.close();
		}
	});
});
