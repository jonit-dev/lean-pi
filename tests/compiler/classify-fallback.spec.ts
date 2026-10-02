/**
 * PRD-053 AC-4: a complexity answer JEV dropped is unknown, not "no".
 *
 * The client keeps only answers that clear the site's confidence bar, so a
 * low-confidence `explicit_result` used to vanish and read as "the result is not
 * explicit" — MEDIUM, whatever the task. The turn now takes the keyword
 * heuristic, records the fallback, and the Auto footer says the band was guessed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSites, compileRecordOf, compileTask } from "../../src/index.js";
import { statusLine } from "../../src/cli/statusline.js";
import type { StubJevResponder } from "../helpers/stub-jev.js";
import { harness, packet } from "./helpers.js";

const RACE = "fix the race condition in the scheduler";

/** Confident "no" to every choice, except a low-confidence `explicit_result` the client drops. */
const unsureExplicit: StubJevResponder = (body) => {
	const questions = (body.questions ?? {}) as Record<string, { type?: string; criteria?: unknown }>;
	const answers: Record<string, unknown> = {};
	for (const [id, question] of Object.entries(questions)) {
		const confidence = id === "explicit_result" ? 0.1 : 0.95;
		if (question.type === "choice") {
			const options = Object.keys((question.criteria ?? {}) as Record<string, string>);
			const choice = options.includes("no") ? "no" : (options[0] ?? "no");
			answers[id] = { type: "choice", choice, probabilities: { [choice]: confidence }, confidence };
		} else if (question.type === "score") {
			answers[id] = { type: "score", score: 1, legend: {}, probabilities: {}, confidence };
		} else {
			answers[id] = { type: "noul", noul: 0.9 };
		}
	}
	return { answers };
};

beforeEach(() => clearSites());
afterEach(() => clearSites());

describe("PRD-053 AC-4 — an unsure classification is the heuristic's, and says so", () => {
	it("a dropped complexity answer falls back to the keyword band and is recorded as a fallback", async () => {
		const h = await harness([unsureExplicit]);
		try {
			const contract = await compileTask(RACE, packet());
			expect(contract.task.execution_complexity).toBe("HIGH");
			const row = compileRecordOf(contract)!.telemetry.find((entry) => entry.site_id === "classify.execution_complexity");
			expect(row?.fallback_used).toBe(true);
			expect(statusLine({ config: h.config, contract })).toContain("guessed");
		} finally {
			await h.close();
		}
	});

	it("control: a fully answered classification is not marked guessed", async () => {
		const h = await harness([]);
		try {
			const contract = await compileTask(RACE, packet());
			const row = compileRecordOf(contract)!.telemetry.find((entry) => entry.site_id === "classify.execution_complexity");
			expect(row?.fallback_used).toBe(false);
			expect(statusLine({ config: h.config, contract })).not.toContain("guessed");
		} finally {
			await h.close();
		}
	});
});
