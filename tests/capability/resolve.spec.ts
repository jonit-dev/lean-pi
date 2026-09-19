/**
 * PRD-024 Phase 3 — AC-5: `resolveRole()` consults the ranking, and the static
 * `models:` map is the provable fallback when the ranking cannot be read.
 *
 * Reachability is a config declaration, so the fixture declares four ranked
 * models — each under a role that is *not* the one the ranking picks, which is
 * what makes the two paths distinguishable: the same six calls return the
 * declared entry when the ranking is unreadable, and the ranking's cheapest
 * clearing record when it is not.
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

/** What the ranking picks: the cheapest bound record clearing each role's floor. */
const RANKED: Record<ModelRole, BackendRef> = {
	quick: { backend: "local", model: "ranked-quick", type: "native" },
	balanced: { backend: "metered", model: "ranked-balanced", type: "native" },
	strong: { backend: "metered", model: "ranked-strong", type: "native" },
	specialist: { backend: "local", model: "ranked-specialist", type: "native" },
	review_quick: { backend: "local", model: "ranked-quick", type: "native" },
	review_strong: { backend: "metered", model: "ranked-strong", type: "native" },
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
	it("AC-5: all six roles resolve to the ranking-selected model for their configured floors and ceilings", () => {
		const config = rankedConfig();
		for (const role of MODEL_ROLES) {
			expect(resolveRole(config, role)).toEqual(RANKED[role]);
		}
		// Five of the six differ from the declared entry, so a static resolution
		// could not have produced these answers.
		expect(MODEL_ROLES.filter((role) => JSON.stringify(RANKED[role]) !== JSON.stringify(STATIC[role]))).toHaveLength(5);
	});

	it("AC-5: a booted session resolves and dispatches the ranking's pick, not the declared role entry", async () => {
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
				// picks the cheaper clearing record, and that is what the backend sees.
				expect(session.modelFor("quick")).toEqual({ provider: "local", model: "ranked-quick" });
				await session.runTurn({ text: "quick task", role: "quick" });
				expect(stub.requests.map((request) => request.model)).toEqual(["ranked-quick"]);
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
		expect(MODEL_ROLES.map((role) => resolveRole(config, role))).toEqual(MODEL_ROLES.map((role) => RANKED[role]));
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
