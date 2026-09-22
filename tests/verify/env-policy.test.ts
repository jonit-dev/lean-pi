/**
 * S2: the verifier child inherits the parent environment on purpose. A verifier
 * runs a trusted, operator-configured command (`tsc`, `vitest`, a configured
 * script) that may need a toolchain or registry credential from it; only the
 * guarded `execute` tool filters to an allowlist (PRD-017). The sentinel is
 * harmless and pins the deliberate passthrough.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execShell } from "../../src/verify/run.js";

const SENTINEL = "LEANPI_VERIFIER_ENV_SENTINEL";

describe("S2 — the verifier child inherits the environment", () => {
	afterEach(() => {
		delete process.env[SENTINEL];
	});

	it("passes an environment variable through to the verifier command", async () => {
		process.env[SENTINEL] = "verifier-sees-me";
		const dir = mkdtempSync(join(tmpdir(), "leanpi-verifier-env-"));
		const out = join(dir, "out.txt");
		const script = join(dir, "env-probe.sh");
		writeFileSync(script, `#!/bin/sh\nprintf '%s' "$${SENTINEL}" > ${JSON.stringify(out)}\n`, { mode: 0o755 });
		chmodSync(script, 0o755);

		const run = await execShell(script, dir, 5_000);

		expect(run.exitCode).toBe(0);
		expect(readFileSync(out, "utf8")).toBe("verifier-sees-me");
	});
});
