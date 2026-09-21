/**
 * PRD-024 Phase 1 — AC-1 and AC-2: the bundled ranking, its validator, the
 * offline loader, the freshness report and the user override.
 */
import { readFileSync } from "node:fs";
// Mutable default bindings: ESM namespace exports of the builtins are not
// configurable, so the recording stubs are installed on the module objects.
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_ROLES, resolveRole } from "../../src/index.js";
import {
	BUNDLED_RANKING_PATH,
	capabilityRows,
	EVIDENCE_VALUES,
	loadRanking,
	parseRankingFile,
	roleResolutionsOf,
	selectCheapestClearing,
	type ModelCapability,
} from "../../src/capability/index.js";
import * as capability from "../../src/capability/index.js";
import { fixtureConfig, record, writeRanking } from "./fixture.js";

function bundled(): ModelCapability[] {
	const file = parseRankingFile(JSON.parse(readFileSync(BUNDLED_RANKING_PATH, "utf8")), BUNDLED_RANKING_PATH);
	return file.models;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PRD-024 Phase 1 — the shipped ranking", () => {
	it("AC-2: the bundled ranking validates, with unique ids, non-overlapping aliases and in-range scores", () => {
		const file = parseRankingFile(JSON.parse(readFileSync(BUNDLED_RANKING_PATH, "utf8")), BUNDLED_RANKING_PATH);
		expect(file.revision).toBeGreaterThanOrEqual(1);
		expect(file.notes.length).toBeGreaterThan(0);
		expect(file.models.length).toBeGreaterThan(0);

		const ids = file.models.map((model) => model.model_id);
		expect(new Set(ids).size).toBe(ids.length);
		const spellings = file.models.flatMap((model) => [model.model_id, ...model.aliases]);
		expect(new Set(spellings).size).toBe(spellings.length);

		for (const model of file.models) {
			expect(EVIDENCE_VALUES).toContain(model.evidence);
			expect(model.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(Number.isNaN(Date.parse(`${model.updated_at}T00:00:00Z`))).toBe(false);
			for (const score of [model.coding_score, model.general_score]) {
				if (score === null) continue;
				expect(score).toBeGreaterThanOrEqual(0);
				expect(score).toBeLessThanOrEqual(100);
			}
			expect(Array.isArray(model.specializations)).toBe(true);
		}

		// The loader agrees with the file it read, and binds what it can.
		const ranking = loadRanking(fixtureConfig());
		expect(ranking.path).toBe(BUNDLED_RANKING_PATH);
		expect(ranking.revision).toBe(file.revision);
		expect(ranking.models.map((model) => model.model_id)).toEqual(ids);
	});

	it("AC-4: CLI-backed records are their own ids with null scores, never an alias across generations", () => {
		const file = parseRankingFile(JSON.parse(readFileSync(BUNDLED_RANKING_PATH, "utf8")), BUNDLED_RANKING_PATH);
		const cliBacked = file.models.filter((model) => model.backend_hint === "claude" || model.backend_hint === "codex" || model.backend_hint === "opencode-go");
		expect(cliBacked.length).toBeGreaterThanOrEqual(4);
		for (const model of cliBacked) {
			// Unmeasured means null, never a fabricated zero or score.
			expect(model.coding_score).toBeNull();
			expect(model.price_blended_per_mtok).toBeNull();
			// An alias is a spelling of this model, never another record's id.
			for (const alias of model.aliases) expect(file.models.some((other) => other.model_id === alias)).toBe(false);
		}
		// A moving vendor alias resolves to its own generation's record, not another's.
		expect(file.models.find((model) => model.aliases.includes("opus"))?.model_id).toBe("claude-opus-5");
		expect(file.models.find((model) => model.aliases.includes("gpt-5"))).toBeUndefined();
	});

	it("AC-2: a validation failure names the record and the field", () => {
		const path = writeRanking([record({ model_id: "too-strong", coding_score: 120 })]);
		expect(() => loadRanking(fixtureConfig({ capability: { rankingFile: path } }))).toThrowError(/record "too-strong" field "coding_score"/);

		const missing = record({ model_id: "no-evidence" });
		delete (missing as { evidence?: unknown }).evidence;
		const second = writeRanking([missing]);
		expect(() => loadRanking(fixtureConfig({ capability: { rankingFile: second } }))).toThrowError(/record "no-evidence" field "evidence"/);
	});
});

describe("PRD-024 Phase 1 — freshness", () => {
	const staleModels = [record({ model_id: "aged", coding_score: 90, price_blended_per_mtok: 1, updated_at: "2020-01-01" })];

	it("AC-2: the stale flag follows the oldest role-filling record, and reports it either way", () => {
		const path = writeRanking(staleModels);
		const now = new Date("2021-01-01T00:00:00Z");
		const stale = loadRanking(fixtureConfig({ capability: { rankingFile: path } }), { now });
		expect(stale.oldest_updated_at).toBe("2020-01-01");
		expect(stale.age_days).toBe(366);
		expect(stale.stale).toBe(true);
		expect(stale.staleness_days).toBe(90);

		// Negative control against a constant: the same file and clock inside the
		// window reports false, so the flag is computed from the dates, not fixed.
		const fresh = loadRanking(fixtureConfig({ capability: { rankingFile: path } }), { now: new Date("2020-02-01T00:00:00Z") });
		expect(fresh.age_days).toBe(31);
		expect(fresh.stale).toBe(false);

		const patient = loadRanking(fixtureConfig({ capability: { rankingFile: path, stalenessDays: 400 } }), { now });
		expect(patient.stale).toBe(false);
		expect(patient.staleness_days).toBe(400);
	});
});

describe("PRD-024 Phase 1 — the user override", () => {
	it("AC-2: a valid override replaces the bundled ranking wholesale", () => {
		const path = writeRanking([record({ model_id: "mine", coding_score: 90, price_blended_per_mtok: 0.5 })], 42);
		const config = fixtureConfig({ models: { quick: { backend: "local", model: "mine" } }, capability: { rankingFile: path } });
		const ranking = loadRanking(config);
		expect(ranking.revision).toBe(42);
		expect(ranking.path).toBe(path);
		expect(ranking.notes).toBe("fixture ranking");
		expect(ranking.models.map((model) => model.model_id)).toEqual(["mine"]);
		expect(ranking.models[0]!.backend_binding).toEqual({ backend: "local", model: "mine", type: "native" });
	});

	it("AC-2: an unreadable override names the file instead of using the bundled ranking", () => {
		const config = fixtureConfig({ capability: { rankingFile: "/nonexistent/leanpi/models.json" } });
		expect(() => loadRanking(config)).toThrowError(/\/nonexistent\/leanpi\/models\.json/);
	});

	it("AC-2: a record is bound only where the config declares it, with backend_hint choosing among declarations", () => {
		const models = [record({ model_id: "dual", backend_hint: "metered", coding_score: 80, price_blended_per_mtok: 2 })];
		const path = writeRanking(models);
		const declaredOnBoth = fixtureConfig({
			models: { quick: { backend: "local", model: "dual" }, balanced: { backend: "metered", model: "dual" } },
			capability: { rankingFile: path },
		});
		expect(loadRanking(declaredOnBoth).models[0]!.backend_binding).toEqual({ backend: "metered", model: "dual", type: "native" });

		const declaredOnce = fixtureConfig({ models: { quick: { backend: "local", model: "dual" } }, capability: { rankingFile: path } });
		expect(loadRanking(declaredOnce).models[0]!.backend_binding).toEqual({ backend: "local", model: "dual", type: "native" });

		// An alias spelling is the same declaration, and an undeclared record stays visible but unbound.
		const aliased = fixtureConfig({ models: { quick: { backend: "metered", model: "provider/dual" } }, capability: { rankingFile: writeRanking([{ ...models[0]!, aliases: ["provider/dual"] }]) } });
		expect(loadRanking(aliased).models[0]!.backend_binding).toEqual({ backend: "metered", model: "provider/dual", type: "native" });
		expect(loadRanking(fixtureConfig({ capability: { rankingFile: path } })).models[0]!.backend_binding).toBeNull();
	});
});

describe("PRD-024 Phase 1 — AC-1: nothing on this path reaches the network", () => {
	it("loads, resolves, selects and builds rows with every network entry point recorded and throwing", () => {
		const attempted: string[] = [];
		const deny = (name: string) => () => {
			attempted.push(name);
			throw new Error(`${name} must not be called by PRD-024`);
		};
		const stub = <T>(target: T, key: keyof T, name: string): void => {
			vi.spyOn(target, key).mockImplementation(deny(name) as never);
		};
		vi.spyOn(globalThis, "fetch").mockImplementation(deny("fetch") as typeof fetch);
		stub(http, "request", "http.request");
		stub(http, "get", "http.get");
		stub(https, "request", "https.request");
		stub(https, "get", "https.get");
		stub(childProcess, "spawn", "spawn");
		stub(childProcess, "spawnSync", "spawnSync");
		stub(childProcess, "exec", "exec");
		stub(childProcess, "execFile", "execFile");
		stub(childProcess, "execSync", "execSync");
		stub(childProcess, "execFileSync", "execFileSync");
		stub(childProcess, "fork", "fork");

		const path = writeRanking([
			record({ model_id: "bound", coding_score: 90, price_blended_per_mtok: 1, specializations: ["rust"] }),
			record({ model_id: "unbound", backend_hint: "absent", coding_score: 95, price_blended_per_mtok: 9 }),
		]);
		const config = fixtureConfig({ models: { quick: { backend: "local", model: "bound" } }, capability: { rankingFile: path } });
		const ranking = loadRanking(config);
		const resolutions = roleResolutionsOf(ranking, config);
		selectCheapestClearing(ranking, { min_coding_index: 80, specialization: "rust" }, config);
		capabilityRows(ranking, resolutions);
		for (const role of MODEL_ROLES) resolveRole(config, role);

		expect(attempted).toEqual([]);

		// Negative control for the recorder itself: a deliberate call is caught, so
		// a `fetch()` added to the loader would fail this spec rather than pass it.
		expect(() => (globalThis.fetch as unknown as () => unknown)("http://example.invalid/")).toThrowError(/must not be called/);
		expect(attempted).toEqual(["fetch"]);
	});

	it("AC-1: the module exposes no fetch, refresh or cache entry point, and no refresh script exists", () => {
		expect(Object.keys(capability).filter((name) => /fetch|refresh|cache|livecatalog|network|http/i.test(name))).toEqual([]);

		const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts?: Record<string, string> };
		const scripts = Object.entries(packageJson.scripts ?? {});
		expect(scripts.filter(([name, command]) => /refresh|capability/i.test(name) || /refresh|capability/i.test(command))).toEqual([]);
	});
});
