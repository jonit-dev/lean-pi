/**
 * PRD-001 Phase 2 — AC-3, AC-4, AC-9: config validation and the role ladder.
 */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, resolveRole, type ModelRole } from "../src/index.js";
import { bootSession, fixtureRepo, nativeBackend, writeConfig } from "./helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "./helpers/stub-backend.js";

describe("PRD-001 Phase 2 — config and role resolution", () => {
	let stubA: StubBackend;
	let stubB: StubBackend;

	beforeEach(async () => {
		stubA = await startStubBackend([{ text: "a" }]);
		stubB = await startStubBackend([{ text: "b" }]);
	});

	afterEach(async () => {
		await stubA.close();
		await stubB.close();
	});

	it("AC-3: one session dispatches to a local and a metered backend without reconfiguration", async () => {
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: {
				local: nativeBackend(stubA.baseUrl),
				metered: nativeBackend(stubB.baseUrl),
			},
			models: {
				quick: { backend: "local", model: "cheap-fast" },
				strong: { backend: "metered", model: "metered-strong" },
			},
		});

		const session = await bootSession({ cwd, agentDir });
		await session.runTurn({ text: "quick task", role: "quick" });
		await session.runTurn({ text: "strong task", role: "strong" });

		expect(stubA.requests).toHaveLength(1);
		expect(stubA.requests[0]!.model).toBe("cheap-fast");
		expect(stubB.requests).toHaveLength(1);
		expect(stubB.requests[0]!.model).toBe("metered-strong");
		expect(session.modelFor("quick")).toEqual({ provider: "local", model: "cheap-fast" });
		expect(session.modelFor("strong")).toEqual({ provider: "metered", model: "metered-strong" });

		session.session.dispose();
	});

	it("AC-4: invalid configs abort session start with the offending config path and no backend request", async () => {
		const cases: Array<{ name: string; config: Record<string, unknown>; expected: string }> = [
			{
				name: "unknown role key",
				config: {
					backends: { local: nativeBackend(stubA.baseUrl) },
					models: { quik: { backend: "local", model: "cheap-fast" } },
				},
				expected: "models.quik",
			},
			{
				name: "undefined backend",
				config: {
					backends: { local: nativeBackend(stubA.baseUrl) },
					models: { quick: { backend: "nowhere", model: "cheap-fast" } },
				},
				expected: "models.quick.backend",
			},
			{
				name: "pre-§25 kind key",
				config: {
					backends: { local: { kind: "native", baseUrl: stubA.baseUrl } },
					models: { quick: { backend: "local", model: "cheap-fast" } },
				},
				expected: "backends.local.type",
			},
			{
				name: "type outside the discriminant",
				config: {
					backends: { local: { type: "native-model", baseUrl: stubA.baseUrl } },
					models: { quick: { backend: "local", model: "cheap-fast" } },
				},
				expected: "backends.local.type",
			},
			{
				name: "no roles at all",
				config: { backends: { local: nativeBackend(stubA.baseUrl) }, models: {} },
				expected: "models",
			},
		];

		for (const testCase of cases) {
			const { cwd, agentDir } = fixtureRepo();
			writeConfig(cwd, testCase.config);
			await expect(bootSession({ cwd, agentDir }), testCase.name).rejects.toThrow(testCase.expected);
		}
		expect(stubA.requests).toHaveLength(0);
		expect(stubB.requests).toHaveLength(0);
	});
});

describe("PRD-001 AC-9 — the role ladder", () => {
	const twoRoleConfig = () =>
		loadConfig(
			join(import.meta.dirname, "__no_config_here__"),
			{
				configPath: null,
				backends: {
					local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" },
				},
				models: {
					quick: { backend: "local", model: "cheap-fast" },
					balanced: { backend: "local", model: "balanced-model" },
				},
			},
		);

	it("resolves every role to its documented ladder target", () => {
		const config = twoRoleConfig();
		const ladder: Array<[ModelRole, string]> = [
			["quick", "cheap-fast"],
			["balanced", "balanced-model"],
			["strong", "balanced-model"],
			["specialist", "balanced-model"],
			["review_quick", "cheap-fast"],
			["review_strong", "cheap-fast"],
		];
		for (const [role, model] of ladder) {
			expect(resolveRole(config, role).model, role).toBe(model);
			if (role.startsWith("review_")) {
				expect(["balanced-model", "strong"], role).not.toBe(resolveRole(config, role).model);
			}
		}
	});

	it("resolves each role to its own entry when all six are configured", () => {
		const config = loadConfig(join(import.meta.dirname, "__no_config_here__"), {
			configPath: null,
			backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
			models: {
				quick: { backend: "local", model: "m-quick" },
				balanced: { backend: "local", model: "m-balanced" },
				strong: { backend: "local", model: "m-strong" },
				specialist: { backend: "local", model: "m-specialist" },
				review_quick: { backend: "local", model: "m-review-quick" },
				review_strong: { backend: "local", model: "m-review-strong" },
			},
		});
		const expected: Record<ModelRole, string> = {
			quick: "m-quick",
			balanced: "m-balanced",
			strong: "m-strong",
			specialist: "m-specialist",
			review_quick: "m-review-quick",
			review_strong: "m-review-strong",
		};
		for (const [role, model] of Object.entries(expected) as Array<[ModelRole, string]>) {
			expect(resolveRole(config, role).model, role).toBe(model);
		}
	});
});

describe("FR-047 / PRD-009 — `models.specialists` and `verify:` are read from the config file", () => {
	const backends = { local: nativeBackend("http://127.0.0.1:1/v1") };

	/** A config file on disk, loaded the way an operator reaches it: no overrides. */
	function fromFile(config: Record<string, unknown>) {
		const { cwd } = fixtureRepo();
		writeConfig(cwd, config);
		return () => loadConfig(cwd);
	}

	it("loads `models.specialists` as its own map without disturbing the role bindings", () => {
		const config = fromFile({
			backends,
			models: {
				balanced: { backend: "local", model: "balanced-model" },
				strong: { backend: "local", model: "strong-model" },
				specialists: { rust: "strong", refactor: "balanced" },
			},
		})();
		expect(config.models.specialists).toEqual({ rust: "strong", refactor: "balanced" });
		expect(config.models.strong).toEqual({ backend: "local", model: "strong-model" });
		expect(config.models.balanced).toEqual({ backend: "local", model: "balanced-model" });
	});

	it("rejects a specialist bound to something that is not a model role, naming the entry", () => {
		expect(fromFile({ backends, models: { quick: { backend: "local", model: "m" }, specialists: { rust: "nonsense" } } })).toThrow(ConfigError);
		expect(fromFile({ backends, models: { quick: { backend: "local", model: "m" }, specialists: { rust: "nonsense" } } })).toThrow("models.specialists.rust");
		expect(fromFile({ backends, models: { quick: { backend: "local", model: "m" }, specialists: "strong" } })).toThrow("models.specialists");
	});

	it("does not count a specialists map as a configured role", () => {
		expect(fromFile({ backends, models: { specialists: { rust: "strong" } } })).toThrow("no model roles configured");
	});

	it("carries the `verify:` block, and an empty one when the file declares none", () => {
		const declared = fromFile({
			backends,
			models: { quick: { backend: "local", model: "m" } },
			verify: { commands: { targeted_test: "npx vitest run tests/" }, timeoutMs: 1000 },
		})();
		expect(declared.verify).toEqual({ commands: { targeted_test: "npx vitest run tests/" }, timeoutMs: 1000 });

		const silent = fromFile({ backends, models: { quick: { backend: "local", model: "m" } } })();
		expect(silent.verify).toEqual({ commands: {} });
	});

	it("rejects a verifier command that is not a command, and a timeout that cannot elapse", () => {
		const models = { quick: { backend: "local", model: "m" } };
		expect(fromFile({ backends, models, verify: { commands: { targeted_test: 7 } } })).toThrow("verify.commands.targeted_test");
		expect(fromFile({ backends, models, verify: { commands: { targeted_test: "" } } })).toThrow("verify.commands.targeted_test");
		expect(fromFile({ backends, models, verify: { commands: { targeted_test: "npx vitest" }, timeoutMs: 0 } })).toThrow("verify.timeoutMs");
		expect(fromFile({ backends, models, verify: { commands: [] } })).toThrow("verify.commands");
	});
});
