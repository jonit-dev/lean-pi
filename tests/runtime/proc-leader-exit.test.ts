/**
 * PRD-040 B — the owned process group outlives its leader (ROADMAP §43).
 *
 * A command can exit after spawning a descendant that inherits its stdio pipes;
 * awaiting `close` then hangs forever, and the old `reaped()` returned early once
 * the leader was gone, so the descendant was never killed. These are real
 * processes: one Node child that ignores SIGTERM and holds an interval. It writes
 * its own PID and a ready marker before the leader exits, so a failing branch can
 * still read the PID and clean it up. A second boundary case has the child spawn
 * a *detached* grandchild: the group signal cannot reach it, it holds the
 * inherited pipes, and the bounded drain must report `timeout` so the CLI
 * verifier records an error rather than certifying partial output as a pass.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerRuntimeVerifiers } from "../../src/runtime/index.js";
import { startProcess } from "../../src/runtime/proc.js";
import { verifyTask } from "../../src/verify/index.js";

registerRuntimeVerifiers();

/** A Node child that ignores TERM, holds an interval, and signals its PID then readiness. */
const CHILD_SCRIPT = `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
writeFileSync("child.pid", String(process.pid));
writeFileSync("child.ready", "1");
setInterval(() => {}, 1000);
`;

/** A child that detaches a grandchild holding inherited stdio, then holds its own interval. */
const DETACH_SCRIPT = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
const g = spawn(process.execPath, ["grandchild.mjs"], { detached: true, stdio: "inherit" });
writeFileSync("child.pid", String(g.pid));
writeFileSync("child.ready", "1");
setInterval(() => {}, 1000);
`;

const GRANDCHILD_SCRIPT = `process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`;

/** The leader waits for the child's ready marker, then exits 0 with the child still in its group. */
function leaderCommand(script: string): string {
	return `node ${script} & while [ ! -f child.ready ]; do :; done; exit 0`;
}

function scratchDir(script: string, grandchild?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "leanpi-proc-leader-"));
	writeFileSync(join(dir, "child.mjs"), script);
	if (grandchild !== undefined) writeFileSync(join(dir, "grandchild.mjs"), grandchild);
	return dir;
}

function readPid(file: string): number | undefined {
	try {
		const value = Number(readFileSync(file, "utf8").trim());
		return Number.isSafeInteger(value) && value > 1 ? value : undefined;
	} catch {
		return undefined;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !isAlive(pid);
}

function forceKill(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already reaped by the group signal.
	}
}

/** A CLI-invocation contract whose program is the leader-exit command. */
function cliContract(command: string): never {
	return {
		task: { acceptance_criteria: [{ id: "AC-1", text: "cli" }] },
		verification: { required: ["cli_invocation"], runtime: { cli: { command, expect: { exitCode: 0 } } } },
		limits: { semantic_review_rounds: 0 },
	} as never;
}

describe("PRD-040 B — terminate reaches a descendant that outlived the leader", () => {
	it("kills the owned descendant and drains within the bound", async () => {
		const dir = scratchDir(CHILD_SCRIPT);
		const owned = startProcess(leaderCommand("child.mjs"), { cwd: dir });
		let childPid: number | undefined;
		try {
			expect(await owned.awaitReadiness({ timeoutMs: 5_000 })).toBe("exited");
			childPid = readPid(join(dir, "child.pid"));
			expect(childPid).toBeGreaterThan(1);
			expect(isAlive(childPid!)).toBe(true);

			await owned.terminate(200);
			// Death is asserted before the bounded drain's fallback could resolve, so
			// a version that skipped SIGKILL (and merely timed out the drain) fails.
			expect(await waitForDeath(childPid!, 5_000)).toBe(true);
			// The owned group released the pipes: the capture drained.
			expect(await owned.closed(2_000)).toBe("drained");
		} finally {
			childPid = childPid ?? readPid(join(dir, "child.pid"));
			forceKill(childPid);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("cli_invocation returns instead of hanging on a leader-exit command", async () => {
		const dir = scratchDir(CHILD_SCRIPT);
		let childPid: number | undefined;
		let timer: NodeJS.Timeout | undefined;
		try {
			const result = await Promise.race([
				verifyTask(cliContract(leaderCommand("child.mjs")), dir, {}),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("cli verifier hung on an inherited stdio pipe")), 8_000);
				}),
			]);
			const record = result.records.find((entry) => entry.kind === "cli_invocation");
			expect(record?.status).toBe("pass");
			childPid = readPid(join(dir, "child.pid"));
			expect(await waitForDeath(childPid!, 5_000)).toBe(true);
		} finally {
			if (timer) clearTimeout(timer);
			childPid = childPid ?? readPid(join(dir, "child.pid"));
			forceKill(childPid);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records an error, not a pass, when a detached descendant holds the inherited pipes", async () => {
		const dir = scratchDir(DETACH_SCRIPT, GRANDCHILD_SCRIPT);
		let childPid: number | undefined;
		let timer: NodeJS.Timeout | undefined;
		try {
			const result = await Promise.race([
				verifyTask(cliContract(leaderCommand("child.mjs")), dir, {}),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error("cli verifier hung on a detached descendant's inherited pipe")), 12_000);
				}),
			]);
			const record = result.records.find((entry) => entry.kind === "cli_invocation");
			// The owned group was killed, but the detached grandchild kept the pipe
			// open: the capture is partial, so the verifier reports an error.
			expect(record?.status).toBe("error");
		} finally {
			if (timer) clearTimeout(timer);
			childPid = readPid(join(dir, "child.pid"));
			forceKill(childPid);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
