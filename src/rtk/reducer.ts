/**
 * `reduceToolOutput()` — RTK as one optional reducer call at PRD-014's boundary (PRD-019, FR-110–113).
 *
 * Every large tool result already routes through the artifact store, so reduction
 * plugs in *there* rather than into each tool: one wiring point covers shell, test
 * runners, build output and any future tool, and FR-113's raw-retention guarantee
 * is the store's existing behavior rather than new bookkeeping.
 *
 * Order is load-bearing: the raw bytes, exit status and timestamp are persisted
 * first and the reduced summary always ends in the resulting `artifact://`
 * reference, so a reduction is reversible in every mode. Absence, non-zero exit,
 * timeout, empty or non-reducing output all degrade to the store's own text with
 * the reason recorded — RTK is never on a critical path and this function never
 * throws into the tool-call path (FR-111).
 *
 * `reduceToolOutput()` is a plain function, not a reducer interface: there is
 * exactly one implementation and speculative pluggability would be dead
 * flexibility.
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { ArtifactStore, CaptureInput, CompactRecord } from "../context/artifacts.js";
import type { LeanPiConfig } from "../core/types.js";
import type { JevClient } from "../jev/client.js";
import { accept } from "../jev/confidence.js";
import type { JevResult } from "../jev/types.js";
import { rtkModeOf } from "./measurement.js";
import { armOf, decideReduction, outputClassOf, rtkConfigOf, type OutputClass, type RtkArm, type RtkConfig, type RtkMode, type RtkRuleConfig } from "./policy.js";
import { registerRtkSite, RTK_POLICY_QUESTION_ID, RTK_SITE_ID, rtkPolicyQuestion, rtkPolicyState } from "./site.js";

/** Why a decided reduction did not happen; `null` when it did, or when none was attempted. */
export type RtkUnavailable = "spawn_failed" | "nonzero_exit" | "timeout" | "no_reduction" | "internal_error";

export type RtkDecision = "reduce" | "keep_raw" | "unavailable";

export type RtkDecidedBy = "mode" | "rule" | "site";

/** The per-tool-call record PRD-019 Phase 2 puts in `WorkingState` (see `appendRtkCall`). */
export interface RtkCallRecord {
	mode: RtkMode;
	/** The `experiment` arm this call ran under; `null` in the other modes. */
	arm: RtkArm | null;
	decision: RtkDecision;
	decided_by: RtkDecidedBy;
	/** True whenever the call entered the ambiguous band and the rule answered instead of the site. */
	fallback_used: boolean;
	unavailable: RtkUnavailable | null;
	bytes_in: number;
	bytes_out: number;
	duration_ms: number;
	artifact: string | null;
	kind: string;
	source_ref: string;
	started_at: string;
	reason: string;
}

export interface RtkSpawnResult {
	status: number | null;
	stdout: string;
	outcome: "ok" | "spawn_failed" | "timeout";
	error?: string;
}

/** The process seam: tests count invocations through it, the default spawns the configured binary. */
export type RtkSpawn = (command: string, args: string[], input: string, timeoutMs: number) => Promise<RtkSpawnResult>;

/**
 * Invoke the reducer over stdin/stdout with a timeout; every failure is a result, not a throw.
 * (`Promise.withResolvers` is ES2024 and outside this project's `lib: ES2023`.)
 */
export function spawnReducerProcess(command: string, args: string[], input: string, timeoutMs: number): Promise<RtkSpawnResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		const finish = (result: RtkSpawnResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		let child: ChildProcess;
		try {
			child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
		} catch (error) {
			resolve({ status: null, stdout: "", outcome: "spawn_failed", error: String(error) });
			return;
		}
		timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ status: null, stdout, outcome: "timeout", error: `no output within ${timeoutMs}ms` });
		}, timeoutMs);
		timer.unref?.();
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", (error) => finish({ status: null, stdout, outcome: "spawn_failed", error: error.message }));
		child.on("close", (status) => finish({ status, stdout, outcome: "ok" }));
		// A reducer that dies early turns the write into EPIPE; that is the `close` path's business.
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
	});
}

export interface ReduceOptions {
	store: ArtifactStore;
	/** Loaded config; absent means "documented defaults" — reduction stays available, mode stays measured. */
	config?: LeanPiConfig | null;
	/** Explicit mode override: the `experiment` arm harness and tests use it. */
	mode?: RtkMode;
	cwd?: string;
	/** Identifies the task for the `experiment` arm hash. */
	taskId?: string;
	/** The decision-site client; consulted only when `rtk.jev_policy` is enabled. */
	jev?: Pick<JevClient, "ask" | "fallbackCount"> & Partial<Pick<JevClient, "getMode">>;
	spawn?: RtkSpawn;
	now?: () => Date;
}

/** Same fields as PRD-014's `CaptureInput`, so the caller's existing call site is unchanged by the hook. */
export type RtkToolOutputInput = CaptureInput;

export interface ReductionResult {
	/** What the caller places in context: the store's text, or the reduced summary ending in the artifact ref. */
	text: string;
	record: RtkCallRecord;
	/** The store's record for the raw bytes, when they were persisted. */
	artifact: CompactRecord | null;
}

function bytesOf(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** `on` reduces everything above the floor; the mode, not the output class, is the decider. */
function floorDecision(output: OutputClass, config: RtkRuleConfig): { decision: "reduce" | "keep_raw"; reason: string } {
	return output.bytes >= config.min_bytes
		? { decision: "reduce", reason: `above the ${config.min_bytes}-byte floor with rtk: on` }
		: { decision: "keep_raw", reason: `below the ${config.min_bytes}-byte floor` };
}

/** The reduced summary §21 shows the executor; the reference is last so a truncated read still finds it. */
function renderReduced(kind: string, sourceRef: string, stored: CompactRecord, body: string): string {
	return [
		`[rtk ${kind}] ${sourceRef}`,
		`exit: ${stored.exitCode ?? "unknown"} · ${stored.timestamp} · ${stored.bytes} bytes → ${bytesOf(body)} bytes`,
		body,
		`[full output: ${stored.artifact}]`,
	].join("\n");
}

export async function reduceToolOutput(input: RtkToolOutputInput, options: ReduceOptions): Promise<ReductionResult> {
	const config = rtkConfigOf(options.config);
	// ponytail: the measurement report is re-read per tool call; memoize by path+mtime
	// only if a session ever makes thousands of calls.
	const mode = options.mode ?? rtkModeOf(options.config, { cwd: options.cwd });
	const now = options.now ?? (() => new Date());
	const startedAt = now().toISOString();
	const started = now().getTime();
	const output = outputClassOf(input.output, input.kind);
	// Raw bytes first, never after: the store's copy is what makes a reduction reversible (FR-113).
	const captured = options.store.capture(input);
	const textBytesOut = bytesOf(captured.text);

	const arm: RtkArm | null = mode === "experiment" ? armOf(options.taskId) : null;
	const effective: RtkMode = arm ?? mode;
	const base = {
		mode,
		arm,
		bytes_in: output.bytes,
		kind: output.kind,
		source_ref: input.sourceRef,
		started_at: startedAt,
		duration_ms: 0,
		artifact: captured.record?.artifact ?? null,
	};

	if (effective === "off") {
		return {
			text: captured.text,
			artifact: captured.record,
			record: {
				...base,
				decision: "keep_raw",
				decided_by: "mode",
				fallback_used: false,
				unavailable: null,
				bytes_out: textBytesOut,
				reason: arm ? "experiment arm off" : "rtk: off",
			},
		};
	}

	const rule = effective === "on" ? { ...floorDecision(output, config), ambiguous: false } : decideReduction(output, config);
	let decision: "reduce" | "keep_raw" = rule.decision;
	let decidedBy: RtkDecidedBy = effective === "on" ? "mode" : "rule";
	let reason = rule.reason;

	// The site is reached only inside the band, only when enabled, and only in the
	// modes whose decision is the rule's — `on` never asks.
	if (rule.ambiguous && effective !== "on") {
		const confidence = await consultSite(output, config, options);
		if (confidence !== null) {
			decision = "reduce";
			decidedBy = "site";
			reason = `site ${RTK_SITE_ID} answered reduce at confidence ${confidence.toFixed(2)}`;
		} else {
			reason = `${reason}; site did not decide`;
		}
	}
	const fallbackUsed = rule.ambiguous && decidedBy !== "site";

	if (decision === "keep_raw") {
		return {
			text: captured.text,
			artifact: captured.record,
			record: { ...base, decision, decided_by: decidedBy, fallback_used: fallbackUsed, unavailable: null, bytes_out: textBytesOut, reason },
		};
	}

	// A reduction needs an expandable reference; when PRD-014's threshold let the
	// bytes pass through, force the one store write here rather than duplicating it.
	const stored = captured.record?.artifact ? captured.record : options.store.capture({ ...input, always: true }).record;
	if (!stored || !stored.artifact) {
		return {
			text: captured.text,
			artifact: null,
			record: { ...base, decision: "unavailable", decided_by: decidedBy, fallback_used: fallbackUsed, unavailable: "internal_error", bytes_out: textBytesOut, reason: "the artifact store returned no reference" },
		};
	}

	const spawnReducer = options.spawn ?? spawnReducerProcess;
	let unavailable: RtkUnavailable | null = null;
	let failure = "";
	let body = "";
	try {
		const result = await spawnReducer(config.binary, config.args, input.output, config.timeout_ms);
		if (result.outcome !== "ok") unavailable = result.outcome;
		else if (result.status !== 0) unavailable = "nonzero_exit";
		else if (result.stdout.trim().length === 0 || bytesOf(result.stdout) >= output.bytes) unavailable = "no_reduction";
		else body = result.stdout.trimEnd();
		failure = result.error ?? (result.status === null ? "no exit status" : `exit ${result.status}`);
	} catch (error) {
		unavailable = "internal_error";
		failure = String(error);
	}
	const duration = now().getTime() - started;

	if (unavailable) {
		// Raw passthrough with the reason recorded: the session reports no error and
		// the executor sees what the store would have shown with no reducer at all.
		return {
			text: captured.text,
			artifact: stored,
			record: {
				...base,
				artifact: stored.artifact,
				decision: "unavailable",
				decided_by: decidedBy,
				fallback_used: fallbackUsed,
				unavailable: unavailable ?? "no_reduction",
				bytes_out: textBytesOut,
				duration_ms: duration,
				reason: `${config.binary}: ${failure || "no reduction"}`,
			},
		};
	}

	const text = renderReduced(output.kind, input.sourceRef, stored, body);
	return {
		text,
		artifact: stored,
		record: {
			...base,
			artifact: stored.artifact,
			decision: "reduce",
			decided_by: decidedBy,
			fallback_used: fallbackUsed,
			unavailable: null,
			bytes_out: bytesOf(text),
			duration_ms: duration,
			reason,
		},
	};
}

/** One `ask()` per call, never one per question (FR-011); every failure path returns no answer. */
async function consultSite(output: OutputClass, config: RtkConfig, options: ReduceOptions): Promise<number | null> {
	if (!config.jev_policy || !options.jev) return null;
	registerRtkSite();
	const client = options.jev;
	try {
		const before = client.fallbackCount();
		const results = await client.ask(RTK_SITE_ID, [rtkPolicyQuestion()], rtkPolicyState(output, config));
		if (client.fallbackCount() > before) return null;
		const answer: JevResult | undefined = results.find((result) => result.questionId === RTK_POLICY_QUESTION_ID);
		if (!answer || answer.kind !== "Choice" || answer.choice !== "reduce") return null;
		return accept(answer, "low") ? answer.confidence : null;
	} catch {
		return null;
	}
}

export const RTK_CALLS_FIELD = "rtk_calls";

/**
 * Append one call's record to a `WorkingState`-shaped object (Phase 2: records live
 * in PRD-014's working state, not in a new store). The field is added by the
 * integration pass; this helper keeps the read/write in one place either way.
 */
export function appendRtkCall<T extends object>(state: T, record: RtkCallRecord): T {
	const target = state as Record<string, unknown>;
	const existing = Array.isArray(target[RTK_CALLS_FIELD]) ? (target[RTK_CALLS_FIELD] as RtkCallRecord[]) : [];
	target[RTK_CALLS_FIELD] = [...existing, record];
	return state;
}

export function rtkCallsOf(state: unknown): RtkCallRecord[] {
	const calls = (state as Record<string, unknown> | null | undefined)?.[RTK_CALLS_FIELD];
	return Array.isArray(calls) ? (calls as RtkCallRecord[]) : [];
}
