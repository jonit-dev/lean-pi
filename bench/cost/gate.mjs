#!/usr/bin/env node
/**
 * PRD-038 — the pre-publish cost-regression gate.
 *
 * Runs the four-way benchmark (LeanPi + stock Pi), folds it with the canonical
 * `summarize.py`, and fails when LeanPi regresses against a recorded baseline.
 * Wired into `prepublishOnly` but inert unless `LEANPI_COST_GATE=1`, because a
 * run is ~$0.12 and ~8 minutes — a normal publish must not pay for it.
 *
 * The decision is `compareToBaseline`, a pure function over summarize.py's
 * output; the expensive part is only reached when the gate is armed.
 *
 * Usage:
 *   node bench/cost/gate.mjs                     # skip unless LEANPI_COST_GATE=1
 *   LEANPI_COST_GATE=1 node bench/cost/gate.mjs  # run the benchmark and enforce
 *   node bench/cost/gate.mjs --from-run <id>     # score an existing run, no spend
 *   node bench/cost/gate.mjs --from-run <id> --record   # rewrite the baseline
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT_DIR = join(ROOT, "bench/out");
const RUN_QUAD = join(OUT_DIR, "four-way-20260921/run-quad.mjs");
const SUMMARIZE = join(ROOT, "bench/skills/fair-agent-benchmarks/scripts/summarize.py");
const BASELINE_PATH = join(ROOT, "bench/cost/baseline.json");

/** The arming flag. Unset means "skip", never "guess". */
export const GATE_FLAG = "LEANPI_COST_GATE";
/** Default slack on the ratio, used when the baseline names none. */
export const DEFAULT_TOLERANCE = 0.15;
/**
 * Default slack on the pass rate, in absolute terms. At n=5 a single failed
 * trial is a 20-point dip, so anything tighter turns sampling noise into a
 * blocked publish; anything looser stops catching a run that is cheaper because
 * it stopped finishing tasks.
 */
export const DEFAULT_PASSRATE_TOLERANCE = 0.2;
export { BASELINE_PATH };

/**
 * The gate's decision, pure over its two inputs.
 *
 * Fails on three distinct things: a LeanPi/stock ratio that drifts past
 * tolerance, a LeanPi pass rate below the baseline, and an arm whose cost is
 * unprovable. The ratio is the primary check because both arms run in one
 * session under one rate card, so a provider price change cancels.
 */
export function compareToBaseline(baseline, summary, options = {}) {
	const tolerance = options.tolerance ?? baseline.tolerance ?? DEFAULT_TOLERANCE;
	const lean = summary?.arms?.leanpi;
	const stock = summary?.arms?.["stock-pi"];
	const leanCost = lean?.cost_per_verified_completion ?? null;
	const stockCost = stock?.cost_per_verified_completion ?? null;
	const leanPassrate = lean?.passrate ?? null;
	const checks = [];
	const failures = [];

	const complete = typeof leanCost === "number" && typeof stockCost === "number" && stockCost > 0 && typeof leanPassrate === "number";
	checks.push({ name: "completeness", ok: complete, actual: complete ? 1 : 0, limit: 1 });
	if (!complete) {
		failures.push(
			`completeness: a cost per verified completion is unprovable (leanpi=${leanCost}, stock-pi=${stockCost}, passrate=${leanPassrate}); summarize.py could not price the run, so re-run the gate`,
		);
		return { ok: false, tolerance, checks, failures };
	}

	const ratio = leanCost / stockCost;
	const ratioLimit = baseline.ratio * (1 + tolerance);
	const ratioOk = ratio <= ratioLimit;
	checks.push({ name: "ratio", ok: ratioOk, actual: ratio, limit: ratioLimit });
	if (!ratioOk) {
		failures.push(
			`ratio: leanpi/stock-pi $/verified is ${ratio.toFixed(4)}, above the ${ratioLimit.toFixed(4)} limit (baseline ${baseline.ratio.toFixed(4)} + ${(tolerance * 100).toFixed(0)}%)`,
		);
	}

	const passLimit = baseline.leanpi_passrate - (baseline.passrate_tolerance ?? 0);
	const passOk = leanPassrate >= passLimit;
	checks.push({ name: "passrate", ok: passOk, actual: leanPassrate, limit: passLimit });
	if (!passOk) {
		failures.push(`passrate: leanpi verified ${(leanPassrate * 100).toFixed(0)}%, below the ${(passLimit * 100).toFixed(0)}% floor`);
	}

	return { ok: failures.length === 0, tolerance, checks, failures };
}

/** summarize.py's output for a run directory. A failure to summarize is itself a gate failure. */
export function runSummarize(runDir, spawn = spawnSync) {
	const summaryInput = join(runDir, "summary-input.json");
	if (!existsSync(summaryInput)) throw new Error(`no summary-input.json in ${runDir}`);
	const run = spawn("python3", [SUMMARIZE, summaryInput], { encoding: "utf8" });
	if (run.status !== 0) throw new Error(`summarize.py exited ${run.status}: ${(run.stderr ?? "").trim()}`);
	return JSON.parse(run.stdout);
}

/** The baseline a run records: the ratio, the pass rate, and where they came from. */
export function baselineFrom(runDir, summary, { tolerance = DEFAULT_TOLERANCE } = {}) {
	const lean = summary.arms.leanpi;
	const stock = summary.arms["stock-pi"];
	const resultPath = join(runDir, "result.json");
	const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : {};
	return {
		task: result.results?.[0]?.task ?? "unknown",
		model: result.model ?? "unknown",
		provider: result.provider ?? "unknown",
		recorded_at: new Date().toISOString().slice(0, 10),
		source_run: runDir.split("/").pop(),
		git_sha: result.leanpi_build?.git_sha ?? null,
		trials: lean.total_trials ?? null,
		tolerance,
		passrate_tolerance: DEFAULT_PASSRATE_TOLERANCE,
		ratio: lean.cost_per_verified_completion / stock.cost_per_verified_completion,
		leanpi_passrate: lean.passrate,
		arms: { leanpi: lean, "stock-pi": stock },
	};
}

function parseArgs(argv) {
	const args = { trials: 5, tolerance: undefined, fromRun: undefined, runId: undefined, record: false, force: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--trials") args.trials = Number(argv[++i]);
		else if (arg === "--tolerance") args.tolerance = Number(argv[++i]);
		else if (arg === "--from-run") args.fromRun = argv[++i];
		else if (arg === "--run-id") args.runId = argv[++i];
		else if (arg === "--record") args.record = true;
		else if (arg === "--force") args.force = true;
		else throw new Error(`unknown argument "${arg}"`);
	}
	return args;
}

function spawnOrDie(label, command, commandArgs, env) {
	const run = spawnSync(command, commandArgs, { encoding: "utf8", env: { ...process.env, ...env }, stdio: "inherit" });
	if (run.status !== 0) throw new Error(`${label} exited ${run.status ?? run.signal}`);
}

/** Preflight (offline) then the paid run, both under one RUN_ID. */
function runBenchmark(args) {
	if (!process.env.OPENCODE_API_KEY) throw new Error(`OPENCODE_API_KEY is unset; the gate cannot run the benchmark`);
	const runId = args.runId ?? `cost-gate-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	const env = { RUN_ID: runId };
	console.log(`[cost-gate] preflight ${runId}`);
	spawnOrDie("preflight", process.execPath, [RUN_QUAD], env);
	console.log(`[cost-gate] benchmark ${runId} (${args.trials} trials/arm)`);
	spawnOrDie("benchmark", process.execPath, [RUN_QUAD, "--run", "--trials", String(args.trials), "--arms", "leanpi,stock-pi"], env);
	return join(OUT_DIR, runId);
}

async function main(argv) {
	const args = parseArgs(argv);
	// `--from-run` and `--force` are explicit invocations that spend nothing; a bare
	// run is the armed path. Anything else skips rather than silently passing.
	if (!args.force && !args.fromRun && process.env[GATE_FLAG] !== "1") {
		console.log(`[cost-gate] skipped: set ${GATE_FLAG}=1 to run it (~$0.12, ~8 min), or pass --from-run <id>`);
		return 0;
	}

	const runDir = args.fromRun ? join(OUT_DIR, args.fromRun) : runBenchmark(args);
	const summary = runSummarize(runDir);

	if (args.record) {
		const baseline = baselineFrom(runDir, summary, args.tolerance === undefined ? {} : { tolerance: args.tolerance });
		writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
		console.log(`[cost-gate] recorded baseline from ${baseline.source_run}: ratio ${baseline.ratio.toFixed(4)}, passrate ${baseline.leanpi_passrate}`);
		return 0;
	}

	const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
	const result = compareToBaseline(baseline, summary, args.tolerance === undefined ? {} : { tolerance: args.tolerance });
	for (const check of result.checks) {
		console.log(`[cost-gate] ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${Number(check.actual).toFixed(4)} (limit ${Number(check.limit).toFixed(4)})`);
	}
	if (result.ok) {
		console.log(`[cost-gate] PASS — no cost regression against ${baseline.source_run}`);
		return 0;
	}
	for (const failure of result.failures) console.error(`[cost-gate] ${failure}`);
	return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2))
		.then((code) => process.exit(code))
		.catch((error) => {
			console.error(`[cost-gate] ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		});
}
