/**
 * The startup trace: Pi's timing block goes to the trace, not the terminal, and
 * the line is written once the editor's border reached stdout and the session started.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { traceChildStartup } from "../../src/cli/startup-trace.js";
import { tempDir } from "../helpers/fixtures.js";

describe("traceChildStartup", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("captures Pi's timings, passes other stderr through, and writes once the editor painted and the session started", () => {
		vi.stubEnv("LEANPI_T0", String(Date.now()));
		vi.stubEnv("LEANPI_CAPTURE_PI_TIMING", "1");
		const path = join(tempDir(), "startup.jsonl");
		const passed: string[] = [];
		const error = console.error;
		const write = process.stdout.write;
		console.error = (...args: unknown[]) => void passed.push(args.join(" "));
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			let sessionStart = () => {};
			traceChildStartup({ on: ((_event: string, handler: () => void) => void (sessionStart = handler)) as never }, path);
			console.error("\n--- Startup Timings: main ---");
			console.error("  createAgentSessionRuntime: 776ms");
			console.error("-----------------------------\n");
			console.error("a real warning");
			process.stdout.write("plain header");
			process.stdout.write("──────── editor");
			// Pi 1.x paints the editor first; the line waits for `session_start`.
			expect(existsSync(path)).toBe(false);
			sessionStart();
			const line = JSON.parse(readFileSync(path, "utf8"));
			expect(line.proc).toBe("pi");
			expect(line.pi_timing).toEqual(["--- Startup Timings: main ---", "createAgentSessionRuntime: 776ms", "-----------------------------"]);
			expect(line.marks["editor-painted"]).toBeGreaterThanOrEqual(line.marks["leanpi-extension"]);
			expect(line.marks.session_start).toBeGreaterThanOrEqual(line.marks["editor-painted"]);
			expect(passed).toEqual(["a real warning"]);
		} finally {
			console.error = error;
			process.stdout.write = write;
		}
	});
});
