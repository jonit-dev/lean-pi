import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM maintainer script, no declaration file
import { computeReport, percentile, renderHtml, sessionTurns, startupLaunches } from "../scripts/ux-kpi.mjs";

const now = Date.parse("2026-10-20T00:00:00Z");
const at = (daysAgo: number, ms = 0) => new Date(now - daysAgo * 86_400_000 + ms).toISOString();
const user = (t: string) => ({ type: "message", timestamp: t, message: { role: "user" } });
const assistant = (t: string, stopReason: string) => ({ type: "message", timestamp: t, message: { role: "assistant", stopReason } });

describe("ux-kpi", () => {
	it("takes the nearest-rank percentile", () => {
		expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
		expect(percentile([], 50)).toBeUndefined();
	});

	it("splits a launch into phases, keeps import times, and drops bench launches", () => {
		const pi = (t0: string, painted: number) => ({
			t0,
			proc: "pi",
			marks: { "node-start": 1000, "leanpi-extension": 2500, session_start: 4000, "editor-painted": painted },
			pi_timing: ["/x/node_modules/.pnpm/a@1/node_modules/pi-subagents/index.js module import: 795ms", "TOTAL: 9ms"],
		});
		const rows = [pi(at(1), 4500), { t0: at(1), proc: "launcher", marks: {} }, pi(at(2), 9000), { t0: at(3), proc: "pi", marks: {} }];
		const launches = startupLaunches(rows, new Set([at(2)]));
		expect(launches).toHaveLength(1);
		expect(launches[0].phases).toEqual({ launcher: 1000, "pi boot": 1500, "extensions + runtime": 1500, paint: 500 });
		expect(launches[0].cwd).toBe("");
		expect(launches[0].imports).toEqual([{ name: "pi-subagents/index.js", ms: 795 }]);
	});

	it("ends each turn on its last assistant stopReason and times the first reply", () => {
		const turns = sessionTurns([
			user(at(1)),
			assistant(at(1, 3000), "toolUse"),
			{ type: "message", timestamp: at(1, 3100), message: { role: "toolResult" } },
			assistant(at(1, 8000), "error"),
			user(at(1, 60_000)),
			assistant(at(1, 61_000), "aborted"),
			user(at(1, 120_000)),
		]);
		expect(turns.map((t: { firstReplyMs?: number; end?: string }) => [t.firstReplyMs, t.end])).toEqual([
			[3000, "error"],
			[1000, "aborted"],
			[undefined, undefined],
		]);
	});

	it("rates the aborted-operation error as an abort and other errors as errors", () => {
		const failure = (ms: number, stopReason: string, errorMessage: string) => ({
			type: "message",
			timestamp: at(1, ms),
			message: { role: "assistant", stopReason, errorMessage },
		});
		const turns = sessionTurns([
			user(at(1)),
			failure(1000, "error", "This operation was aborted"),
			user(at(1, 60_000)),
			failure(61_000, "error", "429 GoUsageLimitError"),
			user(at(1, 120_000)),
			failure(121_000, "error", "503 server_error"),
		]);
		const report = computeReport({ launches: [], turns, crashTimes: [], now, days: 7 });
		const kpi = (id: string) => report.kpis.find((k: { id: string }) => k.id === id);
		expect(kpi("abort_rate")!.value).toBeCloseTo(100 / 3);
		expect(kpi("error_rate")!.value).toBeCloseTo(200 / 3);
	});

	it("rates answered turns only, compares windows, and renders", () => {
		const turns = [
			...sessionTurns([user(at(1)), assistant(at(1, 2000), "stop"), user(at(1, 9000)), assistant(at(1, 13_000), "error")]),
			...sessionTurns([user(at(10)), assistant(at(10, 1000), "stop")]),
		];
		const report = computeReport({ launches: [], turns, crashTimes: [now - 3_600_000], now, days: 7 });
		const kpi = (id: string) => report.kpis.find((k: { id: string }) => k.id === id);
		expect(kpi("error_rate")).toMatchObject({ value: 50, prev: 0, pass: false });
		expect(kpi("first_reply_p50").value).toBe(2000);
		expect(kpi("crashes")).toMatchObject({ value: 1, pass: false });
		expect(kpi("ready_p50")).toMatchObject({ value: undefined, pass: undefined });
		expect(kpi("error_rate").series).toHaveLength(30);
		const html = renderHtml(report, [{ sha: "abc", note: "</script>" }]);
		expect(html).not.toContain("/*DATA*/null");
		expect(html).toContain('"sha":"abc"');
		expect(html).not.toContain('"note":"</script>"');
	});
});
