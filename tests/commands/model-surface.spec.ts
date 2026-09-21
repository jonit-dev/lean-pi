/**
 * The `/models` default view against real auto-config ids and an all-unranked
 * config.
 *
 * Kept in its own file because PRD-024 caches the parsed ranking (bound to the
 * configured backends) per process, so a fixture whose models bind ranking
 * records would otherwise seed the binding for every later fixture in the same
 * worker. These two fixtures deliberately bind nothing, so the effective
 * assignment is the static `models:` entry.
 */
import { describe, expect, it } from "vitest";
import { tempDir } from "../helpers/fixtures.js";
import { surfaceFixture } from "./helpers.js";

const STUB_SECRET = "sk-super-secret-value";
const UNRANKED_MODEL = "not-a-ranked-model";

describe("/models default assignment view (PRD-029 AC-3)", () => {
	it("states missing ranking information once for an unranked assignment", async () => {
		const cwd = tempDir("leanpi-models-unranked-");
		const fixture = surfaceFixture({
			cwd,
			config: {
				backends: { local: { type: "native", baseUrl: "https://example.test", apiKey: STUB_SECRET } },
				models: {
					quick: { backend: "local", model: UNRANKED_MODEL },
					balanced: { backend: "local", model: UNRANKED_MODEL },
					strong: { backend: "local", model: UNRANKED_MODEL },
					specialist: { backend: "local", model: UNRANKED_MODEL },
					review_quick: { backend: "local", model: UNRANKED_MODEL },
					review_strong: { backend: "local", model: UNRANKED_MODEL },
				},
			},
			name: "models-unranked",
		});

		const models = await fixture.dispatch("/models");
		expect(models.text).toContain("quick, balanced, strong, specialist, review_quick, review_strong → local/not-a-ranked-model");
		// One actionable sentence, not six near-identical `unavailable/unknown/none` rows.
		expect(models.text.match(/not in the bundled ranking/g)?.length).toBe(1);
		// No probe ran for the compact view.
		expect(models.text).not.toContain("reachable at");
		expect(models.text).not.toContain(STUB_SECRET);
	});

	it("renders the auto-config model ids in the assignment view", async () => {
		const cwd = tempDir("leanpi-models-autoconfig-");
		const fixture = surfaceFixture({
			cwd,
			config: {
				backends: {
					"opencode-go": { type: "native", baseUrl: "https://opencode.ai/zen/go/v1", apiKey: STUB_SECRET },
					claude: { type: "external_harness", vendor: "claude", command: "claude" },
				},
				models: {
					quick: { backend: "opencode-go", model: "deepseek-v4.1-flash" },
					balanced: { backend: "opencode-go", model: "deepseek-v4.1-flash" },
					review_quick: { backend: "opencode-go", model: "deepseek-v4.1-flash" },
					strong: { backend: "claude", model: "opus[1m]" },
					specialist: { backend: "claude", model: "opus[1m]" },
					review_strong: { backend: "claude", model: "opus[1m]" },
				},
			},
			name: "models-autoconfig",
		});

		const models = await fixture.dispatch("/models");
		expect(models.text).toContain("quick, balanced, review_quick → opencode-go/deepseek-v4.1-flash");
		expect(models.text).toContain("strong, specialist, review_strong → claude/opus[1m]");
		expect(models.text).not.toContain("reachable at");
	});

	it("keeps a configured role visible as unresolved and distinguishes an empty config", async () => {
		const cwd = tempDir("leanpi-models-unresolved-");
		const fixture = surfaceFixture({
			cwd,
			// A configured role whose only backend is disabled and whose fallback
			// chain is empty: `bindingFor` returns null. Grouping must not drop it.
			config: {
				backends: { ghost: { type: "native", baseUrl: "https://example.test", enabled: false } },
				models: { quick: { backend: "ghost", model: "m" } },
			},
			name: "models-unresolved",
		});
		const models = await fixture.dispatch("/models");
		expect(models.text).toContain("quick → unresolved");
		// A truly empty config never reaches the renderer: `loadConfig` rejects it
		// ("no model roles configured"), so the unresolved case is the reachable one.
		expect(models.text).not.toContain("no roles are configured");
	});
});
