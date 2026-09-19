/**
 * RTK integration (PRD-019): optional, reversible tool-output reduction and the
 * measurement that alone can promote it to default. `src/index.ts` re-exports this
 * barrel with one line.
 */
export {
	appendRtkCall,
	reduceToolOutput,
	rtkCallsOf,
	RTK_CALLS_FIELD,
	spawnReducerProcess,
} from "./reducer.js";
export type {
	ReduceOptions,
	ReductionResult,
	RtkCallRecord,
	RtkDecidedBy,
	RtkDecision,
	RtkSpawn,
	RtkSpawnResult,
	RtkToolOutputInput,
	RtkUnavailable,
} from "./reducer.js";
export {
	armOf,
	classifyKind,
	decideReduction,
	looksStructured,
	outputClassOf,
	REDUCIBLE_KINDS,
	RTK_DEFAULTS,
	RTK_MODES,
	rtkConfigOf,
} from "./policy.js";
export type { OutputClass, RuleDecision, RtkArm, RtkConfig, RtkMode, RtkToolKind } from "./policy.js";
export {
	registerRtkSite,
	RTK_POLICY_OPTIONS,
	RTK_POLICY_QUESTION_ID,
	RTK_SITE_ID,
	rtkPolicyQuestion,
	rtkPolicyState,
	ruleChoiceOf,
} from "./site.js";
export type { RtkPolicyChoice, RtkPolicyState } from "./site.js";
export {
	readRtkMeasurement,
	resolveRtkDefault,
	RTK_MEASUREMENT_ENV,
	RTK_MEASUREMENT_PATH_DEFAULT,
	rtkMeasurementPath,
	rtkModeOf,
	verdictFromArms,
	writeRtkMeasurement,
} from "./measurement.js";
export type { RtkArmMetrics, RtkArmOutcome, RtkMeasurement, RtkModeOptions, RtkVerdict } from "./measurement.js";
export {
	aggregateArmMetrics,
	loadShellHeavyFixtures,
	runRtkAb,
	SHELL_HEAVY_FIXTURE_PATH,
	SHELL_HEAVY_FIXTURES,
	solveRateOf,
} from "./ab.js";
export type { RtkAbOptions, RtkAbResult, RtkFixtureTask, RtkTaskExecutor, RtkTaskRun } from "./ab.js";
