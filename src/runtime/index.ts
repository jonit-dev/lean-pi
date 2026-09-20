/**
 * The runtime verification and workspace-isolation lane (PRD-022).
 *
 * `registerRuntimeVerifiers()` is the one wiring step: it registers the four
 * kinds PRD-009's `VERIFIER_KINDS` already declares through that module's only
 * registration point, so `runtime_smoke`, `cli_invocation`, `browser_test` and
 * `screenshot_compare` are real entries in the verifier map rather than a
 * parallel mechanism. Registration is explicit and never a side effect of
 * importing this module: a process that has not called it reports `not_run` for
 * those kinds, which is what makes "the browser verifier is unregistered" an
 * observable state instead of a claim.
 *
 * The other half is `runIsolated`: a bounded execution in its own git worktree,
 * with a patch keyed by run id and a cleanup that refuses to destroy what it
 * cannot account for.
 */
import { registerVerifier } from "../verify/descriptors.js";
import { browserTestVerifier } from "./browser.js";
import { cliInvocationVerifier } from "./cli.js";
import { screenshotCompareVerifier } from "./screenshot.js";
import { runtimeSmokeVerifier } from "./smoke.js";

/** Register all four runtime verifiers into PRD-009's verifier map. Idempotent. */
export function registerRuntimeVerifiers(): void {
	registerVerifier("runtime_smoke", runtimeSmokeVerifier());
	registerVerifier("cli_invocation", cliInvocationVerifier());
	registerVerifier("browser_test", browserTestVerifier());
	registerVerifier("screenshot_compare", screenshotCompareVerifier());
}

export { browserFacility, browserTestVerifier, setBrowserFacility } from "./browser.js";
export type { BrowserFacility, BrowserOpenOptions, BrowserQuery, BrowserTab } from "./browser.js";
export { cliInvocationVerifier } from "./cli.js";
export {
	bindRuntimePlan,
	currentRuntimePlan,
	DEFAULT_DEVICE_SCALE_FACTOR,
	DEFAULT_VIEWPORT,
	EMPTY_RUNTIME_PLAN,
	RUNTIME_VERIFIER_KINDS,
	runtimePlanOf,
} from "./plan.js";
export type { BrowserPlan, CliExpectation, CliPlan, ReadinessPlan, RuntimePlan, ScreenshotPlan, SmokePlan } from "./plan.js";
export { selectRuntimeVerifiers } from "./planner.js";
export type { RuntimeSelectionOptions, RuntimeVerifierKind } from "./planner.js";
export { ensureGitIgnored } from "./ignore.js";
export { decodePng, encodePng, PngError, pixelDiff } from "./png.js";
export type { DecodedPng, EncodePngOptions, PixelDiff, PixelDiffOptions } from "./png.js";
export { startProcess } from "./proc.js";
export type { ProcessExit, ReadinessOutcome, ReadinessSignal, StartedProcess, StartProcessOptions } from "./proc.js";
export { screenshotCompareVerifier } from "./screenshot.js";
export { runtimeSmokeVerifier } from "./smoke.js";
export {
	applyPatch,
	cleanup,
	ensureRunRootIgnored,
	PatchAlreadyAppliedError,
	pruneOrphans,
	runIsolated,
	surfacePatch,
	worktreePath,
	worktreePermissionPrompt,
	worktreePermissionRequest,
	worktreeRoot,
	worktreeRootOf,
	WorktreePermissionError,
} from "./worktree.js";
export type {
	CleanupOptions,
	CleanupResult,
	OrphanReclamation,
	UntrackedFile,
	WorktreePatch,
	WorktreePermissionRequest,
	WorktreeRun,
	WorktreeRunOptions,
} from "./worktree.js";
