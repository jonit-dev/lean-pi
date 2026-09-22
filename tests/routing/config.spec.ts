/**
 * FR-047 — `models.specialists` is a second map under `models:`, not a seventh
 * role. The operator path is a config file, so the parse and every consumer
 * that walks the role map are covered here together: the routing surface must
 * read the key, and the binding derivations must be byte-identical to a config
 * that never declared it.
 */
import { describe, expect, it } from "vitest";
import { parseBackendPool } from "../../src/backends/registry.js";
import { loadRanking } from "../../src/capability/index.js";
import { ConfigError } from "../../src/core/config.js";
import { loadConfig, type LeanPiConfig } from "../../src/index.js";
import { defaultClearingSource } from "../../src/routing/candidates.js";
import { resolveRoutingConfig } from "../../src/routing/config.js";
import { nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { rankingRecord, writeRanking } from "./fixture.js";

const SPECIALISTS = { rust: "strong", typescript: "balanced" };

/** A config file an operator could write, with and without the specialists map. */
function configFrom(specialists?: Record<string, string>): LeanPiConfig {
	const cwd = tempDir("leanpi-specialists-");
	const rankingPath = writeRanking(
		[rankingRecord({ model_id: "balanced-model", backend_hint: "local", coding_score: 80, input: 1, output: 3 })],
		cwd,
	);
	writeConfig(cwd, {
		backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
		models: {
			balanced: { backend: "local", model: "balanced-model" },
			strong: { backend: "local", model: "balanced-model" },
			...(specialists ? { specialists } : {}),
		},
		capability: { rankingFile: rankingPath },
	});
	return loadConfig(cwd);
}

describe("FR-047 — specialists reach the router through a config file", () => {
	it("resolves the specialists declared in `models:` into the routing surface", () => {
		expect(resolveRoutingConfig(configFrom(SPECIALISTS)).specialists).toEqual(SPECIALISTS);
		expect(resolveRoutingConfig(configFrom()).specialists).toEqual({});
	});

	it("derives the same backend pool, ranking bindings and candidate roles with the map present", () => {
		const withMap = configFrom(SPECIALISTS);
		const without = configFrom();

		expect(parseBackendPool(withMap)).toEqual(parseBackendPool(without));
		expect(parseBackendPool(withMap)[0]?.modelsByRole).toEqual({ balanced: "balanced-model", strong: "balanced-model" });

		expect(loadRanking(withMap).models[0]?.backend_binding).toEqual({ backend: "local", model: "balanced-model", type: "native" });

		const clearing = defaultClearingSource(withMap)({ required: { min_coding_index: 70 }, config: withMap });
		expect(clearing.candidates.map((candidate) => candidate.roles)).toEqual([["balanced", "strong"]]);
	});
});

/**
 * COST-4 + reachability: the `routing:` block is a documented configuration
 * surface, so its values must reach `resolveRoutingConfig` through a real file,
 * and an out-of-range cached fraction is a named load error rather than a
 * silently ignored key.
 */
describe("the routing: block reaches the resolved surface; invalid fraction fails load", () => {
	function loadRouting(routing: unknown): LeanPiConfig {
		const cwd = tempDir("leanpi-routing-load-");
		writeConfig(cwd, {
			backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
			models: { balanced: { backend: "local", model: "balanced-model" } },
			routing,
		});
		return loadConfig(cwd);
	}

	it("carries the declared routing values through loadConfig", () => {
		const routing = resolveRoutingConfig(loadRouting({ predicted_cached_input_fraction: 0.25, tie_band_usd: 0.5 }));
		expect(routing.predicted_cached_input_fraction).toBe(0.25);
		expect(routing.tie_band_usd).toBe(0.5);
	});

	it("accepts a legitimate zero cached fraction", () => {
		expect(resolveRoutingConfig(loadRouting({ predicted_cached_input_fraction: 0 })).predicted_cached_input_fraction).toBe(0);
	});

	it("rejects a cached fraction outside [0,1] with a named error", () => {
		expect(() => loadRouting({ predicted_cached_input_fraction: 2 })).toThrowError(ConfigError);
		expect(() => loadRouting({ predicted_cached_input_fraction: -0.1 })).toThrowError(/routing\.predicted_cached_input_fraction/);
	});

	it("rejects an override-injected fraction outside [0,1] at resolution", () => {
		const config = loadRouting({ predicted_cached_input_fraction: 0.25 });
		expect(() => resolveRoutingConfig({ ...config, routing: { predicted_cached_input_fraction: 2 } })).toThrowError(ConfigError);
	});
});
