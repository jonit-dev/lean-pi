/**
 * A rate-limited `opencode run` never exits: it retries the provider's 429 in
 * silence, so a Manual turn on an OpenCode model sat on "Thinking…" until Esc.
 * Its own log line names the failure, and that ends the run as a limit.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackendRegistry, runWorkerTurn } from "../../src/backends/index.js";
import { loadConfig } from "../../src/index.js";
import { fixtureRepo, gitInit, writeConfig } from "../helpers/fixtures.js";

// Verbatim shape of `opencode run --print-logs` against a 429 (opencode 1.x).
const RETRY_LOG =
	'timestamp=2026-09-25T22:06:41.787Z level=ERROR run=a692bec4 message="stream error" providerID=opencode-go modelID=deepseek-v4.1-flash session.id=ses_x small=false agent=build mode=primary error.error="AI_APICallError: Too Many Requests"';

describe("OpenCode harness — a provider 429 ends the turn instead of hanging it", () => {
	it("fails the run as a limit as soon as opencode logs the rate-limited stream error", { timeout: 30_000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "leanpi-oc-stall-"));
		const cli = join(dir, "opencode");
		// Logs the error, then keeps "retrying" far past the test's deadline.
		writeFileSync(cli, `#!/bin/sh\necho ${JSON.stringify(RETRY_LOG).replace(/\$/g, "\\$")} >&2\nexec sleep 60\n`, { mode: 0o755 });
		const repo = fixtureRepo();
		try {
			gitInit(repo.cwd);
			writeConfig(repo.cwd, {
				backends: { opencode: { type: "external_harness", command: cli, roles: ["balanced"] } },
				models: { balanced: { backend: "opencode", model: "opencode-go/deepseek-v4.1-flash" } },
			});
			const registry = new BackendRegistry(loadConfig(repo.cwd));
			const started = Date.now();
			const outcome = await runWorkerTurn({ objective: "hi", role: "balanced" }, { registry, cwd: repo.cwd, timeoutMs: 20_000 });

			expect(Date.now() - started).toBeLessThan(5_000);
			expect(outcome.status).not.toBe("completed");
			expect(outcome.attempts[0]).toMatchObject({ failure: "limit" });
			expect(outcome.attempts[0]!.reason).toMatch(/too many requests/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(repo.cwd, { recursive: true, force: true });
		}
	});
});
