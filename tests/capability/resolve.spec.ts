/**
 * PRD-024 Phase 3 — AC-5: `resolveRole()` consults the ranking, and the static
 * `models:` map is the provable fallback when the ranking cannot be read.
 *
 * PRD-053 AC-1: a role bound in `models:` resolves to that binding. The ranking
 * fills only a role the config leaves unbound, and a `capability.roles.<role>.pin`
 * still wins over both. The fixture binds each ranked model under a role that is
 * *not* the one the ranking would pick, so a ranking-first resolution is visibly
 * different from the binding.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_ROLES, resolveRole, type BackendRef, type LeanPiConfig, type ModelRole } from "../../src/index.js";
import { loadRanking, selectRoleModel } from "../../src/capability/index.js";
import { bootSession, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend } from "../helpers/stub-backend.js";
import { fixtureConfig, record, writeRanking } from "./fixture.js";

const RANKING = [
	record({ model_id: "ranked-quick", aliases: ["local/ranked-quick"], coding_score: 55, price_blended_per_mtok: 1 }),
	record({ model_id: "ranked-balanced", coding_score: 72, price_blended_per_mtok: 2, backend_hint: "metered" }),
	record({ model_id: "ranked-specialist", coding_score: 75, price_blended_per_mtok: 3 }),
	record({ model_id: "ranked-strong", coding_score: 88, price_blended_per_mtok: 4, backend_hint: "metered" }),
];

const DECLARED: LeanPiConfig["models"] = {
	quick: { backend: "metered", model: "ranked-balanced" },
	balanced: { backend: "metered", model: "ranked-strong" },
	strong: { backend: "local", model: "ranked-specialist" },
	review_quick: { backend: "local", model: "ranked-quick" },
	review_strong: { backend: "metered", model: "ranked-balanced" },
};

const ROLE_SETTINGS = {
	quick: { min_coding_index: 50 },
	balanced: { min_coding_index: 70 },
	strong: { min_coding_index: 85 },
	specialist: { min_coding_index: 70, pin: "ranked-specialist" },
	review_quick: { min_coding_index: 50, pin: "local/ranked-quick" },
	review_strong: { min_coding_index: 85 },
};

/** What resolves: the pin where one is set, otherwise the role's own binding. */
const RESOLVED: Record<ModelRole, BackendRef> = {
	quick: { backend: "metered", model: "ranked-balanced", type: "native" },
	balanced: { backend: "metered", model: "ranked-strong", type: "native" },
	strong: { backend: "local", model: "ranked-specialist", type: "native" },
	specialist: { backend: "local", model: "ranked-specialist", type: "native" },
	review_quick: { backend: "local", model: "ranked-quick", type: "native" },
	review_strong: { backend: "metered", model: "ranked-balanced", type: "native" },
};

/** What the static ladder returns instead, following each role's fallback chain. */
const STATIC: Record<ModelRole, BackendRef> = {
	quick: { backend: "metered", model: "ranked-balanced", type: "native" },
	balanced: { backend: "metered", model: "ranked-strong", type: "native" },
	strong: { backend: "local", model: "ranked-specialist", type: "native" },
	specialist: { backend: "metered", model: "ranked-strong", type: "native" },
	review_quick: { backend: "local", model: "ranked-quick", type: "native" },
	review_strong: { backend: "metered", model: "ranked-balanced", type: "native" },
};

function rankedConfig(models = RANKING): LeanPiConfig {
	return fixtureConfig({ models: DECLARED, capability: { rankingFile: writeRanking(models), roles: ROLE_SETTINGS } });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PRD-024 Phase 3 — resolveRole through the ranking", () => {
	it("PRD-053 AC-1: a bound role resolves to its binding even when a cheaper ranked model clears its floor", () => {
		const config = rankedConfig();
		for (const role of MODEL_ROLES) {
			expect(resolveRole(config, role)).toEqual(RESOLVED[role]);
		}
		// Only the pinned, unbound `specialist` differs from the static ladder.
		expect(MODEL_ROLES.filter((role) => JSON.stringify(RESOLVED[role]) !== JSON.stringify(STATIC[role]))).toEqual(["specialist"]);
	});

	it("PRD-053 AC-1: the ranking still fills a role the config leaves unbound", () => {
		const { specialist: _pinned, ...settings } = ROLE_SETTINGS;
		const config = fixtureConfig({ models: DECLARED, capability: { rankingFile: writeRanking(RANKING), roles: settings } });
		// Unbound and unpinned: the cheapest bound record clearing the floor of 70.
		expect(resolveRole(config, "specialist")).toEqual({ backend: "metered", model: "ranked-balanced", type: "native" });
	});

	it("PRD-053 AC-1: a booted session dispatches the declared role entry, not the ranking's cheaper pick", async () => {
		const stub = await startStubBackend([{ text: "hello" }]);
		try {
			const backends: LeanPiConfig["backends"] = {
				local: { type: "native", baseUrl: stub.baseUrl, api: "openai-completions", apiKey: "sk-stub" },
				metered: { type: "native", baseUrl: stub.baseUrl, api: "openai-completions", apiKey: "sk-stub" },
			};
			// The permission guard re-reads the project config on disk, so the same
			// backends and role map exist there; the `capability:` block rides on the
			// injected config, which is the config the session actually routes from.
			const cwd = tempDir("leanpi-capability-session-");
			writeConfig(cwd, { backends, models: DECLARED });
			const config = fixtureConfig({ backends, models: DECLARED, capability: { rankingFile: writeRanking(RANKING), roles: ROLE_SETTINGS } });
			const session = await bootSession({ cwd, agentDir: tempDir("leanpi-agent-"), config });
			try {
				// The declared `quick` entry is `metered/ranked-balanced`; the ranking
				// knows the cheaper `ranked-quick`, and the backend still sees the binding.
				expect(session.modelFor("quick")).toEqual({ provider: "metered", model: "ranked-balanced" });
				await session.runTurn({ text: "quick task", role: "quick" });
				expect(stub.requests.map((request) => request.model)).toEqual(["ranked-balanced"]);
			} finally {
				session.session.dispose();
			}
		} finally {
			await stub.close();
		}
	});

	it("AC-5: resolveRole and the selector agree, so there is no second resolution path", () => {
		const config = rankedConfig();
		const ranking = loadRanking(config);
		for (const role of MODEL_ROLES) {
			expect(resolveRole(config, role)).toEqual(selectRoleModel(role, ranking, config).ref);
		}
	});

	it("AC-5: no provider or vendor name is read on the resolution path", () => {
		const before = MODEL_ROLES.map((role) => resolveRole(rankedConfig(), role));
		const renamed = RANKING.map((model, index) => ({ ...model, provider: `vendor-${index}` }));
		expect(MODEL_ROLES.map((role) => resolveRole(rankedConfig(renamed), role))).toEqual(before);
	});

	it("AC-5: a stale ranking is reported and still used", () => {
		const config = rankedConfig(RANKING.map((model) => ({ ...model, updated_at: "2010-01-01" })));
		expect(loadRanking(config, { now: new Date("2026-09-19T00:00:00Z") }).stale).toBe(true);
		expect(MODEL_ROLES.map((role) => resolveRole(config, role))).toEqual(MODEL_ROLES.map((role) => RESOLVED[role]));
	});
});

describe("PRD-024 Phase 3 — the fallback (AC-5 negative control)", () => {
	it("AC-5: an unreadable ranking file falls back to the static models: map without throwing", () => {
		const reported: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			reported.push(String(chunk));
			return true;
		});
		const config = fixtureConfig({ models: DECLARED, capability: { rankingFile: "/nonexistent/leanpi/ranking.json", roles: ROLE_SETTINGS } });

		for (const role of MODEL_ROLES) {
			expect(resolveRole(config, role)).toEqual(STATIC[role]);
		}
		expect(reported.filter((line) => line.includes("/nonexistent/leanpi/ranking.json"))).toHaveLength(1);
		// Once per session, not once per role.
		resolveRole(config, "quick");
		expect(reported).toHaveLength(1);
	});

	it("AC-5: an invalid override falls back to the static models: map without throwing", () => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const broken = writeRanking([record({ model_id: "ranked-quick", coding_score: 120 })]);
		const config = fixtureConfig({ models: DECLARED, capability: { rankingFile: broken, roles: ROLE_SETTINGS } });
		for (const role of MODEL_ROLES) {
			expect(resolveRole(config, role)).toEqual(STATIC[role]);
		}
	});

	it("AC-5: a pin that names no record fails loudly rather than resolving something else", () => {
		const config = fixtureConfig({ models: DECLARED, capability: { rankingFile: writeRanking(RANKING), roles: { quick: { min_coding_index: 50, pin: "ghost" } } } });
		expect(() => resolveRole(config, "quick")).toThrowError(/pin names "ghost"/);
	});
});

describe("PRD-030 — a configured CLI model with no measured score", () => {
	// A CLI-backed model enters the ranking as its own record with a null score
	// and price: unmeasured, never fabricated, and never aliased to a scored
	// record. It still binds, so the configured choice resolves to itself and the
	// shortfall is reported instead of silently falling back.
	const models = [
		record({ model_id: "gpt-6-astra", aliases: ["openai/gpt-6-astra"], provider: "openai", backend_hint: "metered", coding_score: null, general_score: null, price_blended_per_mtok: null }),
	];
	const config = fixtureConfig({
		models: { strong: { backend: "metered", model: "gpt-6-astra" } },
		capability: { rankingFile: writeRanking(models), roles: { strong: { min_coding_index: 85 } } },
	});

	it("AC-4: binds as its own record and reports the capability gap", () => {
		const selection = selectRoleModel("strong", loadRanking(config), config);
		expect(selection.model_id).toBe("gpt-6-astra");
		expect(selection.ref).toEqual({ backend: "metered", model: "gpt-6-astra", type: "native" });
		expect(selection.capability_gap?.best_available).toBeNull();
		expect(selection.capability_gap?.reason).toContain("no known coding score");
	});

	it("AC-4: resolveRole returns the binding rather than the static fallback", () => {
		expect(resolveRole(config, "strong")).toEqual({ backend: "metered", model: "gpt-6-astra", type: "native" });
	});
});
