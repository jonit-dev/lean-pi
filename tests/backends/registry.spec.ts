/**
 * PRD-008 Phase 1 — E1: AC-1 (selection honours `enabled` and priority) and
 * AC-2 (billing classes are derived once and reported separately).
 */
import { describe, expect, it } from "vitest";
import { BackendRegistry, billingOf, billingTotals, runWorkerTurn, type BackendInvocation } from "../../src/backends/index.js";
import { ConfigError, loadConfig } from "../../src/index.js";
import { fixtureRepo, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { installStubCli, setStubScript, s25Backends } from "./helpers.js";

describe("PRD-008 Phase 1 — backend registry and billing", () => {
	it("AC-1: a disabled top-priority backend is never spawned; the next by priority runs", async () => {
		const cli = installStubCli();
		const disabled = fixtureRepo();
		writeConfig(disabled.cwd, {
			backends: s25Backends(cli, { claude: { enabled: false } }),
			models: { strong: { backend: "codex", model: "strong" } },
		});
		const enabled = fixtureRepo();
		writeConfig(enabled.cwd, {
			backends: s25Backends(cli),
			models: { strong: { backend: "codex", model: "strong" } },
		});

		const records: BackendInvocation[] = [];
		const registry = new BackendRegistry(loadConfig(disabled.cwd), { onInvocation: (record) => records.push(record) });
		const restore = setStubScript(cli.recordPath, { files: { "strong.txt": "codex\n" } });
		const outcome = await runWorkerTurn({ objective: "create strong.txt", role: "strong", files: ["strong.txt"] }, { registry, cwd: disabled.cwd });
		restore();

		expect(outcome.status).toBe("completed");
		expect(outcome.backend).toBe("codex");
		// The disabled backend's command was never executed, and the run record
		// names the backend that actually ran.
		expect(cli.records().map((record) => record.vendor)).toEqual(["codex"]);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ backend: "codex", role: "strong", billing: "subscription", quotaClass: "premium" });

		// Negative control: the same pool with the backend enabled spawns it first,
		// which distinguishes "correctly skipped" from "never selectable".
		const enabledRegistry = new BackendRegistry(loadConfig(enabled.cwd));
		expect(enabledRegistry.selectBackend("strong").map((backend) => backend.name)).toEqual([
			"claude",
			"codex",
			"opencode",
			"local",
		]);
		const restoreEnabled = setStubScript(cli.recordPath, { files: { "strong.txt": "claude\n" } });
		const second = await runWorkerTurn(
			{ objective: "create strong.txt", role: "strong", files: ["strong.txt"] },
			{ registry: enabledRegistry, cwd: enabled.cwd },
		);
		restoreEnabled();

		expect(second.status).toBe("completed");
		expect(second.backend).toBe("claude");
		expect(cli.records().map((record) => record.vendor)).toEqual(["codex", "claude"]);
	});

	it("AC-2: a session mixing a subscription and a metered backend reports separate totals", async () => {
		const cli = installStubCli();
		const stub: StubBackend = await startStubBackend([
			{ toolCalls: [{ name: "write", args: { path: "metered.txt", content: "metered\n" } }] },
			{ text: "wrote metered.txt" },
		]);
		const { cwd } = fixtureRepo();
		writeConfig(cwd, {
			backends: {
				...s25Backends(cli, { codex: { roles: ["strong"] } }),
				metered: {
					type: "native",
					baseUrl: stub.baseUrl,
					api: "openai-completions",
					apiKey: "sk-stub",
					priority: 5,
					roles: ["quick"],
					catalog_model_id: "catalog-metered-cheap",
				},
			},
			models: {
				strong: { backend: "codex", model: "strong" },
				quick: { backend: "metered", model: "cheap-fast" },
			},
		});

		const records: BackendInvocation[] = [];
		const registry = new BackendRegistry(loadConfig(cwd), { onInvocation: (record) => records.push(record) });

		const restore = setStubScript(cli.recordPath, { files: { "strong.txt": "codex\n" } });
		const strong = await runWorkerTurn({ objective: "create strong.txt", role: "strong", files: ["strong.txt"] }, { registry, cwd });
		restore();
		const quick = await runWorkerTurn(
			{ objective: "create metered.txt", role: "quick", files: ["metered.txt"], allowedTools: ["write"] },
			{ registry, cwd },
		);
		await stub.close();

		expect(strong.backend).toBe("codex");
		expect(quick.backend).toBe("metered");
		expect(new Set([strong.backend, quick.backend]).size).toBe(2);

		const totals = billingTotals(records);
		expect(totals.subscription).toMatchObject({ invocations: 1 });
		expect(totals.metered).toMatchObject({ invocations: 1 });
		expect(totals.local).toMatchObject({ invocations: 0 });
		expect(records.map((record) => [record.backend, record.billing])).toEqual([
			["codex", "subscription"],
			["metered", "metered"],
		]);
		expect(records[1]!.catalogModelId).toBe("catalog-metered-cheap");
	});

	it("billing is derived in one place from type and marginal_cost", () => {
		expect(billingOf({ type: "external_harness", marginalCost: 0 })).toBe("subscription");
		expect(billingOf({ type: "native", marginalCost: 0 })).toBe("local");
		expect(billingOf({ type: "native", marginalCost: 0.5 })).toBe("metered");
		expect(billingOf({ type: "native", marginalCost: null })).toBe("metered");
	});

	it("rejects a backend that could only fail at spawn time, with its dotted path", () => {
		const { cwd } = fixtureRepo();
		writeConfig(cwd, {
			backends: { mystery: { type: "external_harness" } },
			models: { quick: { backend: "mystery", model: "m" } },
		});
		try {
			new BackendRegistry(loadConfig(cwd));
			expect.unreachable("a harness backend with no vendor must not load");
		} catch (error) {
			expect(error).toBeInstanceOf(ConfigError);
			expect((error as ConfigError).path).toBe("backends.mystery.vendor");
		}

		const nativeDir = fixtureRepo();
		writeConfig(nativeDir.cwd, { backends: { bare: { type: "native" } }, models: { quick: { backend: "bare", model: "m" } } });
		expect(() => new BackendRegistry(loadConfig(nativeDir.cwd))).toThrowError(/backends\.bare\.provider/);

		const unknownDir = fixtureRepo();
		writeConfig(unknownDir.cwd, { backends: { odd: { type: "mystery" } }, models: { quick: { backend: "odd", model: "m" } } });
		expect(() => loadConfig(unknownDir.cwd)).toThrowError(/backends\.odd\.type/);
	});

	it("an entry with an explicit role binding serves only that role", () => {
		const cli = installStubCli();
		const { cwd } = fixtureRepo();
		writeConfig(cwd, {
			backends: s25Backends(cli, { claude: { roles: ["review_strong"] } }),
			models: { quick: { backend: "codex", model: "m" }, review_strong: { backend: "claude", model: "r" } },
		});
		const registry = new BackendRegistry(loadConfig(cwd));
		expect(registry.selectBackend("quick").map((backend) => backend.name)).toEqual(["codex", "opencode", "local"]);
		expect(registry.selectBackend("review_strong").map((backend) => backend.name)).toEqual([
			"claude",
			"codex",
			"opencode",
			"local",
		]);
	});
});
