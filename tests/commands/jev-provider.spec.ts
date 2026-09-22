/**
 * PRD-042 Phase 4 — AC-8, AC-10, AC-11, AC-12, AC-13, AC-14: the toggle.
 *
 * The switch is exercised through the real command registry and the real client,
 * not by calling a handler function: `/jev provider laya` has to move the
 * session, and the only way to show that is to read the client afterwards.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSites,
	createCommandRegistry,
	createJevClient,
	layaProvider,
	layaStatus,
	loadConfig,
	registerJevCommands,
	typesafeProvider,
	type CommandRegistry,
	type JevClient,
	type JevProvider,
} from "../../src/index.js";
import { jevWarning, requireJev, startupBanner } from "../../src/cli/bootstrap.js";
import { launchEnv, parseLeanPiFlags } from "../../src/cli/launch.js";
import { registerHelpCommand, renderHelp } from "../../src/commands/help.js";
import { writeUserProvider } from "../../src/core/config-write.js";
import { fakeRuntime, stubDeps } from "../helpers/laya.js";

function hasPython3(): boolean {
	try {
		execFileSync("python3", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const PYTHON3 = hasPython3();

describe("PRD-042 Phase 4 — provider toggle", () => {
	let cwd: string;
	let home: string;
	let configHome: string;
	const disposers: Array<() => Promise<void>> = [];

	beforeEach(() => {
		clearSites();
		cwd = mkdtempSync(join(tmpdir(), "leanpi-toggle-"));
		home = mkdtempSync(join(tmpdir(), "leanpi-laya-home-"));
		configHome = mkdtempSync(join(tmpdir(), "leanpi-config-home-"));
	});

	afterEach(async () => {
		clearSites();
		for (const dispose of disposers.splice(0)) await dispose();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		rmSync(configHome, { recursive: true, force: true });
	});

	function configFor(provider?: JevProvider) {
		return loadConfig(cwd, {
			configPath: null,
			backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
			models: { quick: { backend: "local", model: "m" } },
			jev: { mode: "enabled", ...(provider === undefined ? {} : { provider }) },
		});
	}

	function buildClient(providerName: JevProvider, deps = fakeRuntime().deps): JevClient {
		const client = createJevClient({
			config: configFor(providerName),
			cwd,
			provider: providerName === "laya" ? layaProvider({ home, autoSetup: false }, deps) : undefined,
		});
		disposers.push(() => client.dispose());
		return client;
	}

	function registerWithProvider(client: JevClient, deps = fakeRuntime().deps): CommandRegistry {
		const registry = createCommandRegistry();
		registerJevCommands(registry, {
			client,
			env: { XDG_CONFIG_HOME: configHome, HOME: configHome },
			provider: {
				current: () => (client.providerName() === "laya" ? "laya" : "typesafe"),
				async swap(name) {
					await client.dispose();
					client.setProvider(
						name === "laya"
							? layaProvider({ home, autoSetup: false }, deps)
							: typesafeProvider({ endpoint: "http://127.0.0.1:1/v1/systemone", model: "jev-latest", credential: () => ({ key: "k", source: "env" }) }),
					);
				},
				status: () => layaStatus({ home, autoSetup: false }, deps),
				setup: async () => ({ home, python: join(home, "venv", "bin", "python"), installed: true }),
			},
		});
		return registry;
	}

	it("AC-10: --laya / --jev are parsed, carried to the child, and reflected in the banner", () => {
		const laya = parseLeanPiFlags(["--laya"]);
		expect(laya.provider).toBe("laya");
		expect(launchEnv(laya, false).LEANPI_LAYAY_PROVIDER).toBe("laya");

		const typesafe = parseLeanPiFlags(["--laya", "--jev"]);
		expect(typesafe.provider).toBe("typesafe"); // last one wins
		expect(launchEnv(typesafe, false).LEANPI_LAYAY_PROVIDER).toBe("typesafe");
		expect(launchEnv(parseLeanPiFlags([]), false).LEANPI_LAYAY_PROVIDER).toBeUndefined();

		// The flag overrides the config key; `--no-jev` overrides both.
		const forced = requireJev({ cwd, env: { LEANPI_LAYAY_PROVIDER: "laya" } as NodeJS.ProcessEnv, home });
		expect(forced.provider).toBe("laya");
		expect(forced.source).toBe("laya (local)");
		const optedOut = requireJev({ cwd, env: { LEANPI_LAYAY_PROVIDER: "laya", LEANPI_NO_JEV: "1" } as NodeJS.ProcessEnv, home, allowMissing: true });
		expect(optedOut.source).toBe("not configured (--no-jev)");
		// A deliberate opt-out gets no warning about the provider it did not pick.
		expect(jevWarning(optedOut.source)).toBeNull();

		const banner = startupBanner(configFor("laya"), forced, undefined, { cwd, home });
		expect(banner).toContain("laya, local");
		// Control: without the flag the banner cannot contain it, so the assertion
		// is not passing on a constant. `cwd`/`home` are passed so the path in the
		// banner cannot contain the word either.
		const typesafeBanner = startupBanner(configFor("typesafe"), requireJev({ cwd, env: {} as NodeJS.ProcessEnv, home }), undefined, { cwd, home });
		expect(typesafeBanner).not.toContain("laya");
	});

	it("AC-11: /jev provider reports, switches the live session both ways, and rejects an unknown name", async () => {
		const client = buildClient("typesafe");
		const registry = registerWithProvider(client);

		const reported = await registry.dispatch("/jev provider", { cwd });
		expect(reported.ok).toBe(true);
		expect(reported.text).toContain("provider: typesafe");
		expect(reported.text).toContain("typesafe | laya");

		const switched = await registry.dispatch("/jev provider laya", { cwd });
		expect(switched.ok).toBe(true);
		expect(client.providerName()).toBe("laya");
		expect(client.credentialSource()).toBe("laya");

		const status = await registry.dispatch("/jev", { cwd });
		expect(status.text).toContain("provider: laya");
		expect(status.text).toContain("laya runtime:");

		const back = await registry.dispatch("/jev provider typesafe", { cwd });
		expect(back.ok).toBe(true);
		expect(client.providerName()).toBe("typesafe");

		const bad = await registry.dispatch("/jev provider gemini", { cwd });
		expect(bad.ok).toBe(false);
		expect(bad.text).toContain("typesafe | laya");
		expect(client.providerName()).toBe("typesafe"); // unchanged
	});

	it("AC-12: --save writes one leaf and leaves the rest of the user config alone", async () => {
		const path = join(configHome, "leanpi", "leanpi.config.yaml");
		mkdirSync(join(configHome, "leanpi"), { recursive: true });
		const original = [
			"# my leanpi config",
			"backends:",
			"  local:",
			"    type: native",
			"    baseUrl: http://127.0.0.1:1/v1",
			"models:",
			"  quick:",
			"    backend: local",
			"    model: m",
			"jev:",
			"  mode: enabled",
			"  model: jev-latest",
			"thresholds:",
			"  complexity: 0.5",
			"",
		].join("\n");
		writeFileSync(path, original);

		const client = buildClient("typesafe");
		const registry = registerWithProvider(client);

		// Without --save the file is untouched.
		await registry.dispatch("/jev provider laya", { cwd });
		expect(readFileSync(path, "utf8")).toBe(original);

		const saved = await registry.dispatch("/jev provider laya --save", { cwd });
		expect(saved.ok).toBe(true);
		const written = readFileSync(path, "utf8");
		expect(written).not.toBe(original);
		// Only the one leaf moved: the comment and every unrelated value survive.
		expect(written).toContain("# my leanpi config");
		expect(written).toContain("mode: enabled");
		expect(written).toContain("model: jev-latest");
		expect(written).toContain("complexity: 0.5");
		// And the file now resolves to Laya without a flag: it is a real project
		// config for the loader's purposes (the file the loader would read).
		const reloaded = loadConfig(join(configHome, "leanpi"));
		expect(reloaded.jev.provider).toBe("laya");
		expect(reloaded.jev.mode).toBe("enabled");
		expect(reloaded.jev.model).toBe("jev-latest");
		expect(reloaded.thresholds.complexity).toBe(0.5);
	});

	it("AC-12: writeUserProvider creates the file when none exists", () => {
		const path = writeUserProvider("laya", { XDG_CONFIG_HOME: configHome, HOME: configHome });
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf8")).toContain("provider: laya");
	});

	it("AC-12: refuses malformed user YAML without rewriting it", () => {
		const path = join(configHome, "leanpi", "leanpi.config.yaml");
		mkdirSync(join(configHome, "leanpi"), { recursive: true });
		const malformed = "jev:\n  mode: enabled\nother: [not closed\n";
		writeFileSync(path, malformed);
		expect(() => writeUserProvider("laya", { XDG_CONFIG_HOME: configHome, HOME: configHome })).toThrow(/invalid.*yaml/i);
		expect(readFileSync(path, "utf8")).toBe(malformed);
	});

	it("AC-13: /jev setup-laya reports the runtime, and /help lists the new commands", async () => {
		const client = buildClient("typesafe");
		const registry = registerWithProvider(client);

		const setup = await registry.dispatch("/jev setup-laya", { cwd });
		expect(setup.ok).toBe(true);
		expect(setup.text).toContain(join(home, "venv", "bin", "python"));

		registerHelpCommand(registry);
		const listed = await registry.dispatch("/help", { cwd });
		expect(listed.text).toContain("/jev");
		expect(listed.text).toContain("provider");
		const usage = await registry.dispatch("/help jev", { cwd });
		expect(usage.text).toContain("setup-laya");
		expect(usage.text).toContain("provider");
	});

	it("AC-8: autoSetup false names the missing runtime and the install command, and downloads nothing", async () => {
		// A runtime probe that fails is the whole point: there is no Laya here.
		const runs: Array<{ command: string; args: string[] }> = [];
		const deps = stubDeps({}, runs);
		const client = createJevClient({ config: configFor("laya"), cwd, provider: layaProvider({ home, autoSetup: false }, deps) });
		disposers.push(() => client.dispose());
		const registry = registerWithProvider(client, deps);

		const status = await registry.dispatch("/jev", { cwd });
		expect(status.ok).toBe(true);
		expect(status.text).toContain("laya runtime: missing");
		expect(status.text).toContain("/jev setup-laya");
		// The probe is the only exec: nothing was created and nothing downloaded.
		expect(runs.every((entry) => entry.args[0] === "-c")).toBe(true);
	});

	it.skipIf(!PYTHON3)("AC-14: /jev test under provider: laya returns a typed Noul, the server's model and zero cost", async () => {
		const client = buildClient("laya");
		const registry = registerWithProvider(client);

		const result = await registry.dispatch("/jev test", { cwd });

		expect(result.ok).toBe(true);
		expect(result.text).toContain("JEV test ok");
		expect(result.text).toContain("laya-fake");
		expect(result.text).toContain("$0.000000");
	});
});
