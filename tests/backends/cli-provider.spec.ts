/**
 * Subscription backends as Pi providers.
 *
 * A subscription role (`strong: claude/opus`) is an `external_harness`:
 * `registerBackends` registers only native ones, so the role's model never
 * entered Pi's registry. A subagent planner then saw only Pi's metered built-in
 * `opencode/claude-*`, and an Opus task left the operator's Claude subscription
 * unused. These register the subscription's role models as `<backend>-cli`.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/index.js";
import { registerCliModel, registerSubscriptionModels } from "../../src/backends/cli-provider.js";
import { tempDir } from "../helpers/fixtures.js";

function capture(): { providers: Map<string, { models: Array<{ id: string }> }>; pi: { registerProvider: (name: string, config: unknown) => void } } {
	const providers = new Map<string, { models: Array<{ id: string }> }>();
	return { providers, pi: { registerProvider: (name, config) => void providers.set(name, config as { models: Array<{ id: string }> }) } };
}

function configWithHarness() {
	return loadConfig(tempDir("leanpi-cli-provider-"), {
		configPath: null,
		backends: {
			claude: { type: "external_harness", vendor: "claude" },
			codex: { type: "external_harness", vendor: "codex" },
		},
		models: {
			quick: { backend: "claude", model: "haiku" },
			strong: { backend: "claude", model: "opus" },
			specialist: { backend: "codex", model: "gpt-6-astra" },
		},
	});
}

const state = (backend: string, usable: boolean) =>
	({ backend, vendor: backend, command: backend, onPath: usable, signedIn: usable, evidence: "" }) as never;

describe("subscription models as Pi providers", () => {
	it("registers a usable subscription's role models under <backend>-cli, and only those", () => {
		const { providers, pi } = capture();
		registerSubscriptionModels(pi, { config: configWithHarness(), cwd: tempDir(), env: process.env }, [state("claude", true), state("codex", false)]);
		expect(providers.get("claude-cli")!.models.map((model) => model.id).sort()).toEqual(["haiku", "opus"]);
		// Signed out: never offered, so a pick cannot spend a turn discovering it.
		expect(providers.has("codex-cli")).toBe(false);
	});

	it("registers a pinned subscription even when the probe says unavailable", () => {
		const { providers, pi } = capture();
		registerSubscriptionModels(pi, { config: configWithHarness(), cwd: tempDir(), env: process.env }, [state("codex", false)], [
			{ backend: "codex", model: "gpt-6-astra", type: "external_harness" },
		]);
		expect(providers.get("codex-cli")!.models.map((model) => model.id)).toEqual(["gpt-6-astra"]);
	});

	it("keeps the config's models when a /model pin registers one", () => {
		const { providers, pi } = capture();
		registerCliModel(pi, { config: configWithHarness(), cwd: tempDir(), env: process.env }, { backend: "claude", model: "sonnet", type: "external_harness" });
		// A pick must not replace the provider down to a single model — a subagent
		// planning on another subscription model still has to find it.
		expect(providers.get("claude-cli")!.models.map((model) => model.id).sort()).toEqual(["haiku", "opus", "sonnet"]);
	});
});
