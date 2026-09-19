/**
 * Process-safety regression — the two shared spawn helpers must never signal a
 * reserved or invalid child PID. A negative PID addresses a process group, but
 * `kill(-1)` is a broadcast to every signalable process the user owns, so a fake
 * `pid: 1` previously reached `process.kill(-1)`. `spawn` is replaced with an in-memory
 * fake and `process.kill` is mocked before either public path runs, so no
 * assertion here can emit a real OS signal to a fake PID.
 *
 * Existing `tests/runtime` and `tests/verify` suites cover the real owned-child
 * teardown; this file only pins the reserved/invalid boundary and the untouched
 * group/fallback branches.
 */
import { EventEmitter } from "node:events";
import type * as ChildProcessModule from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startProcess } from "../src/runtime/proc.js";
import { execShell } from "../src/verify/run.js";

/** A spawned child stand-in: streams plus a recording `kill`, never a real process. */
class FakeChild extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly killCalls: Array<NodeJS.Signals | number | undefined> = [];
	kill = (signal?: NodeJS.Signals | number): boolean => {
		this.killCalls.push(signal);
		return true;
	};
	constructor(readonly pid: number | undefined) {
		super();
	}
}

let nextChild: FakeChild | undefined;

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcessModule>();
	return {
		...actual,
		spawn: () => nextChild as unknown as ReturnType<typeof actual.spawn>,
	};
});

/** Includes every explicitly reserved or invalid form: reserved, sign, finite, integer and safe bounds. */
const RESERVED_OR_INVALID = [-1, 0, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];

afterEach(() => {
	vi.restoreAllMocks();
	nextChild = undefined;
});

describe("execShell timeout teardown", () => {
	it("signals neither the OS nor the child for a reserved or invalid PID", async () => {
		for (const pid of RESERVED_OR_INVALID) {
			const child = new FakeChild(pid);
			nextChild = child;
			const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

			const result = await execShell("noop", process.cwd(), 5);

			expect(result.timedOut, `pid ${pid} timed out`).toBe(true);
			expect(killSpy.mock.calls, `pid ${pid} process.kill`).toEqual([]);
			expect(child.killCalls, `pid ${pid} child.kill`).toEqual([]);
			vi.restoreAllMocks();
		}
	});

	it("group-kills an owned PID > 1 and falls back to child.kill only when the group signal throws", async () => {
		const owned = new FakeChild(4242);
		nextChild = owned;
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
		await execShell("noop", process.cwd(), 5);
		expect(killSpy.mock.calls.map(([target, signal]) => [target, signal])).toEqual([[-4242, "SIGKILL"]]);
		expect(owned.killCalls).toEqual([]);
		vi.restoreAllMocks();

		const throwing = new FakeChild(4242);
		nextChild = throwing;
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("ESRCH");
		});
		await execShell("noop", process.cwd(), 5);
		expect(throwing.killCalls).toEqual(["SIGKILL"]);
	});
});

describe("startProcess terminate", () => {
	it("signals neither the OS nor the child for a reserved or invalid PID", async () => {
		for (const pid of RESERVED_OR_INVALID) {
			const child = new FakeChild(pid);
			nextChild = child;
			const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

			const proc = startProcess("noop", { cwd: process.cwd() });
			await proc.terminate(5);

			expect(killSpy.mock.calls, `pid ${pid} process.kill`).toEqual([]);
			expect(child.killCalls, `pid ${pid} child.kill`).toEqual([]);
			vi.restoreAllMocks();
		}
	});

	it("group-terminates, then group-kills, an owned PID > 1 with no child fallback", async () => {
		const child = new FakeChild(4242);
		nextChild = child;
		const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
			if (signal === "SIGKILL") child.emit("exit", null, "SIGKILL");
			return true;
		});

		await startProcess("noop", { cwd: process.cwd() }).terminate(5);

		expect(killSpy.mock.calls.map(([target, signal]) => [target, signal])).toEqual([[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
		expect(child.killCalls).toEqual([]);
	});

	it("falls back to child.kill for an undefined PID", async () => {
		const child = new FakeChild(undefined);
		child.kill = (signal?: NodeJS.Signals | number): boolean => {
			child.killCalls.push(signal);
			if (signal === "SIGKILL") child.emit("exit", null, "SIGKILL");
			return true;
		};
		nextChild = child;
		const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

		await startProcess("noop", { cwd: process.cwd() }).terminate(5);

		expect(killSpy.mock.calls).toEqual([]);
		expect(child.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
	});
});
