/**
 * PRD-021 — the lane entry the npm script drives.
 *
 * `bench/cli.ts` is what `npm run bench -- <args>` executes. Importing it must
 * not start a run, and the commands the acceptance criteria name (`--list`,
 * `--report jev|rtk`) must work through it, because that is the invocation the
 * PRD's verification lines specify.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../../src/index.js";
import { leanPiSessionFactory, runArgv } from "../../src/bench/lane.js";
import { leanPiSessionFactory as shimFactory, runArgv as shimArgv } from "../../bench/cli.js";
import { capturingIo } from "./helpers.js";

describe("PRD-021 lane entry", () => {
	it("imports without starting a run and wires the package entry's session factory", () => {
		expect(typeof leanPiSessionFactory).toBe("function");
		expect(typeof runArgv).toBe("function");
		// The PRD names `bench/cli.ts`; that path is the same lane entry.
		expect(shimFactory).toBe(leanPiSessionFactory);
		expect(shimArgv).toBe(runArgv);
	});

	it("prints the suite inventory through `bench --list`", async () => {
		const io = capturingIo();
		const exit = await runArgv(["--list"], { cwd: PACKAGE_ROOT, io });
		expect(exit).toBe(0);
		expect(io.text).toContain("suite: ");
		expect(io.text).toContain("§55 coverage");
	});

	it("prints the §56 and §57 reports through the same entry point", async () => {
		const jev = capturingIo();
		expect(await runArgv(["--report", "jev", "--from", join(PACKAGE_ROOT, "bench", "fixtures", "telemetry", "jev")], { cwd: PACKAGE_ROOT, io: jev })).toBe(0);
		expect(jev.text).toContain("| complexity over-routing | 0.2500 (2/8) |");

		const rtk = capturingIo();
		expect(await runArgv(["--report", "rtk", "--from", join(PACKAGE_ROOT, "bench", "fixtures", "telemetry", "rtk")], { cwd: PACKAGE_ROOT, io: rtk })).toBe(0);
		expect(rtk.text).toContain("verdict: **promote**");
	});

	it("exits 2 with usage when a flag is unknown", async () => {
		const io = capturingIo();
		const exit = await runArgv(["--nope"], { cwd: PACKAGE_ROOT, io });
		expect(exit).toBe(2);
		expect(io.errors).toContain("usage: bench");
	});
});
