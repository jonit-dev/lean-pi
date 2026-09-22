/**
 * Cost telemetry (PRD-015, FR-149): one §52 record per run, its store, its
 * aggregates and the `/cost` surface. `src/index.ts` re-exports this module.
 */
export {
	aggregateRuns,
	aggregateTelemetry,
	type JevTotals,
	type SiteJevTotals,
	type TelemetryAggregate,
} from "./aggregate.js";
export {
	billedRefs,
	billingOf,
	callOfInvocation,
	callsFromMessages,
	createRunCollector,
	feedInvocation,
	projectJevDecision,
	type BackendCall,
	type CallUsage,
	type JevDecisionInput,
	type RunCollector,
} from "./collect.js";
export {
	registerCostCommand,
	renderCostReport,
	renderEffectiveCostPerSuccess,
	renderRun,
	type CostCommandDeps,
} from "./cost.js";
export { emitRunTelemetry, failedRunResult, runTurnWithTelemetry, type EmitOptions, type RunVerdict, type TurnTelemetryOptions } from "./emit.js";
export { priceCall, priceQuota, priceRun, ratesFor, resolveCostConfig, round6, TELEMETRY_PATH_DEFAULT, type CostConfig, type ModelRate } from "./pricing.js";
export type {
	CallRow,
	CallTotals,
	JevAnswer,
	JevDecisionRow,
	RouteCostBlock,
	RouteDescriptor,
	RunCapabilities,
	RunCost,
	RunExecution,
	RunResult,
	RunTelemetry,
	RunUsage,
} from "./record.js";
export { appendRun, readRuns, telemetryPath, type RunFilter } from "./store.js";
