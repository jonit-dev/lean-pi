/**
 * Child-process execution for command-shaped verifiers (PRD-009 Phase 2).
 *
 * One spawn helper: a timeout, a captured exit code, and process-group teardown
 * so a `vitest` or `tsc` that spawns its own children is not left behind. A
 * command that cannot start at all is reported as a failure to launch, never a
 * thrown turn.
 *
 * The child inherits the full environment on purpose: a verifier runs a trusted,
 * operator-configured command that may need a toolchain or registry credential
 * from it. This is not the guarded `execute` tool's allowlisted environment
 * (PRD-017); only that path filters.
 */
import { spawn } from "node:child_process";

/** 1 MiB per stream: enough to diagnose, bounded so a runaway command cannot exhaust memory. */
const MAX_CAPTURE_CHARS = 1_048_576;

export interface ShellRunResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	/** Set when the process could not be launched (missing shell, spawn failure). */
	spawnError: string | null;
}

export type ShellExec = (command: string, cwd: string, timeoutMs: number) => Promise<ShellRunResult>;

/** Runs `command` through the platform shell in `cwd`; kills the process group on timeout. */
export const execShell: ShellExec = (command, cwd, timeoutMs) =>
	new Promise<ShellRunResult>((resolve) => {
		const child = spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let spawnError: string | null = null;
		let settled = false;

		const finish = (exitCode: number | null): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({ exitCode, stdout, stderr, timedOut, spawnError });
		};
		const terminate = (): void => {
			const pid = child.pid;
			// `kill(-1)` is a broadcast to every signalable process the user owns, not
			// an ordinary group, so only an owned PID > 1 may be signalled: an explicit
			// reserved/invalid PID must reach neither `process.kill` nor `child.kill`.
			if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return;
			try {
				// The child is its own group leader, so this reaches its descendants too.
				process.kill(-pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					terminate();
					finish(null);
				}, timeoutMs)
			: undefined;

		child.stdout?.on("data", (chunk: Buffer) => {
			if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			spawnError = error.message;
			finish(null);
		});
		child.on("close", (code) => finish(code));
	});
