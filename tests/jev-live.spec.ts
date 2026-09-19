/**
 * PRD-002 AC-13 — the owner-gated live round trip.
 *
 * The stub suites assert LeanPi's behaviour; only this spec exercises the real
 * wire contract (endpoint path, auth header, request envelope) against
 * TypeSafe's service. It is skipped unless `LEANPI_LIVE_JEV=1` is set and a key
 * is resolved, so a normal run never depends on the network or on a credential.
 *
 * Run: `pnpm vitest run tests/jev-live.spec.ts` with `LEANPI_LIVE_JEV=1` and
 * `JEV_API_KEY` in the environment (or the repo's gitignored `.env`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT, createCommandRegistry, createJevClient, loadConfig, registerJevCommands } from "../src/index.js";
import { tempDir } from "./helpers/fixtures.js";

function loadDotEnv(): void {
	const path = join(PACKAGE_ROOT, ".env");
	if (!existsSync(path)) return;
	process.loadEnvFile(path);
}

const live = process.env.LEANPI_LIVE_JEV === "1";
loadDotEnv();
const hasKey = typeof process.env.JEV_API_KEY === "string" && process.env.JEV_API_KEY.length > 0;

describe("PRD-002 AC-13 — live JEV round trip (owner gate)", () => {
	it.skipIf(!live || !hasKey)("answers one typed question against the real service and records cost", async () => {
		const cwd = tempDir("leanpi-live-");
		const config = loadConfig(cwd, {
			configPath: null,
			backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
			models: { quick: { backend: "local", model: "m" } },
		});
		const client = createJevClient({ config, cwd });
		const result = await client.test();

		expect(result.error ?? "").toBe("");
		expect(result.ok).toBe(true);
		expect(result.answer?.kind).toBe("Noul");
		expect(result.modelVersion.length).toBeGreaterThan(0);
		expect(result.costUsd).toBeGreaterThan(0);

		// `/jev test` is reachable through the command registry, not by calling the client.
		const registry = createCommandRegistry();
		registerJevCommands(registry, { client });
		const dispatched = await registry.dispatch("/jev test", { cwd });
		expect(dispatched.ok).toBe(true);
		expect(dispatched.text).toContain("JEV test ok");

		const status = await registry.dispatch("/jev", { cwd });
		expect(status.text).toContain("configured (source: env)");
		expect(status.text).toContain(result.modelVersion);
	}, 60_000);
});
