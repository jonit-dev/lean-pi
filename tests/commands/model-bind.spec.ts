/**
 * The subscription models a machine has, listed and bound (PRD-030 root 4).
 *
 * Discovery already found every Claude and Codex model on the machine; what was
 * missing was any surface that showed them and any writer that bound one. The
 * fixture is a home directory with the two vendors' own artifacts and a PATH
 * carrying their commands, so the listing and the write run against the real
 * detection rather than a stub of it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandRegistry, loadConfig, resolveRole } from "../../src/index.js";
import { createCommandSurface, createSessionHost, registerCommandSurface } from "../../src/commands/index.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { tempDir, writeConfig } from "../helpers/fixtures.js";
import type { CommandContext } from "../../src/commands/registry.js";
import type { ModelPick } from "../../src/cli/model-picker.js";

function fixture() {
	const cwd = tempDir("leanpi-bind-");
	const home = join(cwd, "home");
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(join(home, ".claude.json"), JSON.stringify({ model: "opus[1m]" }));
	writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
	mkdirSync(join(home, ".codex"), { recursive: true });
	writeFileSync(join(home, ".codex", "auth.json"), "{}");
	writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-6-astra"\n\n[profiles.fast]\nmodel = "gpt-5.6-luna"\n');
	const bin = join(cwd, "bin");
	mkdirSync(bin, { recursive: true });
	for (const vendor of ["claude", "codex"]) writeFileSync(join(bin, vendor), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	const env = { HOME: home, XDG_CONFIG_HOME: join(cwd, "xdg"), PATH: bin };
	writeConfig(cwd, {
		backends: { opencode: { type: "external_harness" } },
		models: { quick: { backend: "opencode", model: "default" } },
	});
	const config = loadConfig(cwd, {}, env);
	const sessionDir = join(cwd, "sessions");
	const host = createSessionHost({ cwd, manager: SessionManager.create(cwd, sessionDir), sessionDir });
	const registry = createCommandRegistry();
	registerCommandSurface(registry, { cwd, config, host, env });
	return {
		cwd,
		env,
		registry,
		dispatch: (line: string, context: Partial<CommandContext> = {}) => registry.dispatch(line, { cwd, ...context }),
	};
}

describe("/model inventory and binding (PRD-030)", () => {
	it("lists every discovered Claude and Codex model, not just the bound role", async () => {
		const models = await fixture().dispatch("/model");

		expect(models.ok).toBe(true);
		// The configured id and the documented aliases: a subscription is more
		// than the one model its settings file happened to save.
		expect(models.text).toContain("claude:opus[1m]");
		expect(models.text).toContain("claude:sonnet");
		// The configured model and a profile override.
		expect(models.text).toContain("codex:gpt-6-astra");
		expect(models.text).toContain("codex:gpt-5.6-luna");
		expect(models.text).toContain("external_harness, ready");
	});

	it("writes the chosen model to the config, with the backend entry it needs", async () => {
		const { cwd, env, dispatch } = fixture();

		const bound = await dispatch("/model use strong codex:gpt-5.6-luna");
		expect(bound.ok).toBe(true);

		// Re-read from disk: the binding has to survive the session that made it.
		const reloaded = loadConfig(cwd, {}, env);
		expect(reloaded.models.strong).toEqual({ backend: "codex", model: "gpt-5.6-luna" });
		expect(reloaded.backends.codex?.type).toBe("external_harness");
		// The role the fixture already had is untouched.
		expect(reloaded.models.quick).toEqual({ backend: "opencode", model: "default" });

		const missing = await dispatch("/model use strong codex:not-a-model");
		expect(missing.ok).toBe(false);
		expect(missing.text).toContain("no discovered model");
	});

	it("pins the role, so the capability index stops re-picking the model the operator just chose", async () => {
		const { cwd, env, dispatch } = fixture();

		expect((await dispatch("/model use strong codex:gpt-5.6-luna")).ok).toBe(true);

		// Without the pin the binding is only one more candidate for the index to
		// weigh, and the operator's choice lasted exactly until the next turn.
		const reloaded = loadConfig(cwd, {}, env);
		expect(reloaded.capability.roles?.strong?.pin).toBe("gpt-5.6-luna");
		expect(resolveRole(reloaded, "strong")).toMatchObject({ backend: "codex", model: "gpt-5.6-luna" });
	});
});

describe("/model through the picker (FR-141)", () => {
	it("binds what the overlay returns, and changes nothing when it is escaped", async () => {
		const { cwd, env, dispatch } = fixture();
		// The overlay stands in for Pi's: it is handed the real factory and answers
		// with a pick, which is all the command sees of it.
		let offered: unknown;
		const custom = (async (factory: unknown) => {
			offered = factory;
			return { role: "review_strong", model: { vendor: "claude", model: "haiku", source: "claude alias", facts: { execution: "external_harness", availability: "ready", evidence: "", coding_score: null, price_blended_per_mtok: null } } } satisfies ModelPick;
		}) as unknown as CommandContext["custom"];

		const bound = await dispatch("/model", { custom });
		expect(bound.ok).toBe(true);
		expect(typeof offered).toBe("function");
		expect(loadConfig(cwd, {}, env).models.review_strong).toEqual({ backend: "claude", model: "haiku" });

		// Escape returns nothing, and nothing is written.
		const escaped = await dispatch("/model", { custom: (async () => undefined) as unknown as CommandContext["custom"] });
		expect(escaped.text).toBe("no change");
		expect(loadConfig(cwd, {}, env).models.review_strong).toEqual({ backend: "claude", model: "haiku" });
	});

	it("falls back to the printed listing when the mode draws no overlays", async () => {
		const listed = await fixture().dispatch("/model");

		expect(listed.text).toContain("discovered on this machine");
		expect(listed.text).toContain("claude:sonnet");
	});
});
