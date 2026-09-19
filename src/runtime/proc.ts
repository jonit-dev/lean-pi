/**
 * The process boundary the runtime verifiers start programs through (PRD-022
 * Phase 1, ROADMAP §43).
 *
 * One spawn, one process group, one capture. A runtime verifier starts a real
 * program, waits for a declared readiness signal, and then terminates the whole
 * group — a server that spawned its own children must not outlive the verifier
 * that started it. Every path here ends with the child reaped: readiness, an
 * early exit, a timeout, or a spawn failure.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";

/** 1 MiB per stream, mirroring PRD-009's shell verifier: enough to diagnose, bounded. */
const MAX_CAPTURE_CHARS = 1_048_576;

/** How often a declared TCP port is polled while waiting for readiness. */
const PORT_POLL_MS = 50;

const READY_GRACE_MS = 5_000;

export type ReadinessOutcome = "ready" | "exited" | "timeout";

export interface ReadinessSignal {
	/** A pattern the program's stdout/stderr must print before it counts as up. */
	log?: RegExp;
	/** A TCP port that must accept a connection. */
	port?: number;
	timeoutMs: number;
}

export interface ProcessExit {
	code: number | null;
	signal: string | null;
}

export interface StartedProcess {
	pid: number | undefined;
	/** Captured output: both streams interleaved, or one stream by name. */
	capture(stream?: "stdout" | "stderr"): string;
	/** The exit, or `null` while the program is still running. */
	exit(): ProcessExit | null;
	/** `ready` on the first signal that fires, `exited` when the program died first, `timeout` at the deadline. */
	awaitReadiness(signal: ReadinessSignal): Promise<ReadinessOutcome>;
	/** SIGTERM to the group, SIGKILL after `graceMs`; resolves when the child has been reaped. */
	terminate(graceMs?: number): Promise<void>;
}

export interface StartProcessOptions {
	stdin?: string;
	cwd: string;
}

/**
 * Start `command` through the platform shell in its own process group, capturing
 * both streams. The group is what makes teardown reach descendants: the shell is
 * the group leader and `-pid` signals every member.
 */
export function startProcess(command: string, options: StartProcessOptions): StartedProcess {
	const child: ChildProcess = spawn(command, { cwd: options.cwd, shell: true, detached: true, stdio: ["pipe", "pipe", "pipe"] });
	let text = "";
	let out = "";
	let err = "";
	let exit: ProcessExit | null = null;
	let resolveExit: (value: ProcessExit) => void = () => {};
	const exited = new Promise<ProcessExit>((resolve) => {
		resolveExit = resolve;
	});
	const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
		const text8 = chunk.toString("utf8");
		if (text.length < MAX_CAPTURE_CHARS) text += text8;
		if (stream === "stdout") {
			if (out.length < MAX_CAPTURE_CHARS) out += text8;
			return;
		}
		if (err.length < MAX_CAPTURE_CHARS) err += text8;
	};
	child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
	child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
	child.on("error", (error) => {
		append("stderr", Buffer.from(`${error.message}\n`, "utf8"));
		exit = { code: null, signal: null };
		resolveExit(exit);
	});
	child.on("exit", (code, signal) => {
		exit = { code, signal };
		resolveExit(exit);
	});
	if (options.stdin !== undefined) child.stdin?.end(options.stdin);
	else child.stdin?.end();
	child.stdin?.on("error", () => {
		// A program that never reads stdin closes the pipe first; that is not a failure.
	});

	const running = (): boolean => exit === null;

	const reaped = async (graceMs: number): Promise<void> => {
		if (exit !== null) return;
		const killed = new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, graceMs);
			void exited.then(() => {
				clearTimeout(timer);
				resolve();
			});
		});
		if (child.pid !== undefined) {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
		} else {
			child.kill("SIGTERM");
		}
		await killed;
		if (exit !== null) return;
		if (child.pid !== undefined) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		} else {
			child.kill("SIGKILL");
		}
		await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, READY_GRACE_MS))]);
	};

	return {
		pid: child.pid,
		capture: (stream) => (stream === undefined ? text : stream === "stdout" ? out : err),
		exit: () => exit,
		async awaitReadiness(signal: ReadinessSignal): Promise<ReadinessOutcome> {
			// `g`/`y` would make `test` stateful across calls; the pattern is re-created without them.
			const pattern = signal.log === undefined ? undefined : new RegExp(signal.log.source, signal.log.flags.replace(/[gy]/g, ""));
			return new Promise<ReadinessOutcome>((resolve) => {
				let settled = false;
				let poll: NodeJS.Timeout | undefined;
				const finish = (outcome: ReadinessOutcome): void => {
					if (settled) return;
					settled = true;
					clearTimeout(deadline);
					if (poll) clearInterval(poll);
					child.stdout?.off("data", check);
					child.stderr?.off("data", check);
					resolve(outcome);
				};
				const check = (): void => {
					if (pattern !== undefined && running() && pattern.test(text)) finish("ready");
				};
				const deadline = setTimeout(() => finish(running() ? "timeout" : "exited"), Math.max(signal.timeoutMs, 1));
				child.stdout?.on("data", check);
				child.stderr?.on("data", check);
				void exited.then(() => finish("exited"));
				if (signal.port !== undefined) {
					poll = setInterval(() => {
						if (!running()) {
							check();
							return;
						}
						const probe = connect({ port: signal.port!, host: "127.0.0.1" });
						probe.once("connect", () => {
							probe.destroy();
							finish("ready");
						});
						probe.once("error", () => probe.destroy());
					}, PORT_POLL_MS);
				}
				check();
			});
		},
		terminate: (graceMs = 500) => reaped(graceMs),
	};
}
