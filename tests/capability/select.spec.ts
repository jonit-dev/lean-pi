/**
 * PRD-024 Phase 2 — AC-3 and AC-4: `required_capability` selection and role
 * binding, including the pin and the visible escalation.
 */
import { describe, expect, it } from "vitest";
import type { LeanPiConfig } from "../../src/index.js";
import { loadRanking, selectCheapestClearing, selectRoleModel, type CapabilityCandidate, type Ranking } from "../../src/capability/index.js";
import { fixtureConfig, record, writeRanking } from "./fixture.js";

/**
 * The unambiguous fixture: `a-cheap` is the cheapest clearing record, `d-strong-nospec`
 * clears and is pricier, `c-strong` clears, is pricier still and scores highest, and
 * `f-unbound` scores higher than every one of them but has no reachable backend.
 */
const MAIN = [
	record({ model_id: "a-cheap", coding_score: 60, price_blended_per_mtok: 1, specializations: ["typescript"] }),
	record({ model_id: "b-mid", aliases: ["local/b-mid"], coding_score: 75, price_blended_per_mtok: 3, specializations: ["typescript"] }),
	record({ model_id: "c-strong", coding_score: 90, price_blended_per_mtok: 5, specializations: ["rust"], backend_hint: "metered" }),
	record({ model_id: "d-strong-nospec", coding_score: 80, price_blended_per_mtok: 2 }),
	record({ model_id: "e-unscored", coding_score: null, price_blended_per_mtok: 0.1 }),
	record({ model_id: "f-unbound", backend_hint: "absent", coding_score: 95, price_blended_per_mtok: 9 }),
];

/**
 * Reachability is a config declaration (PRD-024 §Solution: a record with no
 * reachable binding is visible but not selectable), so every record but
 * `f-unbound` is declared — the role key it is declared under does not affect
 * what the capability floors select.
 */
const DECLARED: LeanPiConfig["models"] = {
	quick: { backend: "local", model: "a-cheap" },
	balanced: { backend: "local", model: "b-mid" },
	strong: { backend: "metered", model: "c-strong" },
	specialist: { backend: "local", model: "d-strong-nospec" },
	review_quick: { backend: "local", model: "e-unscored" },
};

function main(roles?: unknown): { ranking: Ranking; config: LeanPiConfig } {
	const config = fixtureConfig({ models: DECLARED, capability: { rankingFile: writeRanking(MAIN), ...(roles === undefined ? {} : { roles }) } });
	return { ranking: loadRanking(config), config };
}

const ids = (candidates: readonly CapabilityCandidate[]): string[] => candidates.map((candidate) => candidate.model_id);

describe("PRD-024 Phase 2 — selectCheapestClearing", () => {
	it("AC-3: a low floor takes the cheapest clearing record, not the highest-scoring one", () => {
		const { ranking, config } = main();
		const selection = selectCheapestClearing(ranking, { min_coding_index: 50 }, config);

		expect(selection.ref).toEqual({ backend: "local", model: "a-cheap", type: "native" });
		expect(selection.capability_gap).toBeUndefined();
		expect(selection.candidates[0]!.model_id).toBe("a-cheap");
		expect(ids(selection.candidates).sort()).toEqual(["a-cheap", "b-mid", "c-strong", "d-strong-nospec"]);

		// "cheapest clearing", proved rather than assumed: a pricier clearing record
		// and a higher-scoring pricier record both exist, and neither is chosen.
		expect(selection.candidates.map((candidate) => candidate.price_blended_per_mtok)).toEqual([1, 2, 3, 5]);
		expect(selection.candidates.find((candidate) => candidate.model_id === "c-strong")!.coding_score).toBeGreaterThan(selection.candidates[0]!.coding_score);
		expect(selection.candidates.filter((candidate) => candidate.coding_score >= 50).every((candidate) => (candidate.price_blended_per_mtok ?? Number.POSITIVE_INFINITY) >= 1)).toBe(true);
	});

	it("AC-3: raising the floor moves the selection to the record only that floor clears", () => {
		const { ranking, config } = main();
		expect(selectCheapestClearing(ranking, { min_coding_index: 50 }, config).ref!.model).toBe("a-cheap");
		expect(selectCheapestClearing(ranking, { min_coding_index: 85 }, config).ref!.model).toBe("c-strong");
		const raised = selectCheapestClearing(ranking, { min_coding_index: 70 }, config);
		expect(raised.ref!.model).toBe("d-strong-nospec");
		expect(raised.candidates.every((candidate) => candidate.coding_score >= 70)).toBe(true);
	});

	it("AC-3: a specialization selects the cheapest tagged record and skips cheaper untagged ones", () => {
		const { ranking, config } = main();
		const selection = selectCheapestClearing(ranking, { min_coding_index: 50, specialization: "rust" }, config);
		expect(ids(selection.candidates)).toEqual(["c-strong"]);
		expect(selection.ref).toEqual({ backend: "metered", model: "c-strong", type: "native" });
		// `a-cheap` (1) and `d-strong-nospec` (2) are both cheaper and both untagged.
		expect(ranking.models.find((model) => model.model_id === "a-cheap")!.price_blended_per_mtok).toBeLessThan(5);
		expect(ranking.models.find((model) => model.model_id === "d-strong-nospec")!.specializations).toEqual([]);
	});

	it("AC-3: a record with a null coding score is visible but never selected automatically", () => {
		const { ranking, config } = main();
		const selection = selectCheapestClearing(ranking, { min_coding_index: 0 }, config);
		expect(ids(selection.candidates)).not.toContain("e-unscored");
		// ...even though it is the cheapest record in the ranking.
		expect(ranking.models.find((model) => model.model_id === "e-unscored")!.coding_score).toBeNull();
		expect(ranking.models.find((model) => model.model_id === "e-unscored")!.price_blended_per_mtok).toBe(0.1);
	});

	it("AC-4: an unclearable bar escalates visibly instead of throwing or downgrading silently", () => {
		const { ranking, config } = main();
		const selection = selectCheapestClearing(ranking, { min_coding_index: 99 }, config);
		expect(selection.candidates).toEqual([]);
		expect(selection.capability_gap).toBeDefined();
		expect(selection.capability_gap!.requested).toBe(99);
		// `f-unbound` scores 95 but has no reachable backend, so it is not the escalation.
		expect(selection.capability_gap!.best_available).toBe(90);
		expect(selection.ref).toEqual({ backend: "metered", model: "c-strong", type: "native" });
		expect(selection.capability_gap!.reason).toMatch(/no bound model clears/);
	});

	it("AC-4: with no reachable backend at all the gap names that, and nothing is selected", () => {
		const config = fixtureConfig({
			backends: { local: { type: "native", baseUrl: "http://127.0.0.1:9/v1", enabled: false } },
			models: { quick: { backend: "local", model: "static-quick" } },
			capability: { rankingFile: writeRanking(MAIN) },
		});
		const selection = selectCheapestClearing(loadRanking(config), { min_coding_index: 50 }, config);
		expect(selection.ref).toBeNull();
		expect(selection.candidates).toEqual([]);
		expect(selection.capability_gap!.best_available).toBeNull();
		expect(selection.capability_gap!.reason).toMatch(/no ranked model has a reachable backend/);
	});

	it("AC-3: candidates carry the quota class the config prices scarcity by", () => {
		const { ranking, config } = main();
		const selection = selectCheapestClearing(ranking, { min_coding_index: 50 }, config);
		expect(selection.candidates.find((candidate) => candidate.model_id === "c-strong")!.quota_class).toBe("scarce-premium");
		expect(selection.candidates.find((candidate) => candidate.model_id === "a-cheap")!.quota_class).toBeNull();
	});
});

describe("PRD-024 Phase 2 — selectRoleModel and pins", () => {
	it("AC-4: a pin wins over a cheaper record that clears the same bounds", () => {
		const { ranking, config } = main({ quick: { min_coding_index: 50, pin: "b-mid" } });
		const selection = selectRoleModel("quick", ranking, config);
		expect(selection).toMatchObject({ role: "quick", model_id: "b-mid", pinned: true });
		expect(selection.ref).toEqual({ backend: "local", model: "b-mid", type: "native" });
		expect(selection.capability_gap).toBeUndefined();
		// The unpinned role would have taken the cheaper `a-cheap`.
		expect(selectRoleModel("quick", ranking, fixtureConfig({ models: DECLARED, capability: { rankingFile: writeRanking(MAIN) } })).model_id).toBe("a-cheap");
	});

	it("AC-4: an alias pin resolves to the same record as its model_id", () => {
		const { ranking, config } = main({ strong: { min_coding_index: 50, pin: "local/b-mid" } });
		const byAlias = selectRoleModel("strong", ranking, config);
		const byId = selectRoleModel("strong", ranking, main({ strong: { min_coding_index: 50, pin: "b-mid" } }).config);
		expect(byAlias.model_id).toBe("b-mid");
		expect({ model_id: byAlias.model_id, ref: byAlias.ref }).toEqual({ model_id: byId.model_id, ref: byId.ref });
	});

	it("AC-4: a pin below the role floor is returned with its shortfall reported", () => {
		const { ranking, config } = main({ strong: { min_coding_index: 85, pin: "a-cheap" } });
		const selection = selectRoleModel("strong", ranking, config);
		expect(selection.model_id).toBe("a-cheap");
		expect(selection.ref).toEqual({ backend: "local", model: "a-cheap", type: "native" });
		expect(selection.capability_gap!.requested).toBe(85);
		expect(selection.capability_gap!.best_available).toBe(60);
		expect(selection.capability_gap!.reason).toMatch(/scores 60 below the strong floor 85/);
	});

	it("AC-4: a pin with no reachable backend is returned with its shortfall reported", () => {
		const { ranking, config } = main({ strong: { min_coding_index: 50, pin: "f-unbound" } });
		const selection = selectRoleModel("strong", ranking, config);
		expect(selection.model_id).toBe("f-unbound");
		expect(selection.ref).toBeNull();
		expect(selection.capability_gap!.reason).toMatch(/has no reachable backend binding/);
	});

	it("AC-3: a role's price ceiling bounds the clearing set, and escalates visibly when nothing fits", () => {
		const bound = main({ quick: { min_coding_index: 50, max_blended_price: 1.5 } });
		const selection = selectRoleModel("quick", bound.ranking, bound.config);
		expect(selection.model_id).toBe("a-cheap");
		expect(selection.capability_gap).toBeUndefined();

		const tight = main({ quick: { min_coding_index: 50, max_blended_price: 0.5 } });
		const escalated = selectRoleModel("quick", tight.ranking, tight.config);
		expect(escalated.model_id).toBe("c-strong");
		expect(escalated.capability_gap!.best_available).toBe(90);
		expect(escalated.capability_gap!.reason).toMatch(/within the price ceiling 0.5/);
	});

	it("AC-3: ties resolve by higher coding_score then model_id, so the result is deterministic", () => {
		const tied = [
			record({ model_id: "b-tie", coding_score: 70, price_blended_per_mtok: 2 }),
			record({ model_id: "a-tie", coding_score: 70, price_blended_per_mtok: 2 }),
		];
		const config = fixtureConfig({ models: { quick: { backend: "local", model: "b-tie" }, balanced: { backend: "local", model: "a-tie" } }, capability: { rankingFile: writeRanking(tied) } });
		expect(selectRoleModel("quick", loadRanking(config), config).model_id).toBe("a-tie");

		const withHigher = [...tied, record({ model_id: "c-higher", coding_score: 72, price_blended_per_mtok: 2 })];
		const higherConfig = fixtureConfig({ models: { quick: { backend: "local", model: "b-tie" }, balanced: { backend: "local", model: "a-tie" }, strong: { backend: "local", model: "c-higher" } }, capability: { rankingFile: writeRanking(withHigher) } });
		expect(selectRoleModel("quick", loadRanking(higherConfig), higherConfig).model_id).toBe("c-higher");
	});

	it("AC-4: a pin naming no record is a config error, not a silent fallback", () => {
		const config = fixtureConfig({ models: DECLARED, capability: { rankingFile: writeRanking(MAIN), roles: { quick: { min_coding_index: 50, pin: "ghost" } } } });
		const ranking = loadRanking(config);
		expect(() => selectRoleModel("quick", ranking, config)).toThrowError(/capability\.roles\.quick\.pin names "ghost"/);
	});
});
