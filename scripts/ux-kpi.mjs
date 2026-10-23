#!/usr/bin/env node
/**
 * UX KPIs from the logs LeanPi and Pi already write (PRD-054).
 *
 * Usage:
 *   node scripts/ux-kpi.mjs           # print the table, write ~/.leanpi/kpi.html
 *   node scripts/ux-kpi.mjs --json    # print the report as JSON (for the loop skill)
 *   node scripts/ux-kpi.mjs --days 7  # window length (default 30), compared with the window before it
 *
 * Sources, all read-only: `~/.leanpi/startup.jsonl` (time to editor),
 * `~/.pi/agent/sessions/*\/*.jsonl` (turns), `~/.pi/agent/crashes.json`, and
 * `bench/out/startup-bench.jsonl` (controlled startup runs, whose launches are
 * left out of the organic numbers).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DAY = 86_400_000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BENCH_PATH = join(repoRoot, "bench", "out", "startup-bench.jsonl");

/** `max` targets pass at or below the value. Change a target here and in docs/benchmarks/ux-kpis.md. */
export const KPIS = [
	{ id: "ready_p50", label: "Time to ready p50", unit: "ms", target: 2500 },
	{ id: "ready_p90", label: "Time to ready p90", unit: "ms", target: 5000 },
	{ id: "first_reply_p50", label: "First reply p50", unit: "ms", target: 10_000 },
	{ id: "error_rate", label: "Turns ending in error", unit: "%", target: 2 },
	{ id: "abort_rate", label: "Turns aborted", unit: "%", target: 5 },
	{ id: "crashes", label: "Crashes", unit: "count", target: 0 },
];

/** Nearest-rank percentile; `undefined` for no samples. */
export function percentile(values, p) {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function parseJsonl(text) {
	const rows = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			// A crashed writer leaves a partial last line; skip it.
		}
	}
	return rows;
}

/** `node_modules/.pnpm/<pkg>@<hash>/node_modules/<pkg>/x.js` → `<pkg>/x.js`; repo paths → repo-relative. */
function shortName(path) {
	const nm = path.lastIndexOf("node_modules/");
	if (nm >= 0) return path.slice(nm + "node_modules/".length);
	// Worktrees of this repo load the same files; count them as one.
	return path.replace(/^.*\/lean-pi\//, "").replace(/^(\.claude\/)?\.?worktrees\/[^/]+\//, "");
}

/** One entry per painted launch: total ms, the four phases, and Pi's per-extension import times. */
export function startupLaunches(rows, excludeT0 = new Set()) {
	const launches = [];
	for (const row of rows) {
		const m = row.marks ?? {};
		if (row.proc !== "pi" || m["editor-painted"] === undefined || excludeT0.has(row.t0)) continue;
		const imports = [];
		for (const line of row.pi_timing ?? []) {
			const match = /^(.*) module import: (\d+)ms$/.exec(line);
			if (match) imports.push({ name: shortName(match[1]), ms: Number(match[2]) });
		}
		const boot = m["node-start"] ?? 0;
		const ext = m["leanpi-extension"] ?? boot;
		const session = m.session_start ?? ext;
		launches.push({
			t: Date.parse(row.t0),
			ms: m["editor-painted"],
			cwd: basename(row.cwd ?? ""),
			phases: { launcher: boot, "pi boot": ext - boot, "extensions + runtime": session - ext, paint: m["editor-painted"] - session },
			imports,
		});
	}
	return launches;
}

/**
 * One entry per user message: when it was sent, how long until the first
 * assistant message finished, and the last assistant `stopReason` before the
 * next user message (`stop`, `toolUse`, `error`, `aborted`).
 */
export function sessionTurns(rows) {
	const turns = [];
	let turn;
	for (const row of rows) {
		const role = row.type === "message" ? row.message?.role : undefined;
		if (role === "user") {
			turn = { t: Date.parse(row.timestamp) };
			turns.push(turn);
		} else if (role === "assistant" && turn) {
			turn.firstReplyMs ??= Date.parse(row.timestamp) - turn.t;
			turn.end = row.message.stopReason;
		}
	}
	return turns;
}

function kpiValue(id, launches, turns, crashes) {
	const answered = turns.filter((t) => t.end !== undefined);
	const rate = (end) => (answered.length === 0 ? undefined : (100 * answered.filter((t) => t.end === end).length) / answered.length);
	switch (id) {
		case "ready_p50":
			return percentile(launches.map((l) => l.ms), 50);
		case "ready_p90":
			return percentile(launches.map((l) => l.ms), 90);
		case "first_reply_p50":
			return percentile(answered.map((t) => t.firstReplyMs), 50);
		case "error_rate":
			return rate("error");
		case "abort_rate":
			return rate("aborted");
		case "crashes":
			return crashes.length;
	}
}

/** The KPI table for the `days` before `now`, the window before it, and a 30-day daily series. */
export function computeReport({ launches, turns, crashTimes, now = Date.now(), days = 30 }) {
	const within = (items, from, to) => items.filter((x) => (x.t ?? x) >= from && (x.t ?? x) < to);
	const slice = (from, to) => [within(launches, from, to), within(turns, from, to), within(crashTimes, from, to)];
	const cur = slice(now - days * DAY, now);
	const prev = slice(now - 2 * days * DAY, now - days * DAY);
	const kpis = KPIS.map((k) => {
		const value = kpiValue(k.id, ...cur);
		const series = [];
		for (let d = 29; d >= 0; d--) series.push(kpiValue(k.id, ...slice(now - (d + 1) * DAY, now - d * DAY)) ?? null);
		return { ...k, value, prev: kpiValue(k.id, ...prev), pass: value === undefined ? undefined : value <= k.target, series };
	});
	const [curLaunches, curTurns] = cur;
	const phases = {};
	for (const name of Object.keys(curLaunches[0]?.phases ?? {})) phases[name] = percentile(curLaunches.map((l) => l.phases[name]), 50);
	const byImport = {};
	for (const l of curLaunches) for (const i of l.imports) (byImport[i.name] ??= []).push(i.ms);
	const imports = Object.entries(byImport)
		.map(([name, ms]) => ({ name, p50: percentile(ms, 50) }))
		.sort((a, b) => b.p50 - a.p50)
		.slice(0, 8);
	return {
		generated: new Date(now).toISOString(),
		windowStart: now - days * DAY,
		days,
		samples: { launches: curLaunches.length, turns: curTurns.length },
		kpis,
		phases,
		imports,
		launches: curLaunches.map(({ imports: _, ...l }) => l).sort((a, b) => a.t - b.t),
	};
}

export function format(value, unit) {
	if (value === undefined || value === null) return "–";
	if (unit === "ms") return value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
	if (unit === "%") return `${value.toFixed(1)}%`;
	return String(value);
}

/** The dashboard: `scripts/ux-kpi-dashboard.html` with the report and bench rows inlined as JSON. */
export function renderHtml(report, bench = []) {
	const template = readFileSync(join(repoRoot, "scripts", "ux-kpi-dashboard.html"), "utf8");
	// `<` escaped so a cwd or note can never close the script tag.
	const json = JSON.stringify({ ...report, bench }).replace(/</g, "\\u003c");
	return template.replace("/*DATA*/null", () => json);
}

function readText(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

/** Every source, read once. Session files untouched for longer than two windows are skipped. */
export function loadSources(home = homedir(), now = Date.now(), days = 30) {
	const bench = parseJsonl(readText(BENCH_PATH));
	const benchT0 = new Set(bench.flatMap((b) => b.t0s ?? []));
	const launches = startupLaunches(parseJsonl(readText(join(home, ".leanpi", "startup.jsonl"))), benchT0);
	const turns = [];
	const sessions = join(home, ".pi", "agent", "sessions");
	for (const dir of existsSync(sessions) ? readdirSync(sessions) : []) {
		for (const file of readdirSync(join(sessions, dir))) {
			const path = join(sessions, dir, file);
			if (!file.endsWith(".jsonl") || statSync(path).mtimeMs < now - Math.max(2 * days, 30) * DAY) continue;
			turns.push(...sessionTurns(parseJsonl(readText(path))));
		}
	}
	let crashes = [];
	try {
		crashes = JSON.parse(readText(join(home, ".pi", "agent", "crashes.json")) || "[]");
	} catch {
		// Unreadable crash log: report zero rather than fail the report.
	}
	return { launches, turns, crashTimes: crashes.map((c) => Date.parse(c.timestamp)), bench };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const daysArg = process.argv.indexOf("--days");
	const days = daysArg > 0 ? Number(process.argv[daysArg + 1]) : 30;
	const { bench, ...sources } = loadSources(homedir(), Date.now(), days);
	const report = computeReport({ ...sources, days });
	if (process.argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify({ ...report, bench: bench.slice(-5) }, null, 2)}\n`);
	} else {
		const out = join(homedir(), ".leanpi", "kpi.html");
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, renderHtml(report, bench));
		console.log(`UX KPIs, last ${report.days} days (${report.samples.launches} launches, ${report.samples.turns} turns)\n`);
		for (const k of report.kpis) {
			const mark = k.pass === undefined ? "  " : k.pass ? "ok" : "!!";
			console.log(`${mark}  ${k.label.padEnd(24)} ${format(k.value, k.unit).padStart(9)}   target ≤ ${format(k.target, k.unit).padEnd(8)} prev ${format(k.prev, k.unit)}`);
		}
		console.log(`\nStartup p50 by phase: ${Object.entries(report.phases).map(([n, ms]) => `${n} ${format(ms, "ms")}`).join(" · ")}`);
		console.log(`Dashboard: file://${out}`);
	}
}
