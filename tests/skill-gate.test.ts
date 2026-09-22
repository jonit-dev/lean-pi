/**
 * The `any_skill` gate must be a request of its own.
 *
 * It used to ride in the same batch as one relevance question per candidate, so
 * a catalog of 169 skills paid for 170 questions (28,667 input tokens in the
 * 2026-09-21 four-way benchmark) and then threw every relevance score away when
 * the gate answered "no". The gate has to be cheap enough to be worth asking.
 */
import { describe, expect, it } from "vitest";
import { selectSkills, type LeanPiConfig, type SkillRecord } from "../src/index.js";

function records(count: number): SkillRecord[] {
	return Array.from({ length: count }, (_, index) => ({
		name: `gen-${String(index).padStart(3, "0")}`,
		description: `generated fixture skill number ${index}`,
		tags: ["generated"],
		capabilities: [],
		risk: null,
		cost_hint: null,
		version: "1.0.0",
		source: { class: "user" as const, path: `/skills/gen-${index}`, root: "/skills" },
		status: "ok" as const,
	}));
}

const control = {
	isEnabled: () => true,
	isPinned: () => false,
	disable: () => {},
	enable: () => {},
	pin: () => ({ ok: true, message: "" }),
	unpin: () => {},
	state: () => ({}),
	pinnedRecords: () => [] as SkillRecord[],
	candidates: (all: SkillRecord[]) => all,
};

const config = { skills: { maxLoaded: 3, state: {} } } as unknown as LeanPiConfig;

/** Records every batch size, and answers the gate with `choice`. */
function spyClient(choice: "yes" | "no") {
	const batches: string[][] = [];
	return {
		batches,
		client: {
			fallbackCount: () => 0,
			getMode: () => "enabled" as const,
			async ask(_site: string, questions: { id: string; kind: string }[]) {
				batches.push(questions.map((question) => question.id));
				return questions.map((question) =>
					question.kind === "Choice"
						? question.id === "any_skill"
							? { kind: "Choice" as const, questionId: question.id, choice, probabilities: {}, confidence: 0.95 }
							: { kind: "Choice" as const, questionId: question.id, choice: "yes", probabilities: {}, confidence: 0.95 }
						: { kind: "Score" as const, questionId: question.id, score: 0.9, legend: {}, confidence: 0.95 },
				);
			},
		},
	};
}

describe("skill.disclosure gate", () => {
	it("loads nothing when the gate itself falls back, rather than guessing lexically", async () => {
		// The lexical scorer matches names by substring, so "hands out" reaches
		// `nextjs-app-router-patterns` through "router". Disclosing guesses is worse
		// than disclosing nothing: the 2026-09-21 run loaded three unrelated skills
		// on every attempt and used none of them.
		const batches: string[][] = [];
		let fallbacks = 0;
		const client = {
			fallbackCount: () => fallbacks,
			getMode: () => "enabled" as const,
			async ask(_site: string, questions: { id: string; kind: string }[]) {
				batches.push(questions.map((q) => q.id));
				fallbacks += 1; // the site resolved through its fallback
				return questions.map((q) => ({ kind: "Choice" as const, questionId: q.id, choice: "no", probabilities: {}, confidence: 0 }));
			},
		};
		const result = await selectSkills({ records: records(169), control, request: "fix a duplicate slug bug", config, client, loadBody: () => "" });
		expect(batches).toEqual([["any_skill"]]);
		expect(result.decision.loaded).toEqual([]);
		expect(result.decision.fallbackUsed).toBe(true);
	});

	it("asks the gate on its own and never sweeps when no skill is required", async () => {
		const { batches, client } = spyClient("no");
		const result = await selectSkills({ records: records(169), control, request: "fix a duplicate slug bug", config, client, loadBody: () => "" });
		expect(batches).toHaveLength(1);
		expect(batches[0]).toEqual(["any_skill"]);
		expect(result.decision.loaded).toEqual([]);
	});

	it("still shows every candidate to the sweep once the gate says yes", async () => {
		const { batches, client } = spyClient("yes");
		const result = await selectSkills({ records: records(169), control, request: "fix a duplicate slug bug", config, client, loadBody: () => "" });
		expect(batches[0]).toEqual(["any_skill"]);
		// No recall is traded away for the saving: the sweep sees all 169.
		expect(batches[1]?.filter((id) => id.startsWith("relevance:"))).toHaveLength(169);
		expect(result.decision.loaded.length).toBeGreaterThan(0);
	});
});
