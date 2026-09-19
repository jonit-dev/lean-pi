/**
 * The bench CLI (PRD-021's one entry point).
 *
 * `main()` is argument parsing plus dispatch, nothing else: a run, a suite
 * listing, or one of the two telemetry reports. Every failure is a named
 * `BenchError` the operator can act on, and the exit code never depends on §4's
 * aspirational targets — a benchmark that honestly reports "LeanPi cost 60% of
 * baseline" has succeeded as a benchmark.
 *
 * Usage:
 *   bench --suite bench/suites/seed --configs leanpi-no-jev,leanpi-jev
 *   bench --list
 *   bench --report jev --from bench/fixtures/telemetry/jev
 *   bench --report rtk --from bench/fixtures/telemetry/rtk
 *   bench --recompute bench/out/<runId>
 */
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import type { PermissionEnv } from "../permissions/trust.js";
import type { LeanPiConfig } from "../core/types.js";
import { readRuns } from "../telemetry/store.js";
import { EXTERNAL_BASELINES_FLAG, externalBaselinesEnabled, type AdapterDeps } from "./adapters.js";
import type { RubricJudge } from "./adjudicate.js";
import { foldReport, renderReportMarkdown, type BenchReport } from "./metrics.js";
import { jevReport, renderJevReport } from "./report/jev.js";
import { renderRtkReport, rtkReport } from "./report/rtk.js";
import { readTelemetryDir } from "./report/source.js";
import { readLedger, runBench, type BenchRun } from "./runner.js";
import { benchPath, CONFIG_DIR, coverageOf, loadConfigRows, loadSuite, renderSuiteList, SEED_SUITE_DIR, SUITE_TARGET } from "./suite.js";
import { BenchError, type BenchAttemptExecutor, type BenchLedgerRow, type BenchWorkspacePreparer } from "./types.js";

export const USAGE = `usage: bench [--suite <dir>] [--configs <ids>] [--out <dir>] [--run-id <id>] [--keep-workspaces]
             [--list]
             [--report jev|rtk --from <dir>]
             [--recompute <runDir>]`;

export interface CliIo {
	write(text: string): void;
	error(text: string): void;
}

export interface CliOptions {
	cwd?: string;
	/** The loaded configuration; loaded from `cwd` when absent. */
	config?: LeanPiConfig;
	env?: NodeJS.ProcessEnv;
	io?: CliIo;
	/** The LeanPi session factory for `leanpi` rows; `bench/cli.ts` passes the package entry's. */
	adapterDeps?: Omit<AdapterDeps, "config">;
	/** Overrides every row's adapter (tests). */
	execute?: BenchAttemptExecutor;
	/** Overrides the throwaway-checkout preparation (tests). */
	prepare?: BenchWorkspacePreparer;
	rubricJudge?: RubricJudge;
	now?: () => Date;
}

interface Parsed {
	suite?: string;
	configs?: string;
	out?: string;
	runId?: string;
	keepWorkspaces?: boolean;
	list?: boolean;
	report?: string;
	from?: string;
	recompute?: string;
}

function parseArgs(argv: readonly string[]): Parsed {
	const parsed: Parsed = {};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = (): string => {
			const next = argv[index + 1];
			if (next === undefined || next.startsWith("--")) throw new BenchError(`${flag} needs a value`, "usage");
			index += 1;
			return next;
		};
		if (flag === "--suite") parsed.suite = value();
		else if (flag === "--configs") parsed.configs = value();
		else if (flag === "--out") parsed.out = value();
		else if (flag === "--run-id") parsed.runId = value();
		else if (flag === "--from") parsed.from = value();
		else if (flag === "--recompute") parsed.recompute = value();
		else if (flag === "--list") parsed.list = true;
		else if (flag === "--keep-workspaces") parsed.keepWorkspaces = true;
		else if (flag === "--report") {
			const kind = value();
			if (kind !== "jev" && kind !== "rtk") throw new BenchError(`--report takes jev or rtk, got "${kind}"`, "usage");
			parsed.report = kind;
		} else throw new BenchError(`unknown flag "${flag}"\n${USAGE}`, "usage");
	}
	return parsed;
}

/** The configuration matrix's roster, so `--list` shows what can be selected. */
function configTable(rows: ReturnType<typeof loadConfigRows>, configDir: string): string {
	const lines = [`configurations (${configDir}):`, ""];
	lines.push("| id | adapter | executor model | JEV | features | owner-gated |");
	lines.push("| --- | --- | --- | --- | --- | --- |");
	for (const row of rows) lines.push(`| ${row.id} | ${row.adapter} | ${row.executor_model} | ${row.jev} | ${row.features.join(", ") || "-"} | ${row.owner_gated ? "yes" : "no"} |`);
	return `${lines.join("\n")}\n`;
}

/** `--list`: the suite inventory, the §55 coverage table and the matrix's roster. */
export function listSuite(suiteDir: string, configDir: string, cwd: string): string {
	const suite = loadSuite(suiteDir, cwd);
	const rows = loadConfigRows(configDir, cwd);
	const covered = coverageOf(suite.tasks).filter((row) => row.filled).length;
	return `${renderSuiteList(suite)}\n${configTable(rows, configDir)}\n§55 target ${SUITE_TARGET.min}–${SUITE_TARGET.max} tasks; this suite holds ${suite.tasks.length} and fills ${covered} categor${
		covered === 1 ? "y" : "ies"
	}. External baselines are owner-gated: set ${EXTERNAL_BASELINES_FLAG}=1 to run them.\n`;
}

/**
 * Recompute a report from a run directory's ledger and store, without re-running
 * anything. This is what makes "every value derives from the ledger" checkable:
 * hand-edit a ledger row and the recomputed rate moves.
 */
export function recompute(
	runDir: string,
	config: LeanPiConfig,
	options: { cwd?: string; configDir?: string; generated_at?: string } = {},
): { report: BenchReport; markdown: string; ledger: BenchLedgerRow[] } {
	const ledger = readLedger(join(runDir, "ledger.jsonl"));
	const telemetry = readRuns(runDir, {}, { telemetry_path: join(runDir, "telemetry.jsonl") });
	const rows = loadConfigRows(options.configDir ?? CONFIG_DIR, options.cwd ?? process.cwd());
	const report = foldReport({
		run_id: ledger[0]?.run_id ?? "unknown",
		generated_at: options.generated_at ?? new Date().toISOString(),
		suite_dir: SEED_SUITE_DIR,
		// The fold needs the task identities the ledger names; the suite files are
		// not re-read, so a report over an edited ledger is reproducible from it.
		tasks: [...new Set(ledger.map((attempt) => attempt.task_id))].map((id) => ({ id })),
		ledger,
		telemetry,
		configs: rows.filter((row) => ledger.some((attempt) => attempt.config_id === row.id)),
		config,
	});
	return { report, markdown: renderReportMarkdown(report, ledger), ledger };
}

export async function main(argv: readonly string[], options: CliOptions = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const io = options.io ?? { write: (text: string) => process.stdout.write(text), error: (text: string) => process.stderr.write(text) };
	try {
		const parsed = parseArgs(argv);
		// `--list` and the two reports read no project configuration at all, so the
		// load is deferred until a path that actually needs it.
		const loaded = () => options.config ?? loadConfig(cwd, {}, options.env as PermissionEnv | undefined);
		if (parsed.list) {
			io.write(listSuite(parsed.suite ?? SEED_SUITE_DIR, CONFIG_DIR, cwd));
			return 0;
		}
		if (parsed.report !== undefined) {
			if (parsed.from === undefined) throw new BenchError(`--report ${parsed.report} needs --from <dir>`, "usage");
			const from = benchPath(parsed.from, cwd);
			if (parsed.report === "jev") {
				io.write(renderJevReport(jevReport(readTelemetryDir(from))));
				return 0;
			}
			io.write(renderRtkReport(rtkReport(from)));
			return 0;
		}
		if (parsed.recompute !== undefined) {
			const result = recompute(benchPath(parsed.recompute, cwd), loaded(), { cwd });
			io.write(result.markdown);
			return 0;
		}
		if (options.adapterDeps === undefined && options.execute === undefined) {
			throw new BenchError(
				"no LeanPi session factory: bench/cli.ts (the lane entry) passes the package entry's createLeanPiSession(); call src/bench/cli.ts's main from a test with a scripted session instead",
				"adapter",
			);
		}
		const configIds = parsed.configs !== undefined
			? parsed.configs.split(",").map((id) => id.trim()).filter((id) => id.length > 0)
			: loadConfigRows(CONFIG_DIR, cwd)
					.filter((row) => !row.owner_gated || externalBaselinesEnabled(options.env ?? process.env))
					.map((row) => row.id);
		const run: BenchRun = await runBench({
			cwd,
			config: loaded(),
			suiteDir: parsed.suite ?? SEED_SUITE_DIR,
			configDir: CONFIG_DIR,
			configIds,
			...(parsed.out ? { outDir: parsed.out } : {}),
			...(parsed.runId ? { runId: parsed.runId } : {}),
			...(parsed.keepWorkspaces ? { keepWorkspaces: true } : {}),
			...(options.execute ? { execute: options.execute } : {}),
			...(options.prepare ? { prepare: options.prepare } : {}),
			...(options.adapterDeps ? { adapterDeps: options.adapterDeps } : {}),
			...(options.rubricJudge ? { rubricJudge: options.rubricJudge } : {}),
			...(options.env ? { env: options.env } : {}),
			...(options.now ? { now: options.now } : {}),
		});
		io.write(renderReportMarkdown(run.report, run.ledger));
		io.error(`bench: ${run.ledger.length} attempt(s) written to ${run.ledger_path}; report at ${run.report_path}\n`);
		return 0;
	} catch (error) {
		if (error instanceof BenchError) {
			io.error(`bench: ${error.message}\n`);
			return error.kind === "usage" ? 2 : 1;
		}
		throw error;
	}
}
