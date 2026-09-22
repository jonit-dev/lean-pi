/**
 * D3: the harness timeout must reap the vendor CLI's descendants, not just the
 * direct child. A real generated CLI starts exactly one child and waits; the
 * worker is driven through `runWorkerTurn`'s supported timeout path, and both
 * owned PIDs are asserted gone before any fallback cleanup runs.
 *
 * The fixture owns every PID it starts and cleans up in `finally`, so a broken
 * regression fails deterministically at the bounded wait instead of stalling
 * the test runner and leaving background sleeps behind.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackendRegistry, runWorkerTurn } from "../../src/backends/index.js";
import { loadConfig } from "../../src/index.js";
import { fixtureRepo, gitInit, writeConfig } from "../helpers/fixtures.js";

/** Poll until the PID is gone; a just-killed child can be a zombie for a moment. */
async function expectGone(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`process ${pid} is still alive after the timeout`);
}

describe("D3 — harness timeout reaps descendants", () => {
	it("kills the direct child and its one spawned child through runWorkerTurn", { timeout: 30_000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "leanpi-reap-"));
		const childPidFile = join(dir, "child.pid");
		const grandchildPidFile = join(dir, "grandchild.pid");
		// One direct CLI that starts exactly one child (`sleep` via `exec`, so no
		// shell-and-sleep pair) and waits. Both PIDs are recorded for cleanup.
		const cli = join(dir, "hang-cli.sh");
		writeFileSync(
			cli,
			`#!/bin/sh\necho $$ > ${JSON.stringify(childPidFile)}\nsleep 300 &\necho $! > ${JSON.stringify(grandchildPidFile)}\nwait\n`,
			{ mode: 0o755 },
		);
		chmodSync(cli, 0o755);

		const repo = fixtureRepo();
		const owned = new Set<number>();
		let deadline: ReturnType<typeof setTimeout> | undefined;
		const trackPids = (): void => {
			for (const file of [childPidFile, grandchildPidFile]) {
				try {
					const pid = Number(readFileSync(file, "utf8").trim());
					if (Number.isSafeInteger(pid) && pid > 1) owned.add(pid);
				} catch {
					// Not written yet, or already cleaned up.
				}
			}
		};

		try {
			gitInit(repo.cwd);
			writeConfig(repo.cwd, {
				backends: { claude: { type: "external_harness", command: cli, roles: ["strong"] } },
				models: { strong: { backend: "claude", model: "m" } },
			});
			const registry = new BackendRegistry(loadConfig(repo.cwd));

			const outcome = await Promise.race([
				runWorkerTurn({ objective: "hang", role: "strong" }, { registry, cwd: repo.cwd, timeoutMs: 700 }),
				new Promise<never>((_, reject) => {
					deadline = setTimeout(() => reject(new Error("worker did not settle after its timeout")), 5_000);
				}),
			]);

			expect(outcome.status).toBe("blocked");
			expect(outcome.attempts).toHaveLength(1);
			expect(outcome.attempts[0]!.failure).toBe("timeout");

			const childPid = Number(readFileSync(childPidFile, "utf8").trim());
			const grandchildPid = Number(readFileSync(grandchildPidFile, "utf8").trim());
			expect(childPid).toBeGreaterThan(1);
			expect(grandchildPid).toBeGreaterThan(1);
			// Assert before cleanup: the fallback kill below must not be what makes
			// this test green.
			await expectGone(childPid);
			await expectGone(grandchildPid);
		} finally {
			clearTimeout(deadline);
			trackPids();
			for (const pid of owned) {
				try {
					// The owned PID, never a process group: an unfixed, non-detached
					// child shares this runner's group and `-pid` could signal the suite.
					process.kill(pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
			rmSync(dir, { recursive: true, force: true });
			rmSync(repo.cwd, { recursive: true, force: true });
		}
	});
});
