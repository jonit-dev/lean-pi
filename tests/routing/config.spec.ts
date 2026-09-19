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
