#!/usr/bin/env node
/**
 * Controlled startup bench (PRD-054): launch LeanPi N times under a pty and
 * time each launch to a usable editor.
 *
 * Usage:
 *   node scripts/bench-startup.mjs [--runs 10] [--note "text"] [--launcher <path>] [--cwd <dir>]
 *
 * The default launcher is this checkout's `scripts/leanpi-local.sh`, the one
 * `pnpm link:bin` puts on PATH, so the number includes the shell wrapper and
 * the incremental build check. Each launch writes its own `pi` line to
 * `~/.leanpi/startup.jsonl` (`src/cli/startup-trace.ts`); the bench waits for
 * that line, kills the session, and appends one summary row to
 * `bench/out/startup-bench.jsonl`. `scripts/ux-kpi.mjs` reads the row and
 * leaves these launches out of the organic KPIs.
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BENCH_PATH, parseJsonl, percentile, startupLaunches } from "./ux-kpi.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TRACE = join(homedir(), ".leanpi", "startup.jsonl");

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : fallback;
}

const runs = Number(arg("runs", 10));
const launcher = resolve(arg("launcher", join(repoRoot, "scripts", "leanpi-local.sh")));
const cwd = resolve(arg("cwd", repoRoot));
const timeoutMs = 60_000;

const size = () => {
	try {
		return statSync(TRACE).size;
	} catch {
		return 0;
	}
};

function readFrom(offset) {
	const length = size() - offset;
	if (length <= 0) return "";
	const buffer = Buffer.alloc(length);
	const fd = openSync(TRACE, "r");
	try {
		readSync(fd, buffer, 0, length, offset);
	} finally {
		closeSync(fd);
	}
	return buffer.toString("utf8");
}

/** One launch: the first new painted `pi` line from this cwd, or `undefined` on timeout. */
async function launchOnce() {
	const offset = size();
	// `script` gives Pi the TTY it needs to paint; `detached` makes it a group we can kill whole.
	const child = spawn("script", ["-qfec", `'${launcher}'`, "/dev/null"], { cwd, detached: true, stdio: "ignore" });
	const deadline = Date.now() + timeoutMs;
	let row;
	while (!row && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 100));
		row = parseJsonl(readFrom(offset)).find((r) => r.proc === "pi" && r.cwd === cwd && r.marks?.["editor-painted"] !== undefined);
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		// Already gone.
	}
	await new Promise((r) => (child.exitCode === null ? child.once("exit", r) : r()));
	return row;
}

function git(...args) {
	try {
		return execFileSync("git", args, { cwd: dirname(dirname(launcher)), encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

function packageVersion(name) {
	try {
		return JSON.parse(readFileSync(join(dirname(dirname(launcher)), "node_modules", name, "package.json"), "utf8")).version;
	} catch {
		return undefined;
	}
}

// One discarded warm-up: the first launch after a build pays the transpile and cold disk cache.
process.stderr.write("warm-up… ");
await launchOnce();
const rows = [];
for (let i = 1; i <= runs; i++) {
	const row = await launchOnce();
	if (row) rows.push(row);
	process.stderr.write(row ? `${i}:${row.marks["editor-painted"]}ms ` : `${i}:timeout `);
}
process.stderr.write("\n");
if (rows.length === 0) {
	console.error(`No launch painted within ${timeoutMs / 1000}s. Run the launcher by hand to see why: ${launcher}`);
	process.exit(1);
}

const launches = startupLaunches(rows);
const phases = {};
for (const name of Object.keys(launches[0].phases)) phases[name] = percentile(launches.map((l) => l.phases[name]), 50);
const ms = launches.map((l) => l.ms);
const summary = {
	date: new Date().toISOString(),
	sha: `${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain") ? "-dirty" : ""}`,
	pi: packageVersion("@earendil-works/pi-coding-agent"),
	host: hostname(),
	runs: rows.length,
	p50: percentile(ms, 50),
	p90: percentile(ms, 90),
	min: Math.min(...ms),
	phases,
	...(arg("note") === undefined ? {} : { note: arg("note") }),
	t0s: rows.map((r) => r.t0),
};
appendFileSync(BENCH_PATH, `${JSON.stringify(summary)}\n`);
console.log(`startup p50 ${summary.p50} ms · p90 ${summary.p90} ms · min ${summary.min} ms · ${summary.runs}/${runs} runs · ${summary.sha} · pi ${summary.pi}`);
console.log(`phases p50: ${Object.entries(phases).map(([n, v]) => `${n} ${v} ms`).join(" · ")}`);
