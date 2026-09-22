/**
 * The LeanPi update notice (PRD-043).
 *
 * The notice is only ever the cache an earlier launch wrote, so these tests
 * touch no network and no real home directory: `cachePath` and `fetch` are
 * injected, and a stub `fetch` proves whether a request was made at all.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCachePath, refreshLatest, updateNotice } from "../../src/cli/update-check.js";
import { tempDir } from "../helpers/fixtures.js";

function cacheWith(contents: string): string {
	const path = join(tempDir("leanpi-update-"), "update-check.json");
	writeFileSync(path, contents);
	return path;
}

/** A `fetch` that answers once with `body`, recording the calls and the abort signals it saw. */
function stubFetch(body: unknown, init: { status?: number } = {}): { calls: string[]; signals: (AbortSignal | undefined)[]; fetch: typeof globalThis.fetch } {
	const calls: string[] = [];
	const signals: (AbortSignal | undefined)[] = [];
	const fetch = (async (url: string, request?: RequestInit) => {
		calls.push(String(url));
		signals.push(request?.signal ?? undefined);
		return new Response(JSON.stringify(body), { status: init.status ?? 200 });
	}) as unknown as typeof globalThis.fetch;
	return { calls, signals, fetch };
}

describe("the LeanPi update notice", () => {
	it("names the newer version and the command that installs it", () => {
		const cachePath = cacheWith(JSON.stringify({ checkedAt: 0, latest: "0.2.0" }));
		expect(updateNotice({ current: "0.1.3", cachePath })).toBe("leanpi v0.2.0 is available (you have v0.1.3) — npm i -g leanpi@latest");
	});

	it("compares major.minor.patch numerically, not as strings", () => {
		const at = (latest: string) => updateNotice({ current: "0.1.3", cachePath: cacheWith(JSON.stringify({ checkedAt: 0, latest })) });
		// "0.1.10" sorts *below* "0.1.3" as a string and above it as three numbers,
		// which is the whole reason the compare is numeric.
		expect(at("0.1.10")).toBe("leanpi v0.1.10 is available (you have v0.1.3) — npm i -g leanpi@latest");
		expect(at("1.0.0")).toContain("v1.0.0");
	});

	it("stays quiet for an equal, older, prerelease or unparseable version", () => {
		for (const latest of ["0.1.3", "0.1.2", "0.1.4-beta.1", "v0.1.4", "latest", ""]) {
			expect(updateNotice({ current: "0.1.3", cachePath: cacheWith(JSON.stringify({ checkedAt: 0, latest })) }), latest).toBeUndefined();
		}
	});

	it("stays quiet when the cache is missing, empty or malformed", () => {
		expect(updateNotice({ current: "0.1.3", cachePath: join(tempDir("leanpi-update-"), "absent.json") })).toBeUndefined();
		for (const contents of ["", "not json", "null", "{}", '{"checkedAt":"yesterday","latest":"9.9.9"}']) {
			expect(updateNotice({ current: "0.1.3", cachePath: cacheWith(contents) }), contents).toBeUndefined();
		}
	});

	it("defaults the cache to the user-scope `.leanpi` directory", () => {
		expect(defaultCachePath("/home/someone")).toBe("/home/someone/.leanpi/update-check.json");
	});
});

describe("refreshing the cached latest version", () => {
	it("writes checkedAt and latest from the registry response", async () => {
		const cachePath = join(tempDir("leanpi-update-"), "nested", "update-check.json");
		const { calls, signals, fetch } = stubFetch({ version: "0.2.0" });
		await refreshLatest({ cachePath, now: 1_700_000_000_000, fetch });
		expect(calls).toEqual(["https://registry.npmjs.org/leanpi/latest"]);
		// The request carries a deadline, so a hanging registry cannot hold the
		// parent process open after the Pi child exits.
		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({ checkedAt: 1_700_000_000_000, latest: "0.2.0" });
	});

	it("skips the request while the cache is less than a day old", async () => {
		const cachePath = cacheWith(JSON.stringify({ checkedAt: 1_000, latest: "0.2.0" }));
		const { calls, fetch } = stubFetch({ version: "0.3.0" });
		await refreshLatest({ cachePath, now: 1_000 + 23 * 60 * 60 * 1000, fetch });
		expect(calls).toEqual([]);
		expect(JSON.parse(readFileSync(cachePath, "utf8")).latest).toBe("0.2.0");
	});

	it("refreshes once the cache is a day old", async () => {
		const cachePath = cacheWith(JSON.stringify({ checkedAt: 1_000, latest: "0.2.0" }));
		const { calls, fetch } = stubFetch({ version: "0.3.0" });
		await refreshLatest({ cachePath, now: 1_000 + 25 * 60 * 60 * 1000, fetch });
		expect(calls).toHaveLength(1);
		expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({ checkedAt: 1_000 + 25 * 60 * 60 * 1000, latest: "0.3.0" });
	});

	it("leaves the cache untouched and does not throw when the request fails", async () => {
		const cachePath = cacheWith(JSON.stringify({ checkedAt: 0, latest: "0.2.0" }));
		const failing = (async () => {
			throw new Error("offline");
		}) as unknown as typeof globalThis.fetch;
		await expect(refreshLatest({ cachePath, now: Date.now(), fetch: failing })).resolves.toBeUndefined();
		expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({ checkedAt: 0, latest: "0.2.0" });
	});

	it("swallows a non-200, a body without a version, and an unwritable cache", async () => {
		const cachePath = join(tempDir("leanpi-update-"), "update-check.json");
		await expect(refreshLatest({ cachePath, now: 1, fetch: stubFetch({ version: "9.9.9" }, { status: 500 }).fetch })).resolves.toBeUndefined();
		await expect(refreshLatest({ cachePath, now: 1, fetch: stubFetch({}).fetch })).resolves.toBeUndefined();
		expect(existsSync(cachePath)).toBe(false);
		// A directory where the file belongs: `writeFileSync` throws EISDIR.
		await expect(refreshLatest({ cachePath: tempDir("leanpi-update-"), now: 1, fetch: stubFetch({ version: "9.9.9" }).fetch })).resolves.toBeUndefined();
	});

	it("re-checks a cache it cannot read", async () => {
		const cachePath = cacheWith("not json");
		const { calls, fetch } = stubFetch({ version: "0.2.0" });
		await refreshLatest({ cachePath, now: 1, fetch });
		expect(calls).toHaveLength(1);
	});

	it("re-checks a cache stamped in the future by a clock that moved back", async () => {
		const cachePath = cacheWith(JSON.stringify({ checkedAt: 10_000, latest: "0.2.0" }));
		const { calls, fetch } = stubFetch({ version: "0.3.0" });
		await refreshLatest({ cachePath, now: 1_000, fetch });
		expect(calls).toHaveLength(1);
		expect(JSON.parse(readFileSync(cachePath, "utf8"))).toEqual({ checkedAt: 1_000, latest: "0.3.0" });
	});

	it("retries on the next launch after a failed check, so coming back online is not a 24 h wait", async () => {
		const cachePath = join(tempDir("leanpi-update-"), "update-check.json");
		const failing = (async () => {
			throw new Error("offline");
		}) as unknown as typeof globalThis.fetch;
		await refreshLatest({ cachePath, now: 1, fetch: failing });
		const { calls, fetch } = stubFetch({ version: "0.2.0" });
		await refreshLatest({ cachePath, now: 2, fetch });
		expect(calls).toHaveLength(1);
	});
});
