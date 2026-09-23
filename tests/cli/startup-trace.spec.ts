/**
 * The startup trace: Pi's timing block goes to the trace, not the terminal, and
 * the line is written when the editor's border first reaches stdout.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { traceChildStartup } from "../../src/cli/startup-trace.js";
import { tempDir } from "../helpers/fixtures.js";

describe("traceChildStartup", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("captures Pi's timings, passes other stderr through, and writes on the editor's first paint", () => {
		vi.stubEnv("LEANPI_T0", String(Date.now()));
		vi.stubEnv("LEANPI_CAPTURE_PI_TIMING", "1");
		const path = join(tempDir(), "startup.jsonl");
		const passed: string[] = [];
		const error = console.error;
		const write = process.stdout.write;
		console.error = (...args: unknown[]) => void passed.push(args.join(" "));
		process.stdout.write = (() => true) as typeof process.stdout.write;
		try {
			traceChildStartup({ on: () => {} }, path);
			console.error("\n--- Startup Timings: main ---");
			console.error("  createAgentSessionRuntime: 776ms");
			console.error("-----------------------------\n");
			console.error("a real warning");
			process.stdout.write("plain header");
			process.stdout.write("──────── editor");
			const line = JSON.parse(readFileSync(path, "utf8"));
			expect(line.proc).toBe("pi");
			expect(line.pi_timing).toEqual(["--- Startup Timings: main ---", "createAgentSessionRuntime: 776ms", "-----------------------------"]);
			expect(line.marks["editor-painted"]).toBeGreaterThanOrEqual(line.marks["leanpi-extension"]);
			expect(passed).toEqual(["a real warning"]);
		} finally {
			console.error = error;
			process.stdout.write = write;
		}
	});
});
