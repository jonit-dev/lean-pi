/**
 * "A newer LeanPi is out" — for the installed package only (PRD-043).
 *
 * Pi's own "Update Available" banner is the wrong signal here: it checks Pi and
 * tells the user to run `pi update`, which cannot move the Pi version this
 * package pins. In a source checkout that banner is still the maintainer's cue
 * to bump the pin, so `launchEnv` leaves it on there; in an installed package it
 * is switched off and this module is the notice the operator gets instead.
 *
 * Two halves, split so a launch never waits on the network:
 *
 * - `updateNotice` reads a small cache an *earlier* launch wrote, so the line
 *   costs one `readFileSync` and appears one launch after a release.
 * - `refreshLatest` does the registry request, fire-and-forget, at most once a
 *   day. Every failure is swallowed: an update check must never break a launch.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The registry document for this package: `{ version }` is all this needs. */
const LATEST_URL = "https://registry.npmjs.org/leanpi/latest";

/** One request a day per machine. A stale cache only delays the notice. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Short enough that a slow registry cannot hold the parent process open after
 * the Pi child exits, long enough for an ordinary request.
 */
const TIMEOUT_MS = 1500;

/** Where the check remembers what it saw. User-scope, so it is not per-repo. */
export function defaultCachePath(home: string = homedir()): string {
	return join(home, ".leanpi", "update-check.json");
}

interface UpdateCache {
	checkedAt: number;
	latest: string;
}

/** An absent, unreadable or malformed cache is simply "we have not checked". */
function readCache(cachePath: string): UpdateCache | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
		if (parsed === null || typeof parsed !== "object") return undefined;
		const { checkedAt, latest } = parsed as Partial<UpdateCache>;
		if (typeof checkedAt !== "number" || typeof latest !== "string") return undefined;
		return { checkedAt, latest };
	} catch {
		return undefined;
	}
}

/** `major.minor.patch` as three numbers, or `undefined` for anything else. */
function parseVersion(version: string): [number, number, number] | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
	if (match === null) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Numeric on the three release fields, which is what `latest` on the registry
 * always is. A prerelease tag or a string that does not parse is not a version
 * this can compare, so it never produces a notice — telling the user to install
 * something LeanPi cannot name the ordering of is worse than staying quiet.
 */
function isNewer(latest: string, current: string): boolean {
	const next = parseVersion(latest);
	const installed = parseVersion(current);
	if (next === undefined || installed === undefined) return false;
	for (let field = 0; field < 3; field++) {
		if (next[field] !== installed[field]) return next[field]! > installed[field]!;
	}
	return false;
}

/**
 * The line to print before Pi starts, or `undefined` when there is nothing to
 * say. Read-only and synchronous: this is on the startup path.
 */
export function updateNotice({ current, cachePath = defaultCachePath() }: { current: string; cachePath?: string }): string | undefined {
	const cached = readCache(cachePath);
	if (cached === undefined || !isNewer(cached.latest, current)) return undefined;
	return `leanpi v${cached.latest} is available (you have v${current}) — npm i -g leanpi@latest`;
}

export interface RefreshOptions {
	cachePath?: string;
	now?: number;
	fetch?: typeof globalThis.fetch;
}

/**
 * Ask the registry for the latest version and remember it, unless this machine
 * asked successfully within the last day. A *failed* check is retried on the
 * next launch: that is how a machine that came back online gets the notice
 * sooner, and the request is capped and never awaited, so the retry costs the
 * startup nothing. Never throws and never returns anything: the caller does not
 * await it, and there is no failure the user could act on.
 */
export async function refreshLatest({ cachePath = defaultCachePath(), now = Date.now(), fetch: request = globalThis.fetch }: RefreshOptions = {}): Promise<void> {
	const cached = readCache(cachePath);
	// `checkedAt <= now` too: a cache stamped in the future (a clock that moved
	// back) would otherwise count as fresh until the clock caught up to it.
	if (cached !== undefined && cached.checkedAt <= now && now - cached.checkedAt < REFRESH_AFTER_MS) return;
	try {
		const response = await request(LATEST_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!response.ok) return;
		const body = (await response.json()) as { version?: unknown };
		if (typeof body.version !== "string") return;
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(cachePath, `${JSON.stringify({ checkedAt: now, latest: body.version })}\n`);
	} catch {
		// Offline, slow, a proxy, a bad body, an unwritable home: none of these is
		// worth a word on the user's terminal.
	}
}
