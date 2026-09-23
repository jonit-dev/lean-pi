/**
 * `/model` pins the session's model; `/role` binds a role (PRD-048, moved from
 * PRD-030 root 4's `/model`).
 *
 * The fixture is a home directory with the two vendors' own artifacts and a PATH
 * carrying their commands, so the listing and the write run against the real
 * detection rather than a stub of it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandRegistry, loadConfig, resolveRole } from "../../src/index.js";
import { createSessionHost, registerCommandSurface } from "../../src/commands/index.js";
import { clearRoutePins, routePins } from "../../src/compiler/pins.js";
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
		backends: {
			opencode: { type: "external_harness" },
			local: { type: "native", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", model: "local-model" },
		},
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
		config,
		dispatch: (line: string, context: Partial<CommandContext> = {}) => registry.dispatch(line, { cwd, ...context }),
	};
}

afterEach(() => clearRoutePins());

describe("/role inventory and binding (PRD-030, moved by PRD-048)", () => {
	it("lists every discovered Claude and Codex model, not just the bound role", async () => {
		const models = await fixture().dispatch("/role");

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

		const bound = await dispatch("/role strong codex:gpt-5.6-luna");
		expect(bound.ok).toBe(true);

		// Re-read from disk: the binding has to survive the session that made it.
		const reloaded = loadConfig(cwd, {}, env);
		expect(reloaded.models.strong).toEqual({ backend: "codex", model: "gpt-5.6-luna" });
		expect(reloaded.backends.codex?.type).toBe("external_harness");
		// The role the fixture already had is untouched.
		expect(reloaded.models.quick).toEqual({ backend: "opencode", model: "default" });

		const missing = await dispatch("/role strong codex:not-a-model");
		expect(missing.ok).toBe(false);
		expect(missing.text).toContain("no discovered model");
	});

	it("pins the role, so the capability index stops re-picking the model the operator just chose", async () => {
		const { cwd, env, dispatch } = fixture();

		expect((await dispatch("/role strong codex:gpt-5.6-luna")).ok).toBe(true);

		// Without the pin the binding is only one more candidate for the index to
		// weigh, and the operator's choice lasted exactly until the next turn.
		const reloaded = loadConfig(cwd, {}, env);
		expect(reloaded.capability.roles?.strong?.pin).toBe("gpt-5.6-luna");
		expect(resolveRole(reloaded, "strong")).toMatchObject({ backend: "codex", model: "gpt-5.6-luna" });
	});
});

describe("/model pins the session's model (PRD-048)", () => {
	it("pins a CLI model without writing the config, and returns to Auto with `/model auto`", async () => {
		const { cwd, env, config, dispatch } = fixture();

		const pinned = await dispatch("/model claude:sonnet");
		expect(pinned.ok).toBe(true);
		expect(routePins().model).toEqual({ backend: "claude", model: "sonnet", type: "external_harness" });
		// The pin is session state: nothing lands on disk, and the running config
		// carries the backend entry only so the executor lane can spawn it.
		const reloaded = loadConfig(cwd, {}, env);
		expect(reloaded.models.strong).toBeUndefined();
		expect(reloaded.backends.claude).toBeUndefined();
		expect(config.backends.claude?.type).toBe("external_harness");

		const auto = await dispatch("/model auto");
		expect(auto.ok).toBe(true);
		expect(routePins().model).toBeUndefined();
	});

	it("pins what the picker returns, and changes nothing when it is escaped", async () => {
		const { dispatch } = fixture();
		let offered: unknown;
		const custom = (async (factory: unknown) => {
			offered = factory;
			return { model: { vendor: "claude", backend: "claude", model: "haiku", source: "claude alias", facts: { execution: "external_harness", availability: "ready", evidence: "", coding_score: null, price_blended_per_mtok: null } } } satisfies ModelPick;
		}) as unknown as CommandContext["custom"];

		const pinned = await dispatch("/model", { custom });
		expect(pinned.ok).toBe(true);
		expect(typeof offered).toBe("function");
		expect(routePins().model).toMatchObject({ backend: "claude", model: "haiku" });

		const escaped = await dispatch("/model", { custom: (async () => undefined) as unknown as CommandContext["custom"] });
		expect(escaped.text).toBe("no change");
		expect(routePins().model).toMatchObject({ backend: "claude", model: "haiku" });
	});

	it("lists native backends alongside the CLI models, and removes `/model use`", async () => {
		const { dispatch } = fixture();

		const listed = await dispatch("/model");
		expect(listed.text).toContain("model: Auto");
		expect(listed.text).toContain("discovered on this machine");
		expect(listed.text).toContain("claude:sonnet");
		// The configured native backend's own model is in the inventory too.
		expect(listed.text).toContain("local:local-model");

		const removed = await dispatch("/model use strong codex:gpt-5.6-luna");
		expect(removed.ok).toBe(false);
		expect(removed.text).toContain("removed");
		expect(removed.text).toContain("/role");
	});
});
