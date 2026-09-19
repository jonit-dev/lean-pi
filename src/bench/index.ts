/**
 * The benchmark and evaluation harness (PRD-021).
 *
 * The harness owns the *matrix and the metrics*: which configurations run, how
 * each attempt is adjudicated independently of LeanPi's own gate, and what the
 * report says. It re-measures nothing — per-attempt cost, tokens and time come
 * from PRD-015's §52 telemetry records, and the external baselines are PRD-008's
 * workers rather than a second set of CLI drivers.
 *
 * `bench/cli.ts` is the entry point (`npm run bench`); everything here is
 * importable so the lane and its tests exercise the same code.
 */
export {
	attemptExecutorFor,
	configForRow,
	EXTERNAL_BASELINES_FLAG,
	externalAttempt,
	externalBaselinesEnabled,
	leanPiAttempt,
	stockPiAttempt,
	stockPiExtensions,
	vendorAvailable,
	vendorCommand,
	writeStockPiModels,
	type AdapterDeps,
	type BenchTurnSession,
	type ExternalAttemptOptions,
	type LeanPiAttemptOptions,
	type StockPiAttemptOptions,
} from "./adapters.js";
export {
	adjudicateAttempt,
	finalDiff,
	GOLDEN_TIMEOUT_MS_DEFAULT,
	RUBRIC_DIFF_MAX_BYTES,
	RUBRIC_PATH_DEFAULT,
	runGolden,
	runRubric,
	type AdjudicateOptions,
	type RubricInput,
	type RubricJudge,
	type RubricVerdict,
} from "./adjudicate.js";
export {
	main,
	listSuite,
	recompute,
	USAGE,
	type CliIo,
	type CliOptions,
} from "./cli.js";
export { leanPiSessionFactory, runArgv } from "./lane.js";
export {
	capabilityOf,
	foldReport,
	joinTelemetry,
	medianAndP95,
	renderReportMarkdown,
	REPORT_SCHEMA,
	SECTION4_TARGETS,
	type BenchReport,
	type CapabilityAnnotation,
	type ConfigMetrics,
	type FoldInput,
	type PairingRow,
} from "./metrics.js";
export { jevReport, renderJevReport, JEV_REPORT_SCHEMA, type JevReport, type RateRow, type SiteRow } from "./report/jev.js";
export { renderRtkReport, rtkReport, RTK_MEASUREMENT_FILENAME, RTK_REPORT_SCHEMA, type RtkArmReport, type RtkReport } from "./report/rtk.js";
export { adjudicationFor, readTelemetryDir, type TelemetrySource } from "./report/source.js";
export {
	cloneWorkspace,
	OUT_DIR_DEFAULT,
	readLedger,
	runBench,
	type BenchRun,
	type BenchRunOptions,
} from "./runner.js";
export {
	benchPath,
	CONFIG_DIR,
	coverageOf,
	loadConfigRows,
	loadSuite,
	parseConfigRow,
	parseTask,
	renderSuiteList,
	selectConfigRows,
	SEED_SUITE_DIR,
	SUITE_CATEGORIES,
	SUITE_TARGET,
	type CoverageRow,
} from "./suite.js";
export {
	BenchError,
	type BenchAdjudication,
	type BenchAdapterKind,
	type BenchAttempt,
	type BenchAttemptExecutor,
	type BenchAttemptResult,
	type BenchConfigRow,
	type BenchGolden,
	type BenchLedgerRow,
	type BenchTask,
	type BenchTaskSource,
	type BenchWorkspace,
	type BenchWorkspacePreparer,
} from "./types.js";
