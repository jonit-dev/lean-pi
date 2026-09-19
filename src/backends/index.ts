/**
 * Backend workers (PRD-008). `src/index.ts` re-exports this module; nothing
 * imports `src/index.ts` from here, so the package entry stays a leaf.
 */
export {
	HARNESS_DESCRIPTORS,
	HARNESS_VENDORS,
	isHarnessVendor,
	runHarness,
	spawnProcess,
	validateJsonSchema,
	type HarnessArgvContext,
	type HarnessDescriptor,
	type HarnessSpawn,
	type HarnessSpawnRequest,
	type HarnessSpawnResult,
	type HarnessVendor,
	type ParsedHarnessEnvelope,
	type RunHarnessDeps,
} from "./harness.js";
export { DEFAULT_NATIVE_BUDGET, runNative, type RunNativeDeps } from "./native.js";
export {
	BackendRegistry,
	billingOf,
	parseBackendPool,
	runWorkerTurn,
	type BackendRegistryOptions,
	type Cooldown,
	type RegisteredBackend,
	type RunWorkerTurnOptions,
} from "./registry.js";
export {
	billingTotals,
	changedFilesSince,
	isWorkerFailure,
	modelFor,
	parseMaybeJson,
	snapshotFiles,
	type BackendInvocation,
	type Billing,
	type BillingTotals,
	type FileSnapshot,
	type RoleModelSource,
	type WorkerAttempt,
	type WorkerFailure,
	type WorkerFailureKind,
	type WorkerOutcome,
	type WorkerResult,
	type WorkerTaskPacket,
	type WorkerTurnOutcome,
} from "./worker.js";
