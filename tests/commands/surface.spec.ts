/**
 * E1 (PRD-016 Phase 1): `/help`, `/status` and `/config` answer.
 *
 * Covers AC-1 (registration and dispatch reachability), AC-2 (composition
 * without divergence from `/cost`) and AC-3 (config provenance). The foreign
 * command registered below proves the listing is registry-driven rather than a
 * hardcoded list.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileTask, createArtifactStore, createCommandRegistry, setCompilerContext } from "../../src/index.js";
import { createSessionHost, registerCommandSurface } from "../../src/commands/index.js";
import { registerGoalCommands } from "../../src/goal/index.js";
import { registerPrdCommandsLazily } from "../../src/prd/dispatch.js";
import { registerReviewCommand } from "../../src/review/commands.js";
import { emitRunTelemetry, createRunCollector, registerCostCommand, resolveCostConfig } from "../../src/telemetry/index.js";
import { bootSession, nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { packet, unavailableClient } from "../compiler/helpers.js";
import { moneyOf, surfaceFixture } from "./helpers.js";

const CONFIG = {
	backends: { local: nativeBackend("http://127.0.0.1:1/v1", { cost: { input: 3, output: 15 } }) },
	models: { quick: { backend: "local", model: "stub-model" }, balanced: { backend: "local", model: "stub-model" } },
};

describe("/help, /status and /config (PRD-016 Phase 1)", () => {
	afterEach(() => setCompilerContext(undefined));

	it("lists every registered command, including a foreign PRD's, and suggests the nearest name (AC-1)", async () => {
		const fixture = surfaceFixture({ config: CONFIG, name: "alpha" });
		fixture.registry.register({
			name: "goal",
			summary: "show the active goal (PRD-013)",
			usage: "/goal",
			run: () => ({ ok: true, text: "goal" }),
		});

		const help = await fixture.dispatch("/help");
		expect(help.ok).toBe(true);
		for (const name of ["help", "status", "model", "models", "route", "context", "compact", "tree", "config", "doctor", "new", "resume"]) {
			expect(help.text).toContain(`/${name}`);
		}
		// A command this PRD does not own, registered by another PRD's module.
		expect(help.text).toContain("/goal");
		expect(help.text).toContain("show the active goal (PRD-013)");

		const miss = await fixture.dispatch("/halp");
		expect(miss.ok).toBe(false);
		expect(miss.text).toContain("unknown command `/halp`");
		expect(miss.text).toContain("did you mean `/help`?");

		const detailed = await fixture.dispatch("/help route");
		expect(detailed.text).toContain("usage: /route");

		const unknownHelp = await fixture.dispatch("/help nope");
		expect(unknownHelp.ok).toBe(false);
		expect(unknownHelp.text).toContain("did you mean");
	});

	it("lists the commands other PRDs registered through the same registry, in a booted session (AC-1)", async () => {
		const localStub = await startStubBackend();
		try {
			const cwd = tempDir("leanpi-boot-");
			writeConfig(cwd, {
				backends: { local: nativeBackend(localStub.baseUrl) },
				models: { quick: { backend: "local", model: "stub-model" }, balanced: { backend: "local", model: "stub-model" } },
			});
			const session = await bootSession({ cwd, commands: createCommandRegistry() });
			try {
				// The twelve this PRD owns, registered through its single registration point.
				registerCommandSurface(session.commands, {
					cwd,
					config: session.activation.config,
					host: createSessionHost({ cwd, manager: session.session.sessionManager }),
					jev: session.jev,
				});
				// The remaining shared-surface commands, registered by their owning PRDs.
				registerGoalCommands(session.commands, { cwd, config: session.activation.config });
				registerReviewCommand(session.commands, { cwd, config: session.activation.config });
				registerPrdCommandsLazily(session.commands, {
					cwd,
					config: session.activation.config,
					artifactStore: createArtifactStore({ sessionDir: join(cwd, "artifacts") }),
				});

				const help = await session.commands.dispatch("/help", { cwd });
				expect(help.ok).toBe(true);
				for (const name of ["help", "status", "model", "models", "route", "context", "compact", "tree", "config", "doctor", "new", "resume"]) {
					expect(help.text).toContain(`/${name}`);
				}
				// The commands other PRDs registered into the same map, with their own summaries.
				for (const name of ["goal", "review", "prd", "skills", "mcp", "permissions", "jev", "cost"]) {
					expect(help.text).toContain(`/${name}`);
				}
				expect(help.text).toContain("(PRD-015)");

				const status = await session.commands.dispatch("/status", { cwd });
				expect(status.ok).toBe(true);
				expect(status.text).toContain(`id ${session.session.sessionId}`);
			} finally {
				session.session.dispose();
			}
		} finally {
			await localStub.close();
		}
	});

	it("reports the session, its bindings, backend counts and the same session cost as /cost (AC-2)", async () => {
		let stub: StubBackend | undefined;
		try {
			stub = await startStubBackend();
			const fixture = surfaceFixture({
				config: {
					backends: { local: nativeBackend(stub.baseUrl, { cost: { input: 3, output: 15 } }) },
					models: { quick: { backend: "local", model: "stub-model" }, strong: { backend: "local", model: "stub-model" } },
				},
				name: "alpha",
			});
			fixture.append("user", "make the cache warm across turns");

			// One fixture run recorded against this session id, through PRD-015's own emitter.
			const sessionId = fixture.manager.getSessionId();
			setCompilerContext({ client: unavailableClient(), config: fixture.config, cwd: fixture.cwd });
			const contract = await compileTask("fix the cache key", packet());
			const collector = createRunCollector({ taskId: "surface-1", sessionId });
			collector.add({ backend: "local", type: "native", model: "stub-model", role: "balanced", usage: { inputTokens: 1_000_000, outputTokens: 0 } });
			emitRunTelemetry(
				collector,
				contract,
				{ verification: "pass", proof_gate: "pass", reviewer: "PASS", success: true },
				{ cwd: fixture.cwd, cost: resolveCostConfig(fixture.config) },
			);

			const status = await fixture.dispatch("/status");
			expect(status.ok).toBe(true);
			expect(status.text).toContain("session: alpha");
			expect(status.text).toContain(`id ${sessionId}`);
			expect(status.text).toMatch(/roles: quick=local\/stub-model/);
			expect(status.text).toMatch(/reasoning: (low|medium|high|unknown)/);
			expect(status.text).toMatch(/backends: 1 ok · 0 degraded · 0 unavailable/);
			expect(status.text).toContain("prd: none");

			// `/cost`, registered by PRD-015 through this same registry, totals the same rows.
			registerCostCommand(fixture.registry, { cwd: fixture.cwd, sessionId, cost: resolveCostConfig(fixture.config) });
			const cost = await fixture.dispatch("/cost");
			expect(cost.ok).toBe(true);
			const statusTotal = moneyOf(status.text, "session cost");
			const costTotal = moneyOf(cost.text, "session total");
			expect(statusTotal).toBe(3);
			expect(statusTotal).toBe(costTotal);
		} finally {
			await stub?.close();
		}
	});

	it("shows which file won each key, the losing default and the new value after an edit (AC-3)", async () => {
		const fixture = surfaceFixture({
			config: { ...CONFIG, models: { quick: { backend: "local", model: "qwen3-coder" }, strong: { backend: "local", model: "stub-model" } }, skills: { maxLoaded: 5 } },
		});

		const rendered = await fixture.dispatch("/config");
		expect(rendered.ok).toBe(true);
		expect(rendered.text).toContain(`project config: ${fixture.configPath}`);
		expect(rendered.text).toMatch(/models\.quick\.model\s+qwen3-coder\s+project \S+leanpi\.config\.yaml\s+<unset>/);
		// The built-in default that lost, rendered beside the value that won.
		expect(rendered.text).toMatch(/skills\.maxLoaded\s+5\s+project \S+leanpi\.config\.yaml\s+3/);
		// A key nobody overrides reports the default as its source.
		expect(rendered.text).toMatch(/thresholds\.gate_prd_required\s+0\.5\s+built-in default/);

		// A new session reading the edited file sees the new value.
		writeFileSync(
			fixture.configPath,
			[
				"backends:",
				"  local:",
				"    type: native",
				"    baseUrl: http://127.0.0.1:1/v1",
				"models:",
				"  quick:",
				"    backend: local",
				"    model: qwen3-next",
				"  strong:",
				"    backend: local",
				"    model: stub-model",
				"skills:",
				"  maxLoaded: 5",
				"",
			].join("\n"),
		);
		const second = surfaceFixture({ config: CONFIG, cwd: fixture.cwd, writeConfigFile: false });
		const reRendered = await second.dispatch("/config");
		expect(reRendered.text).toMatch(/models\.quick\.model\s+qwen3-next\s+project \S+leanpi\.config\.yaml/);
		expect(second.config.models.quick?.model).toBe("qwen3-next");
	});
});
