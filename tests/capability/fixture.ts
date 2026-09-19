/** Fixtures shared by the PRD-024 specs: a ranking file, and a config pointing at it. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type LeanPiConfig, type ModelCapability } from "../../src/index.js";
import { tempDir } from "../helpers/fixtures.js";

/** A complete, valid record; override only what the case is about. */
export function record(overrides: Partial<ModelCapability> & { model_id: string }): ModelCapability {
	return {
		aliases: [],
		provider: "fixture",
		backend_hint: "local",
		coding_score: 70,
		general_score: 70,
		specializations: [],
		price_input_per_mtok: null,
		price_output_per_mtok: null,
		price_blended_per_mtok: 1,
		speed_tier: "medium",
		context_window: null,
		updated_at: "2026-09-01",
		evidence: "estimated",
		...overrides,
	};
}

/** Write a ranking override and return its path. */
export function writeRanking(models: ModelCapability[], revision = 7): string {
	const path = join(tempDir("leanpi-ranking-"), "models.json");
	writeFileSync(path, JSON.stringify({ revision, notes: "fixture ranking", models }, null, 2));
	return path;
}

export interface FixtureOptions {
	backends?: LeanPiConfig["backends"];
	models?: LeanPiConfig["models"];
	/** The structural `capability:` block PRD-024 reads (`rankingFile`, `stalenessDays`, `roles`). */
	capability?: unknown;
}

export function fixtureConfig(options: FixtureOptions = {}): LeanPiConfig {
	const cwd = tempDir("leanpi-capability-");
	const config = loadConfig(cwd, {
		configPath: null,
		backends: options.backends ?? {
			local: { type: "native", baseUrl: "http://127.0.0.1:9/v1" },
			metered: { type: "native", baseUrl: "http://127.0.0.1:9/v2", quota_class: "scarce-premium" },
		},
		models: options.models ?? { quick: { backend: "local", model: "static-quick" } },
	});
	return { ...config, ...(options.capability === undefined ? {} : { capability: options.capability }) } as LeanPiConfig;
}
