/**
 * Independent completion adjudication (PRD-021 Phase 3, ROADMAP §53).
 *
 * §53 defines false completion rate against an *independent* evaluation. Reusing
 * `src/proof/` — LeanPi's own gate — would make the metric identically zero by
 * construction, so this module deliberately imports nothing from it and nothing
 * from it is reachable from here.
 *
 * Two adjudicators, in this order:
 *
 * 1. the held-out golden: `git checkout <fix_commit> -- <files>` in the sealed
 *    workspace, then the task's own acceptance command; exit 0 is `complete`.
 *    The runner never places these files in the workspace during the attempt, so
 *    the check is genuinely held out rather than a restatement of the prompt;
 * 2. the held-out rubric: one model call carrying the task statement and the
 *    final diff only — no proof packet, no evidence store, no reviewer
 *    transcript — on a model distinct from the attempt's reviewer. The transport
 *    is the caller's (`rubricJudge`); with none, the verdict is `error` naming
 *    the missing client, never a fabricated pass.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { LeanPiConfig } from "../core/types.js";
import { resolveRole } from "../core/roles.js";
import { BenchError, type BenchAdjudication, type BenchAttempt, type BenchTask } from "./types.js";

/** The rubric's committed text (Phase 3's `bench/rubric.md`). */
export const RUBRIC_PATH_DEFAULT = "bench/rubric.md";
/** Longest diff handed to the rubric judge, in bytes; a bigger diff is truncated with a marker. */
export const RUBRIC_DIFF_MAX_BYTES = 60_000;
/** Per-adjudication ceiling in ms; the config's `bench.goldenTimeoutMs` overrides it. */
export const GOLDEN_TIMEOUT_MS_DEFAULT = 600_000;

/** What the rubric judge receives: the task statement and the final diff, nothing else. */
export interface RubricInput {
	task_id: string;
	prompt: string;
	/** `git diff` of the attempt's edits against its start revision. */
	diff: string;
	/** Files the attempt added that git does not track yet. */
	untracked: string[];
	/** The committed rubric text. */
	rubric: string;
}

export interface RubricVerdict {
	complete: boolean;
	reason: string;
}

/** The model call. Injected: the bench lane owns the rubric, not the model transport. */
export type RubricJudge = (input: RubricInput) => Promise<RubricVerdict>;

export interface AdjudicateOptions {
	/** Package root, for the rubric file. */
	base?: string;
	config?: LeanPiConfig | null;
	/** The model call for `golden.kind: none` tasks. */
	rubricJudge?: RubricJudge;
	/** The attempt's reviewer model id, copied from its §52 record for the independence record. */
	reviewer_model?: string | null;
	/** The role the rubric judge runs on; must resolve to a model distinct from the reviewer's. */
	rubricRole?: "strong" | "specialist";
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

function benchSetting(config: LeanPiConfig | null | undefined, key: string): unknown {
	// The `bench:` block is parsed by PRD-001; PRD-021 reads its own keys out of the
	// loaded config structurally and defaults each one, so this PRD adds no key to
	// `src/core/config.ts`.
	return (config?.bench as unknown as Record<string, unknown> | undefined)?.[key];
}

function timeoutOf(config: LeanPiConfig | null | undefined, override?: number): number {
	if (override !== undefined) return override;
	const declared = benchSetting(config, "goldenTimeoutMs");
	return typeof declared === "number" && declared > 0 ? declared : GOLDEN_TIMEOUT_MS_DEFAULT;
}

/** `git` output for one command, or null when git could not answer. */
function git(workspace: string, args: string[]): string | null {
	const result = spawnSync("git", ["-C", workspace, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	if (result.error || result.status !== 0) return null;
	return result.stdout ?? "";
}

/** The attempt's edits: the tracked diff plus the files it created. */
export function finalDiff(workspace: string): { diff: string; untracked: string[] } {
	const untracked = (git(workspace, ["status", "--porcelain"]) ?? "")
		.split("\n")
		.filter((line) => line.startsWith("?? "))
		.map((line) => line.slice(3).trim())
		.filter((path) => path.length > 0);
	return { diff: git(workspace, ["diff", "HEAD"]) ?? "", untracked };
}

/**
 * Run the held-out golden. The fix commit's test files are checked out into the
 * *sealed* workspace and the command runs there: exit 0 is `complete`, anything
 * else — including a checkout or spawn failure — is `incomplete`, and only a
 * missing repository is an `error`.
 */
export function runGolden(task: BenchTask, workspace: string, options: AdjudicateOptions = {}): BenchAdjudication {
	const golden = task.golden;
	const adjudicator = golden.command;
	const fail = (reason: string): BenchAdjudication => ({
		verdict: "error",
		kind: "upstream-test",
		adjudicator,
		reason,
		rubric_model: null,
		reviewer_model: options.reviewer_model ?? null,
	});
	if (task.source.fix_commit !== null && golden.files.length > 0) {
		const checkout = spawnSync("git", ["-C", workspace, "checkout", task.source.fix_commit, "--", ...golden.files], { encoding: "utf8" });
		if (checkout.status !== 0) {
			if (checkout.error) return fail(`the held-out golden could not be checked out: ${checkout.error.message}`);
			const stderr = (checkout.stderr ?? "").trim().split("\n").slice(0, 3).join(" ");
			return fail(`git checkout ${task.source.fix_commit} -- ${golden.files.join(" ")} failed: ${stderr}`);
		}
	}
	const result = spawnSync("/bin/sh", ["-c", golden.command], {
		cwd: workspace,
		encoding: "utf8",
		timeout: timeoutOf(options.config, options.timeoutMs),
		maxBuffer: 32 * 1024 * 1024,
		env: options.env ?? process.env,
	});
	if (result.error) return fail(`the golden could not run: ${result.error.message}`);
	const tail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
		.trim()
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.slice(-3)
		.join(" ");
	return {
		verdict: result.status === 0 ? "complete" : "incomplete",
		kind: "upstream-test",
		adjudicator,
		reason: result.status === 0 ? null : `exit ${result.status ?? "signal"}: ${tail || "no diagnostic"}`.slice(0, 400),
		rubric_model: null,
		reviewer_model: options.reviewer_model ?? null,
	};
}

/**
 * One rubric judgement. The judge model is resolved from the configuration and
 * must differ from the attempt's reviewer: a judge that *is* the reviewer is a
 * self-comparison, which §53's metric exists to avoid.
 */
export async function runRubric(task: BenchTask, workspace: string, options: AdjudicateOptions = {}): Promise<BenchAdjudication> {
	const base = options.base ?? process.cwd();
	const config = options.config ?? null;
	const role = options.rubricRole ?? "strong";
	let rubricModel: string | null = null;
	if (config) {
		try {
			rubricModel = resolveRole(config, role).model;
		} catch {
			rubricModel = null;
		}
	}
	const adjudicator = `rubric:${rubricModel ?? "unresolved"}`;
	const refuse = (reason: string): BenchAdjudication => ({
		verdict: "error",
		kind: "rubric",
		adjudicator,
		reason,
		rubric_model: rubricModel,
		reviewer_model: options.reviewer_model ?? null,
	});
	if (rubricModel !== null && options.reviewer_model != null && rubricModel === options.reviewer_model) {
		return refuse(`the rubric role "${role}" resolves to ${rubricModel}, the same model this attempt's reviewer used: adjudication would be a self-comparison`);
	}
	const declared = benchSetting(config, "rubricFile");
	const rubricPath = typeof declared === "string" && declared.length > 0 ? declared : RUBRIC_PATH_DEFAULT;
	const path = isAbsolute(rubricPath) ? rubricPath : join(base, rubricPath);
	if (!existsSync(path)) return refuse(`the rubric file ${path} is missing`);
	if (!options.rubricJudge) {
		return refuse("no rubric judge is configured: the bench lane owns the rubric, the caller supplies the model transport");
	}
	const { diff, untracked } = finalDiff(workspace);
	let verdict: RubricVerdict;
	try {
		verdict = await options.rubricJudge({
			task_id: task.id,
			prompt: task.prompt,
			diff: diff.length <= RUBRIC_DIFF_MAX_BYTES ? diff : `${diff.slice(0, RUBRIC_DIFF_MAX_BYTES)}\n… [truncated: ${diff.length - RUBRIC_DIFF_MAX_BYTES} more bytes]`,
			untracked,
			rubric: readFileSync(path, "utf8"),
		});
	} catch (error) {
		return refuse(`the rubric judge failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	return {
		verdict: verdict.complete ? "complete" : "incomplete",
		kind: "rubric",
		adjudicator,
		reason: verdict.reason,
		rubric_model: rubricModel,
		reviewer_model: options.reviewer_model ?? null,
	};
}

/** Adjudicate one sealed attempt with whichever adjudicator the task declares. */
export async function adjudicateAttempt(attempt: BenchAttempt, options: AdjudicateOptions = {}): Promise<BenchAdjudication> {
	if (attempt.task.golden.kind === "none") return runRubric(attempt.task, attempt.workspace, options);
	if (attempt.task.golden.command.length === 0) {
		throw new BenchError(`task "${attempt.task.id}" declares no golden command and no rubric fallback`, "rubric");
	}
	return runGolden(attempt.task, attempt.workspace, options);
}
