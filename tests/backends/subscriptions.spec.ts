/**
 * Subscription detection (PRD-008 §25) feeding §14's `subscription_availability`.
 *
 * The plan a subscription backend spends is the *user's*: LeanPi spawns a vendor
 * CLI it never authenticates, so "is this route usable" is a question about the
 * machine, not about the config. These specs drive the real detector against a
 * fake HOME and PATH, and then the real compiler, so a route that cannot run is
 * moved before an attempt is spent on it.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSubscriptions, subscriptionDeviations } from "../../src/backends/index.js";
import { applyDeviations, loadConfig, matrixDefault } from "../../src/index.js";
import { tempDir } from "../helpers/fixtures.js";

/** A machine: a PATH with the named CLIs on it, and a HOME with the named logins. */
function machine(options: { onPath?: string[]; loggedIn?: ("claude" | "codex" | "opencode")[] } = {}) {
	const root = tempDir("leanpi-machine-");
	const bin = join(root, "bin");
	const home = join(root, "home");
	mkdirSync(bin, { recursive: true });
	mkdirSync(home, { recursive: true });
	for (const command of options.onPath ?? []) {
		const path = join(bin, command);
		writeFileSync(path, "#!/bin/sh\nexit 0\n");
		chmodSync(path, 0o755);
	}
	const credentials: Record<string, string[]> = {
		claude: [".claude", ".credentials.json"],
		codex: [".codex", "auth.json"],
		opencode: [".local/share/opencode", "auth.json"],
	};
	for (const vendor of options.loggedIn ?? []) {
		const [dir, file] = credentials[vendor] as [string, string];
		mkdirSync(join(home, dir), { recursive: true });
		writeFileSync(join(home, dir, file), "{}\n");
	}
	return { home, env: { PATH: bin, HOME: home } as NodeJS.ProcessEnv };
}

function configWith(overrides: Record<string, unknown> = {}) {
	const cwd = tempDir("leanpi-subs-");
	return loadConfig(cwd, {
		configPath: null,
		backends: {
			claude: { type: "external_harness", vendor: "claude" },
			local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" },
		},
		models: {
			quick: { backend: "local", model: "cheap" },
			balanced: { backend: "local", model: "cheap" },
			strong: { backend: "claude", model: "claude-sonnet-4-5" },
		},
		...overrides,
	});
}

afterEach(() => undefined);

describe("subscription detection", () => {
	it("reports a vendor CLI that is installed and logged in as usable", () => {
		const { env, home } = machine({ onPath: ["claude"], loggedIn: ["claude"] });
		const [state] = detectSubscriptions(configWith(), { env, home });

		expect(state).toMatchObject({ backend: "claude", vendor: "claude", onPath: true, signedIn: true });
		expect(state!.evidence).toContain(".credentials.json");
		// Nothing to route around: the plan is there.
		expect(subscriptionDeviations(configWith(), [state!])).toEqual([]);
	});

	it("separates 'not installed' from 'installed but signed out', and says which", () => {
		const absent = machine({ loggedIn: ["claude"] });
		const [missingCli] = detectSubscriptions(configWith(), absent);
		expect(missingCli).toMatchObject({ onPath: false, signedIn: true });
		expect(missingCli!.evidence).toContain("not on PATH");

		const signedOut = machine({ onPath: ["claude"] });
		const [noLogin] = detectSubscriptions(configWith(), signedOut);
		expect(noLogin).toMatchObject({ onPath: true, signedIn: false });
		expect(noLogin!.evidence).toContain("no credential for claude");
	});

	it("accepts the vendor's environment credential in place of its login file", () => {
		const { env, home } = machine({ onPath: ["claude"] });
		const [state] = detectSubscriptions(configWith(), { env: { ...env, ANTHROPIC_API_KEY: "sk-test" }, home });
		expect(state).toMatchObject({ onPath: true, signedIn: true });
		expect(state!.evidence).toBe("$ANTHROPIC_API_KEY");
	});

	it("routes a class away from a subscription this machine cannot use", () => {
		const config = configWith();
		const states = detectSubscriptions(config, machine({ loggedIn: ["claude"] }));
		const deviations = subscriptionDeviations(config, states);

		// `strong` is the only class bound to the vendor, so it is the only one moved.
		expect(deviations).toHaveLength(1);
		expect(deviations[0]).toMatchObject({ kind: "subscription_availability", executor_class: "strong", available: false });
		expect(deviations[0]!.reason).toContain("not on PATH");

		// And §14 applies it: a HIGH task compiles to a class that can actually run.
		const applied = applyDeviations(matrixDefault(false, "HIGH", "R0"), deviations);
		expect(applied.routing.executor_class).not.toBe("strong");
		expect(applied.deviation).toMatchObject({ from: "strong" });
		expect(applied.deviation!.reason).toContain("claude");
	});

	it("says nothing about native backends, which carry no plan", () => {
		const nativeOnly = loadConfig(tempDir("leanpi-subs-native-"), {
			configPath: null,
			backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
			models: { balanced: { backend: "local", model: "cheap" } },
		});
		expect(detectSubscriptions(nativeOnly, machine())).toEqual([]);
		expect(subscriptionDeviations(nativeOnly, [])).toEqual([]);
	});
});
