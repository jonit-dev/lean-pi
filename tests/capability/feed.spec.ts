/**
 * PRD-024 Phase 3 — AC-6: `capabilityRows()` is a projection of the ranking plus
 * the current role resolutions, never a second list of models.
 */
import { describe, expect, it } from "vitest";
import { MODEL_ROLES } from "../../src/index.js";
import { capabilityRows, loadRanking, roleResolutionsOf, type CapabilityRow } from "../../src/capability/index.js";
import { fixtureConfig, record, writeRanking } from "./fixture.js";

const RANKING = [
	record({ model_id: "ranked-quick", coding_score: 55, price_blended_per_mtok: 1, evidence: "measured" }),
	record({ model_id: "ranked-balanced", coding_score: 72, price_blended_per_mtok: 2 }),
	record({ model_id: "ranked-strong", coding_score: 88, price_blended_per_mtok: 4, backend_hint: "metered" }),
	record({ model_id: "unbound", backend_hint: "absent", coding_score: 95, price_blended_per_mtok: 9 }),
];

const ROLE_SETTINGS = { quick: { min_coding_index: 50 }, balanced: { min_coding_index: 70 }, strong: { min_coding_index: 85 } };

/** Reachability is a config declaration; `unbound` is deliberately declared nowhere. */
const DECLARED = {
	quick: { backend: "local", model: "ranked-quick" },
	balanced: { backend: "local", model: "ranked-balanced" },
	strong: { backend: "metered", model: "ranked-strong" },
};

function fixture(models = RANKING, roles: unknown = ROLE_SETTINGS) {
	const config = fixtureConfig({ models: DECLARED, capability: { rankingFile: writeRanking(models), roles } });
	const ranking = loadRanking(config);
	return { ranking, config, rows: capabilityRows(ranking, roleResolutionsOf(ranking, config)) };
}

function byId(rows: CapabilityRow[]) {
	return new Map(rows.map((row) => [row.model_id, row]));
}

describe("PRD-024 Phase 3 — capabilityRows", () => {
	it("AC-6: one row per ranked record, each value equal to the record it came from", () => {
		const { ranking, rows } = fixture();
		expect(rows).toHaveLength(ranking.models.length);
		expect(rows.map((row) => row.model_id).sort()).toEqual(["ranked-balanced", "ranked-quick", "ranked-strong", "unbound"]);

		for (const model of ranking.models) {
			const row = byId(rows).get(model.model_id)!;
			expect(row.coding_score).toBe(model.coding_score);
			expect(row.general_score).toBe(model.general_score);
			expect(row.price_blended_per_mtok).toBe(model.price_blended_per_mtok);
			expect(row.evidence).toBe(model.evidence);
			expect(row.provider).toBe(model.provider);
			expect(row.backend_binding).toEqual(model.backend_binding);
			expect(row.revision).toBe(ranking.revision);
			expect(row.oldest_updated_at).toBe(ranking.oldest_updated_at);
			expect(row.age_days).toBe(ranking.age_days);
			expect(row.stale).toBe(ranking.stale);
		}
		// A record with no reachable backend is visible but unfilled, and the
		// evidence split is carried through rather than normalised.
		expect(byId(rows).get("unbound")!.backend_binding).toBeNull();
		expect(byId(rows).get("unbound")!.roles).toEqual([]);
		expect(byId(rows).get("ranked-quick")!.evidence).toBe("measured");
	});

	it("AC-6: the role column is the current resolution, in MODEL_ROLES order", () => {
		const { rows } = fixture();
		expect(byId(rows).get("ranked-quick")!.roles).toEqual(["quick"]);
		expect(byId(rows).get("ranked-balanced")!.roles).toEqual(["balanced", "specialist", "review_quick"]);
		expect(byId(rows).get("ranked-strong")!.roles).toEqual(["strong", "review_strong"]);
		expect(byId(rows).get("unbound")!.roles).toEqual([]);
	});

	it("AC-6: role-filled rows lead, then coding_score descending then model_id", () => {
		const { rows } = fixture();
		expect(rows.map((row) => row.model_id)).toEqual(["ranked-strong", "ranked-balanced", "ranked-quick", "unbound"]);
		// The unfilled row scores highest of all: the ordering is role-fill first.
		expect(byId(rows).get("unbound")!.coding_score).toBe(95);
	});

	it("AC-6: adding a record to the ranking adds exactly one row", () => {
		const before = fixture();
		const after = fixture([...RANKING, record({ model_id: "extra", coding_score: 60, price_blended_per_mtok: 6 })]);
		expect(after.rows).toHaveLength(before.rows.length + 1);
		expect(after.rows.map((row) => row.model_id)).toContain("extra");
	});

	it("AC-6: changing a role pin changes only the role-fill column, with the ranking file untouched", () => {
		const before = fixture();
		const after = fixture(RANKING, { ...ROLE_SETTINGS, quick: { min_coding_index: 50, pin: "unbound" } });

		const withoutRoles = (rows: CapabilityRow[]) => rows.map(({ roles, ...rest }) => rest).sort((a, b) => (a.model_id < b.model_id ? -1 : 1));
		expect(withoutRoles(after.rows)).toEqual(withoutRoles(before.rows));
		expect(after.rows).toHaveLength(before.rows.length);

		expect(byId(before.rows).get("ranked-quick")!.roles).toEqual(["quick"]);
		expect(byId(after.rows).get("ranked-quick")!.roles).toEqual([]);
		expect(byId(after.rows).get("unbound")!.roles).toEqual(["quick"]);
	});
});
