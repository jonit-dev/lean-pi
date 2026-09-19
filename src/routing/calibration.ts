/**
 * Calibration and semantic retry classification (PRD-020 Phase 4, ROADMAP §60).
 *
 * Two small readers over PRD-015's telemetry store. Buckets are (role,
 * complexity, backend) over completed runs: the retry rate is the share of runs
 * that needed more than one attempt, and the remaining values are the bucket's
 * p50s, which is what a prediction should be centred on. Below the configured
 * sample count the §14 matrix default is returned and the reason is carried out
 * to the run record instead of being silently baked in.
 *
 * The retry *loop and its ceilings* are PRD-007's; this module only says what a
 * repeated failure means for the next route.
 */
import type { ExecutionComplexity } from "../compiler/contract.js";
import type { RunTelemetry } from "../telemetry/record.js";
import type { EscalationCategory } from "./defaults.js";

export interface BucketKey {
	role: string;
	complexity: ExecutionComplexity;
	backend: string;
}

export type CalibrationState = "telemetry" | "insufficient-history";

export interface BucketStats {
	key: BucketKey;
	/** Completed runs observed in this bucket. */
	runs: number;
	retry_rate: number;
	latency_p50_ms: number;
	local_gpu_seconds: number;
	input_tokens: number;
	output_tokens: number;
	calibration: CalibrationState;
}

export interface CalibrationInput {
	history: readonly RunTelemetry[];
	key: BucketKey;
	/** Completed runs a bucket needs before its observed values are used. */
	min_bucket_runs: number;
	/** The §14 matrix's rate, used as the fallback below the sample count. */
	matrix_retry_rate: number;
	fallback: { latency_ms: number; local_gpu_seconds: number; input_tokens: number; output_tokens: number };
}

/** Median of the defined values; `fallback` when the sample is empty. */
function p50(values: number[], fallback: number): number {
	if (values.length === 0) return fallback;
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[middle] as number;
	return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function inBucket(run: RunTelemetry, key: BucketKey): boolean {
	return run.route.complexity === key.complexity && run.route.executor_class === key.role && run.executor_backend === key.backend;
}

/**
 * The bucket's observed values, or the matrix default with the reason attached.
 * `retries > 0` is the store's record of "this run needed more than one
 * attempt", so the derived rate is an outcome, not a configured number.
 */
export function bucketStats(input: CalibrationInput): BucketStats {
	const runs = input.history.filter((run) => inBucket(run, input.key));
	const base: BucketStats = {
		key: input.key,
		runs: runs.length,
		retry_rate: input.matrix_retry_rate,
		latency_p50_ms: input.fallback.latency_ms,
		local_gpu_seconds: input.fallback.local_gpu_seconds,
		input_tokens: input.fallback.input_tokens,
		output_tokens: input.fallback.output_tokens,
		calibration: "insufficient-history",
	};
	if (runs.length < input.min_bucket_runs) return base;
	const retried = runs.filter((run) => run.execution.retries > 0).length;
	return {
		...base,
		retry_rate: retried / runs.length,
		latency_p50_ms: p50(
			runs.filter((run) => run.execution.wall_ms > 0).map((run) => run.execution.wall_ms),
			input.fallback.latency_ms,
		),
		local_gpu_seconds: p50(
			runs.filter((run) => run.usage.local_gpu_seconds > 0).map((run) => run.usage.local_gpu_seconds),
			input.fallback.local_gpu_seconds,
		),
		input_tokens: p50(
			runs.filter((run) => run.usage.input_tokens + run.usage.cached_input_tokens > 0).map((run) => run.usage.input_tokens + run.usage.cached_input_tokens),
			input.fallback.input_tokens,
		),
		output_tokens: p50(
			runs.filter((run) => run.usage.output_tokens > 0).map((run) => run.usage.output_tokens),
			input.fallback.output_tokens,
		),
		calibration: "telemetry",
	};
}

export type FailureClass = "repeated-signature" | "known-signature" | "new-signature";

export interface AttemptFailure {
	/** PRD-008's `WorkerFailureKind`, when the failure came from a backend. */
	failure?: string;
	/** The verification command or tool that failed. */
	command?: string;
	exitCode?: number | null;
	/** The first failing assertion's text, if any. */
	assertion?: string;
	/** The failing file, test id or line. */
	location?: string;
}

export interface FailureVerdict {
	signature: string;
	class: FailureClass;
	/** §34's category the next dispatch should act on; `null` leaves the route alone. */
	escalation: EscalationCategory | null;
	reason: string;
}

/** Deterministic normalization: lowercase, single spaces, first line of each part. */
export function failureSignature(failure: AttemptFailure): string {
	const parts = [failure.failure, failure.command, failure.exitCode === undefined || failure.exitCode === null ? undefined : String(failure.exitCode), failure.assertion, failure.location];
	return parts
		.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
		.map((part) => part.split("\n")[0]!.trim().toLowerCase().replace(/\s+/g, " "))
		.join("|");
}

/** The failure signatures a store already contains: one coarse signature per failed run. */
export function historicalSignatures(history: readonly RunTelemetry[]): string[] {
	return history
		.filter((run) => !run.result.success)
		.map((run) =>
			failureSignature({
				failure: run.result.proof_gate,
				command: run.result.verification,
				location: run.executor_backend ?? undefined,
			}),
		);
}

/**
 * A signature that repeats an earlier attempt of the same run is the one case
 * that changes the route: re-dispatching the identical configuration is what the
 * semantic classification exists to prevent. A signature the store has seen
 * before, or one that is genuinely new, leaves the ordinary scorer in charge —
 * §34's escalation is earned by repetition, not by failure.
 */
export function classifyFailure(failure: AttemptFailure, priorAttempts: readonly AttemptFailure[], historical: readonly string[] = []): FailureVerdict {
	const signature = failureSignature(failure);
	const prior = priorAttempts.map(failureSignature);
	if (signature.length > 0 && prior.includes(signature)) {
		return { signature, class: "repeated-signature", escalation: "SWITCH_BACKEND", reason: `attempt failed with a signature already seen in this run: ${signature}` };
	}
	if (signature.length > 0 && historical.includes(signature)) {
		return { signature, class: "known-signature", escalation: null, reason: `signature seen in the telemetry store: ${signature}` };
	}
	return { signature, class: "new-signature", escalation: null, reason: signature.length > 0 ? `new failure signature: ${signature}` : "no failure signature" };
}
