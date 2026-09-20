/**
 * The task × configuration runner and its ledger (PRD-021 Phase 1).
 *
 * One attempt per (task, configuration). Each attempt happens in a *fresh
 * throwaway checkout* of the task's source repository at its pinned revision;
 * the held-out golden is never written there, so the adjudicator's check stays
 * held out rather than becoming part of the prompt.
 *
 * The run's §52 records all land in one store inside the run directory
 * (`bench/out/<runId>/telemetry.jsonl`), because the store location is PRD-015's
 * `cost.telemetry_path` override — that is what lets the metrics join attempts
 * that ran in different workspaces. A ledger row whose record cannot be joined
 * is the run's hard error: an attempt without telemetry is never a free success.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LeanPiConfig } from "../core/types.js";
import type { RunTelemetry } from "../telemetry/record.js";
import { readRuns } from "../telemetry/store.js";
import { attemptExecutorFor, externalBaselinesEnabled, vendorAvailable, type AdapterDeps } from "./adapters.js";
import { adjudicateAttempt, type RubricJudge } from "./adjudicate.js";
import { foldReport, renderReportMarkdown, type BenchReport } from "./metrics.js";
import { benchPath, loadConfigRows, loadSuite, selectConfigRows } from "./suite.js";
import {
	BenchError,
	type BenchAttempt,
	type BenchAttemptExecutor,
	type BenchConfigRow,
	type BenchLedgerRow,
	type BenchTask,
	type BenchWorkspace,
	type BenchWorkspacePreparer,
} from "./types.js";

/** Where a run's artifacts go. */
export const OUT_DIR_DEFAULT = "bench/out";

export interface BenchRunOptions {
	/** Package root: the suite, the config matrix and the output directory resolve against it. */
	cwd: string;
	config: LeanPiConfig;
	suiteDir: string;
	configDir: string;
	configIds: readonly string[];
	runId?: string;
	outDir?: string;
	/** Overrides every row's adapter. The lane entry passes none; tests pass a scripted attempt. */
	execute?: BenchAttemptExecutor;
	/** Overrides the throwaway-checkout preparation. */
	prepare?: BenchWorkspacePreparer;
	rubricJudge?: RubricJudge;
	/** The LeanPi session factory a `leanpi` row needs. */
	adapterDeps?: Omit<AdapterDeps, "config">;
	env?: NodeJS.ProcessEnv;
	keepWorkspaces?: boolean;
	now?: () => Date;
	/** What an interrupt handler exits through; tests inject a recorder instead of killing the process. */
	exit?: (code: number) => void;
}

export interface BenchRun {
	run_id: string;
	dir: string;
	ledger_path: string;
	telemetry_path: string;
	report_path: string;
	report_json_path: string;
	ledger: BenchLedgerRow[];
	report: BenchReport;
}

/**
 * A throwaway checkout at the task's pinned revision: `git clone` (which accepts
 * a URL or a local path) then a detached checkout of `source.commit`. The clone
 * is blobless — object *trees* come with it and file blobs are fetched on
 * demand — so a pinned revision costs kilobytes, and the golden's later
 * `git checkout <fix_commit> -- <files>` can still reach the fix commit's tests.
 */
export function cloneWorkspace(task: BenchTask, runDir: string, options: { keep?: boolean; env?: NodeJS.ProcessEnv } = {}): BenchWorkspace {
	const dir = join(runDir, "workspaces", task.id);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(runDir, "workspaces"), { recursive: true });
	const clone = spawnSync("git", ["clone", "--filter=blob:none", "--no-checkout", "--quiet", task.source.repo, dir], {
		encoding: "utf8",
		timeout: 1_800_000,
		env: options.env ?? process.env,
	});
	if (clone.status !== 0) {
		throw new BenchError(`git clone ${task.source.repo} failed: ${(clone.stderr ?? clone.error?.message ?? "").trim().split("\n").slice(-2).join(" ")}`, "workspace");
	}
	const checkout = spawnSync("git", ["-C", dir, "checkout", "--detach", "--quiet", task.source.commit], { encoding: "utf8", timeout: 1_800_000 });
	if (checkout.status !== 0) {
		throw new BenchError(
			`${task.source.repo} has no revision ${task.source.commit} (${task.source.pinned_via}): ${(checkout.stderr ?? "").trim().split("\n").slice(-2).join(" ")}`,
			"workspace",
		);
	}
	return {
		dir,
		cleanup() {
			if (options.keep === true) return;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function telemetryConfig(config: LeanPiConfig, storePath: string): LeanPiConfig {
	// PRD-015's `cost:` block, which PRD-001's loader passes through untouched: the
	// run pins the store so every attempt's record lands in one place.
	return { ...config, cost: { ...((config as { cost?: Record<string, unknown> }).cost ?? {}), telemetry_path: storePath } } as LeanPiConfig;
}

/** The owner gate: a subscription baseline refuses to run instead of reporting an empty row. */
function assertRunnableRows(rows: readonly BenchConfigRow[], env: NodeJS.ProcessEnv): void {
	for (const row of rows) {
		if (row.owner_gated && !externalBaselinesEnabled(env)) {
			throw new BenchError(
				`config "${row.id}" needs joao's logged-in CLI and is gated: set ${"LEANPI_BENCH_EXTERNAL_BASELINES"}=1 to run it (see AC-4)`,
				"owner-gate",
			);
		}
		if (row.adapter === "external" && vendorAvailable(row, env) === false) {
			throw new BenchError(`config "${row.id}" needs the ${row.vendor} CLI on PATH; install it and log in before running this row`, "adapter");
		}
	}
}

export async function runBench(options: BenchRunOptions): Promise<BenchRun> {
	const env = options.env ?? process.env;
	const now = options.now ?? (() => new Date());
	const suite = loadSuite(options.suiteDir, options.cwd);
	const rows = selectConfigRows(loadConfigRows(options.configDir, options.cwd), options.configIds);
	assertRunnableRows(rows, env);
	const runId = options.runId ?? `run-${now().toISOString().replace(/[:.]/g, "-")}`;
	const dir = join(benchPath(options.outDir ?? OUT_DIR_DEFAULT, options.cwd), runId);
	const ledgerPath = join(dir, "ledger.jsonl");
	const storePath = join(dir, "telemetry.jsonl");
	mkdirSync(dir, { recursive: true });
	const config = telemetryConfig(options.config, storePath);
	if (existsSync(ledgerPath)) {
		throw new BenchError(`run "${runId}" already exists at ${ledgerPath}: a ledger is evidence, so a run id is never appended to twice (pass --run-id)`, "usage");
	}
	const ledger: BenchLedgerRow[] = [];
	if (options.execute === undefined && options.adapterDeps === undefined) {
		throw new BenchError("the run has no executor: pass adapterDeps (bench/cli.ts does) or an explicit execute", "adapter");
	}

	/** Fold this run's report from its ledger and store, and write both artifacts. */
	const writeReport = (): BenchReport => {
		const telemetry: RunTelemetry[] = readRuns(dir, {}, { telemetry_path: storePath });
		const report = foldReport({
			run_id: runId,
			generated_at: now().toISOString(),
			suite_dir: suite.dir,
			tasks: suite.tasks,
			ledger,
			telemetry,
			configs: rows,
			config,
		});
		appendFileSync(join(dir, "report.md"), renderReportMarkdown(report, ledger));
		appendFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
		return report;
	};

	// An attempt in flight when the operator interrupts the run has spent money and
	// proven nothing. The adapter's flush writes its §52 record; the row below
	// records it as an error, so the interrupted spend lands in the run's total
	// instead of in nobody's. Every handler is removed on the normal path.
	let inflight: { attempt: BenchAttempt; task: BenchTask; row: BenchConfigRow; startedAt: string; flush: (() => void) | null } | null = null;
	const onSignal = (signal: NodeJS.Signals): void => {
		inflight?.flush?.();
		if (inflight) {
			const { attempt, task, row, startedAt } = inflight;
			const partial = readRuns(dir, { taskId: attempt.telemetry_task_id }, { telemetry_path: storePath }).at(-1);
			const rowOut: BenchLedgerRow = {
				run_id: runId,
				task_id: task.id,
				config_id: row.id,
				telemetry_task_id: attempt.telemetry_task_id,
				session_id: attempt.session_id,
				source: task.source,
				budget_usd: row.budget_usd,
				reported_success: partial?.result.success ?? false,
				adjudication: {
					verdict: "error",
					kind: "none",
					adjudicator: "interrupted",
					reason: `the run was interrupted by ${signal} while this attempt was in flight`,
					rubric_model: null,
					reviewer_model: partial?.reviewer_model ?? null,
				},
				adapter: { operator: row.adapter, extensions: [], note: `interrupted by ${signal}` },
				note: `interrupted by ${signal}: the attempt's spend is recorded and its verdict is not`,
				started_at: startedAt,
				finished_at: now().toISOString(),
			};
			ledger.push(rowOut);
			appendFileSync(ledgerPath, `${JSON.stringify(rowOut)}\n`);
		}
		writeReport();
		(options.exit ?? ((code: number) => process.exit(code)))(130);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	/** The rows' attempts, in order. Extracted so the signal handlers have one exit path. */
	const runRows = async (): Promise<void> => {
		for (const row of rows) {
			let spent = 0;
			let stopped = false;
		for (const [taskIndex, task] of suite.tasks.entries()) {
			if (stopped) break;
			const workspace = await (options.prepare ?? ((candidate, runDirectory) => cloneWorkspace(candidate, runDirectory, { keep: options.keepWorkspaces, env })))(task, dir);
			const attempt: BenchAttempt = {
				task,
				config: row,
				workspace: workspace.dir,
				session_id: `${runId}:${row.id}:${task.id}`,
				telemetry_task_id: `${task.id}@${row.id}`,
				telemetry_path: storePath,
			};
			const startedAt = now().toISOString();
			let note: string | null = null;
			let adapter: BenchLedgerRow["adapter"] = { operator: row.adapter, extensions: [], note: null };
			inflight = { attempt, task, row, startedAt, flush: null };
			try {
				for (const command of task.setup) {
					// The task's own preparation (dependency install, generated sources):
					// its failure is the run's, named with the command that failed.
					const setup = spawnSync("/bin/sh", ["-c", command], { cwd: workspace.dir, encoding: "utf8", timeout: 1_800_000, maxBuffer: 32 * 1024 * 1024 });
					if (setup.error || setup.status !== 0) {
						const output = `${setup.stdout ?? ""}${setup.stderr ?? ""}`.trim().split("\n").slice(-3).join(" ");
						throw new BenchError(`task "${task.id}" setup failed: ${command} — ${setup.error?.message ?? output}`, "workspace");
					}
				}
				const executor = options.execute ?? attemptExecutorFor(row, { ...(options.adapterDeps as Omit<AdapterDeps, "config">), config });
				const result = await executor(attempt, { onInterrupt: (flush) => { if (inflight) inflight.flush = flush; } });
				adapter = { operator: result.operator, extensions: result.extensions, note: result.note };
			} catch (error) {
				inflight = null;
				workspace.cleanup();
				throw error;
			}
			const records = readRuns(dir, { taskId: attempt.telemetry_task_id }, { telemetry_path: storePath });
			const record = records[records.length - 1];
			if (!record) {
				workspace.cleanup();
				throw new BenchError(
					`task "${task.id}" under config "${row.id}" wrote no §52 record for telemetry task id "${attempt.telemetry_task_id}"; the store ${storePath} holds ${readRuns(dir, {}, { telemetry_path: storePath }).length} row(s)`,
					"telemetry-join",
				);
			}
			const adjudication = await adjudicateAttempt(attempt, {
				base: options.cwd,
				config,
				reviewer_model: record.reviewer_model,
				...(options.rubricJudge ? { rubricJudge: options.rubricJudge } : {}),
			});
			spent += record.cost.effective_cost;
			if (row.budget_usd > 0 && spent >= row.budget_usd && taskIndex < suite.tasks.length - 1) {
				stopped = true;
				note = `budget $${row.budget_usd} reached after $${spent.toFixed(6)}; remaining tasks for this row were skipped`;
			}
			const ledgerRow: BenchLedgerRow = {
				run_id: runId,
				task_id: task.id,
				config_id: row.id,
				telemetry_task_id: attempt.telemetry_task_id,
				session_id: attempt.session_id,
				source: task.source,
				budget_usd: row.budget_usd,
				reported_success: record.result.success,
				adjudication,
				adapter,
				note,
				started_at: startedAt,
				finished_at: now().toISOString(),
			};
			ledger.push(ledgerRow);
			appendFileSync(ledgerPath, `${JSON.stringify(ledgerRow)}\n`);
			// The attempt stays "in flight" until its row is committed: an interrupt
			// during adjudication would otherwise leave paid telemetry that no ledger
			// row joins, and the fold totals only joined attempts.
			inflight = null;
			workspace.cleanup();
		}
		}
	};

	try {
		await runRows();
	} finally {
		// A failed run must not leave its handlers behind: a later interrupt would
		// invoke an abandoned run's writer.
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}

	const report = writeReport();
	return { run_id: runId, dir, ledger_path: ledgerPath, telemetry_path: storePath, report_path: join(dir, "report.md"), report_json_path: join(dir, "report.json"), ledger, report };
}

/** Read a finished run's ledger back. Used by the reports and by the recompute negative control. */
export function readLedger(path: string): BenchLedgerRow[] {
	if (!existsSync(path)) throw new BenchError(`ledger ${path} does not exist`, "usage");
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line: string) => line.trim().length > 0)
		.map((line: string) => JSON.parse(line) as BenchLedgerRow);
}
