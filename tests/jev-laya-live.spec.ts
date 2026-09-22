/**
 * PRD-042 Phase 5 — AC-15: the real thing.
 *
 * Every other Laya test drives `--fake` or a stub seam. This one runs Python,
 * torch, the real weights download and the real adapter together, through the
 * production path (`classifyFailure` with the session client), and compares the
 * result with the TypeSafe arm on the same input.
 *
 * Skipped unless `LEANPI_LIVE_LAYAY=1`: the first run installs ~2.5 GB of wheels
 * and ~0.8 GB of weights into the managed home. Set `LEANPI_LIVE_LAYAY_HOME` to
 * reuse an existing runtime instead of provisioning a fresh one.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyFailure,
	clearSites,
	createJevClient,
	defaultLayaDeps,
	ensureLayaRuntime,
	layaHome,
	layaProvider,
	loadConfig,
	readDecisions,
	type FailureCategory,
} from "../src/index.js";
import { PACKAGE_ROOT } from "../src/index.js";
import { tempDir } from "./helpers/fixtures.js";

const live = process.env.LEANPI_LIVE_LAYAY === "1";
const env = process.env as NodeJS.ProcessEnv;
const home = process.env.LEANPI_LIVE_LAYAY_HOME ?? layaHome({}, env);

function loadDotEnv(): void {
	const path = join(PACKAGE_ROOT, ".env");
	if (existsSync(path)) process.loadEnvFile(path);
}
loadDotEnv();

function config(cwd: string, provider: "typesafe" | "laya") {
	return loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { quick: { backend: "local", model: "m" } },
		jev: { mode: "enabled", provider, laya: { home } },
	});
}

describe("PRD-042 AC-15 — the real Laya runtime", () => {
	it.skipIf(!live)(
		"provisions the managed home, answers a real classification, and still reaches TypeSafe under provider: typesafe",
		async () => {
			// 1. Provisioning is real: this is the command `/jev setup-laya` runs.
			const runtime = await ensureLayaRuntime({ home }, defaultLayaDeps());
			expect(existsSync(runtime.python)).toBe(true);

			const cwd = tempDir("leanpi-laya-live-");
			clearSites();
			const deps = defaultLayaDeps();
			const client = createJevClient({ config: config(cwd, "laya"), cwd, provider: layaProvider({ home }, deps) });

			// 2. A real failure, classified through the production path.
			const started = Date.now();
			const result = await classifyFailure({
				client,
				failure: { kind: "typecheck", detail: "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'." },
			});
			const latencyMs = Date.now() - started;

			expect(["syntax", "assertion", "environment", "dependency", "likely_logic_bug"]).toContain(result.value satisfies FailureCategory);
			expect(result.fallbackUsed).toBe(false);
			expect(client.answeredCount()).toBe(1);
			const row = readDecisions(cwd).find((entry) => entry.siteId === "executor.failure_classification");
			expect(row?.fallbackUsed).toBe(false);
			expect(row?.modelVersion).toContain("laya");
			console.log(`laya classified ${result.value} in ${latencyMs}ms (model ${row?.modelVersion})`);
			await client.dispose();

			// 3. The same fixture under the hosted provider still reaches TypeSafe.
			if (typeof env.JEV_API_KEY === "string" && env.JEV_API_KEY.length > 0) {
				clearSites();
				const hostedCwd = tempDir("leanpi-jev-live-");
				const hosted = createJevClient({ config: config(hostedCwd, "typesafe"), cwd: hostedCwd });
				const probe = await hosted.test();
				expect(probe.ok).toBe(true);
				expect(probe.answer?.kind).toBe("Noul");
				const hostedResult = await classifyFailure({
					client: hosted,
					failure: { kind: "typecheck", detail: "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'." },
				});
				expect(hostedResult.fallbackUsed).toBe(false);
				console.log(`jev classified ${hostedResult.value}`);
				await hosted.dispose();
			}
		},
		40 * 60_000,
	);
});
