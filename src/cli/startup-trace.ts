/**
 * Where a launch's first seconds go: the gap between the logo and the editor.
 *
 * Every process in one launch — the shell launcher, `bin/leanpi.js`, and Pi's
 * child — stamps marks against one origin, `LEANPI_T0` (epoch ms), so their
 * numbers read on one clock. Each appends one JSON line to
 * `~/.leanpi/startup.jsonl`; the child's line also carries Pi's own
 * `PI_TIMING` breakdown, captured here instead of printed above the editor.
 * Nothing reads the file back: it exists for whoever is debugging a slow start.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const t0 = Number(process.env.LEANPI_T0) || Math.round(performance.timeOrigin);
const marks: Record<string, number> = { "node-start": Math.round(performance.timeOrigin - t0) };

/** Milliseconds since the launch began, under `label`. */
export function mark(label: string): void {
	marks[label] = Date.now() - t0;
}

/** What the child needs to stamp on the same clock, and to hand Pi's timings to the trace. */
export function startupTraceEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	// An operator who set `PI_TIMING` wants it printed; only the launcher's own is captured.
	return { LEANPI_T0: String(t0), ...(env.PI_TIMING === undefined ? { PI_TIMING: "1", LEANPI_CAPTURE_PI_TIMING: "1" } : {}) };
}

// ponytail: append-only, ~1KB per launch; rotate if the file ever matters.
export function writeStartupTrace(proc: string, extra: Record<string, unknown> = {}, path: string = join(homedir(), ".leanpi", "startup.jsonl")): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ t0: new Date(t0).toISOString(), proc, marks, ...extra })}\n`);
	} catch {
		// A trace must never break a launch.
	}
}

/**
 * The child's half: marks the extension load and `session_start`, captures
 * Pi's timing block, and writes the line when the editor's border first
 * reaches stdout — the moment the operator can start typing.
 */
export function traceChildStartup(pi: Pick<ExtensionAPI, "on">, path?: string): void {
	if (process.env.LEANPI_T0 === undefined) return; // not launched by `leanpi`
	mark("leanpi-extension");
	pi.on("session_start", () => mark("session_start"));
	const piTiming: string[] = [];
	const error = console.error;
	if (process.env.LEANPI_CAPTURE_PI_TIMING === "1") {
		let inBlock = false;
		console.error = (...args: unknown[]) => {
			const line = args.map(String).join(" ").trim();
			if (line.startsWith("--- Startup Timings")) inBlock = true;
			if (!inBlock) return error(...args);
			piTiming.push(line);
			if (/^-+$/.test(line)) inBlock = false;
		};
	}
	const write = process.stdout.write;
	process.stdout.write = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
		if (String(chunk).includes("─")) {
			process.stdout.write = write;
			console.error = error;
			mark("editor-painted");
			writeStartupTrace("pi", { pi_timing: piTiming, cwd: process.cwd(), term: process.env.TERM_PROGRAM ?? process.env.TERM }, path);
		}
		return (write as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
	} as typeof process.stdout.write;
}
