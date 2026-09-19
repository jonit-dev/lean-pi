/**
 * Helpers for the PRD-021 suite: a local suite, a scripted attempt, and a real
 * §52 store.
 *
 * Nothing here re-implements the harness: the scripted attempt writes its record
 * through PRD-015's own `appendRun` into the *run's* store, which is the store
 * the runner and the metrics join read. Only the model call, the checkout and
 * the tool loop are fixtures — which is what "works offline" means for a bench
 * harness.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { loadConfig, type LeanPiConfig } from "../../src/index.js";
import type { ExecutionContract } from "../../src/compiler/contract.js";
import { appendRun, type CostConfig, type RunTelemetry } from "../../src/telemetry/index.js";
import { loadSuite, SEED_SUITE_DIR } from "../../src/bench/suite.js";
import type { BenchAttempt, BenchAttemptExecutor, BenchAttemptResult, BenchLedgerRow, BenchTask, BenchWorkspace, BenchWorkspacePreparer } from "../../src/bench/types.js";
import type { CliIo } from "../../src/bench/cli.js";

export function tempDir(prefix = "leanpi-bench-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export interface CapturedIo extends CliIo {
	text: string;
	errors: string;
}

export function capturingIo(): CapturedIo {
	const io: CapturedIo = {
		text: "",
		errors: "",
		write(text: string) {
			io.text += text;
		},
		error(text: string) {
			io.errors += text;
		},
	};
	return io;
}

const FIXTURE_COMMIT = "0".repeat(40);

/**
 * A configuration with every role bound to a local backend and no credential.
 * `rankingFile` may point at a missing path to prove the capability column
 * degrades to `index: unavailable` instead of aborting the run.
 */
export function fixtureConfig(cwd: string, options: { rankingFile?: string | null; jevMode?: LeanPiConfig["jev"]["mode"] } = {}): LeanPiConfig {
	return loadConfig(
		cwd,
		{
			backends: {
				local: { type: "native", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "sk-stub", cost: { input: 1, output: 2, cacheRead: 0.1 } },
			},
			models: {
				quick: { backend: "local", model: "qwen3-coder-480b-a35b" },
				balanced: { backend: "local", model: "qwen3-coder-480b-a35b" },
				strong: { backend: "local", model: "claude-sonnet-4-5" },
				specialist: { backend: "local", model: "claude-sonnet-4-5" },
				review_quick: { backend: "local", model: "gemini-2.5-flash" },
				review_strong: { backend: "local", model: "gpt-5" },
			},
			capability: { stalenessDays: 3650, ...(options.rankingFile === undefined ? {} : { rankingFile: options.rankingFile }) },
			jev: { mode: options.jevMode ?? "disabled", apiKey: null, endpoint: "http://127.0.0.1:1/v1/systemone", model: "jev-stub" },
		},
		{ HOME: cwd, XDG_CONFIG_HOME: cwd },
	);
}

/** One task.yaml, written the way the suite reader expects to find it. */
function writeTask(suiteDir: string, task: { id: string; prompt: string; categories: string[]; golden: Record<string, unknown>; repo?: string }): void {
	const dir = join(suiteDir, task.id);
	mkdirSync(dir, { recursive: true });
	const body = {
		id: task.id,
		prompt: task.prompt,
		source: { repo: task.repo ?? "fixture://local", commit: FIXTURE_COMMIT, fix_commit: null, pinned_via: "fixture" },
		categories: task.categories,
		setup: [],
		golden: task.golden,
		notes: "fixture",
	};
	writeFileSync(join(dir, "task.yaml"), stringifyYaml(body));
}

/** A three-task suite: one golden that passes, one that fails, one rubric task. */
export function fixtureSuite(base: string): string {
	const suiteDir = join(base, "suite");
	writeTask(suiteDir, { id: "golden-passes", prompt: "write the marker file", categories: ["mechanical-edits"], golden: { kind: "upstream-test", files: [], command: "test -f bench-done-marker", validated_at: null } });
	writeTask(suiteDir, { id: "golden-fails", prompt: "write the other marker file", categories: ["localized-bugs"], golden: { kind: "upstream-test", files: [], command: "test -f never-written-marker", validated_at: null } });
	writeTask(suiteDir, { id: "rubric-task", prompt: "rename a helper", categories: ["refactoring"], golden: { kind: "none" } });
	return suiteDir;
}

/**
 * The *real* seed suite, restated with local acceptance commands: same ten task
 * ids, prompts and §55 categories, with the upstream clone and its toolchain
 * replaced by a local marker file. This is what lets the seed inventory run
 * end-to-end offline.
 */
export function localiseSeedSuite(cwd: string, target: string, plan: (task: BenchTask) => { complete: boolean; kind?: "upstream-test" | "none" }): string {
	const suite = loadSuite(SEED_SUITE_DIR, cwd);
	for (const task of suite.tasks) {
		const decision = plan(task);
		writeTask(target, {
			id: task.id,
			prompt: task.prompt,
			categories: task.categories,
			golden: decision.kind === "none"
				? { kind: "none" }
				: { kind: "upstream-test", files: [], command: `test -f ${decision.complete ? "bench-done-marker" : "never-written-marker"}`, validated_at: null },
		});
	}
	return target;
}

/** A workspace seam: a real (`git init`-ed) throwaway directory per attempt. */
export function preparedWorkspaces(root: string): { prepare: BenchWorkspacePreparer; prepared: string[]; cleaned: string[] } {
	const prepared: string[] = [];
	const cleaned: string[] = [];
	return {
		prepared,
		cleaned,
		prepare: async (task: BenchTask): Promise<BenchWorkspace> => {
			void task;
			const dir = mkdtempSync(join(root, "workspace-"));
			execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
			prepared.push(dir);
			return {
				dir,
				cleanup() {
					cleaned.push(dir);
				},
			};
		},
	};
}

export interface StubPlan {
	/** The attempt's own claim, per (task id, config id). */
	reported_success: (task: BenchTask, configId: string) => boolean;
	/** Whether the attempt leaves the workspace in a state the golden accepts. */
	completes: (task: BenchTask, configId: string) => boolean;
	/** Effective cost of the attempt; the two configurations must differ for the A/B to be real. */
	cost: (task: BenchTask, configId: string) => number;
	wall_ms?: (task: BenchTask, configId: string) => number;
	/** Extra §52 fields, for the JEV-shaped fixtures. */
	patch?: (record: RunTelemetry, attempt: BenchAttempt) => void;
}

export interface StubExecutor extends BenchAttemptExecutor {
	/** Every §52 record the scripted attempts wrote, in order. */
	records: RunTelemetry[];
}

/**
 * The scripted attempt: it edits the workspace, then writes the §52 record the
 * way PRD-015's writer would — through `appendRun` into the run's store, with
 * `cost.telemetry_path` pointing at it.
 */
export function stubExecutor(plan: StubPlan, reviewerModel = "gemini-2.5-flash"): StubExecutor {
	const records: RunTelemetry[] = [];
	const executor: StubExecutor = Object.assign(
		async (attempt: BenchAttempt): Promise<BenchAttemptResult> => {
			if (plan.completes(attempt.task, attempt.config.id)) writeFileSync(join(attempt.workspace, "bench-done-marker"), "done\n");
			const wallMs = plan.wall_ms?.(attempt.task, attempt.config.id) ?? 1000;
			const effective = plan.cost(attempt.task, attempt.config.id);
			const record: RunTelemetry = {
				task_id: attempt.telemetry_task_id,
				session_id: attempt.session_id,
				route: { complexity: "MEDIUM", executor_class: "balanced", reviewer_class: "review_quick", reasoning: "medium" },
				prd_used: null,
				executor_backend: "local",
				executor_model: attempt.config.executor_model,
				reviewer_backend: "local",
				reviewer_model: reviewerModel,
				usage: {
					input_tokens: 10_000,
					cached_input_tokens: 0,
					output_tokens: 1_000,
					reasoning_tokens: 0,
					jev_tokens: 0,
					local_gpu_seconds: 0,
					external_harness_calls: 0,
					subscription_usage: attempt.config.subscription ? 1 : 0,
				},
				cost: { api_usd: effective, jev_usd: 0, estimated_quota_cost: 0, effective_cost: effective },
				execution: { wall_ms: wallMs, tool_calls: 3, file_reads: 2, repeated_reads: 0, retries: 0, escalations: 0, compactions: 0 },
				result: { verification: "pass", proof_gate: "PASS", reviewer: "PASS", success: plan.reported_success(attempt.task, attempt.config.id) },
				capabilities: { skills_disclosed: [], skills_used: [], mcps_disclosed: [], mcps_used: [] },
				jev_decisions: [],
				calls: [],
			};
			plan.patch?.(record, attempt);
			appendRun(attempt.workspace, record, { telemetry_path: attempt.telemetry_path } as CostConfig);
			records.push(record);
			return { extensions: [], operator: "scripted", subscription_usage: 0, note: null };
		},
		{ records },
	);
	return executor;
}

/** A scripted judge for the rubric path; the transport is the caller's, which is the point. */
export function scriptedJudge(complete: boolean, reason = "the diff renames the helper and leaves no caller dangling") {
	return async (input: { task_id: string; prompt: string; diff: string }): Promise<{ complete: boolean; reason: string }> => {
		void input;
		return { complete, reason };
	};
}

/**
 * A one-row configuration directory. `budget_usd` is what the runner's per-attempt
 * cap reads, and `adapter` picks which of the three real adapters the row runs.
 */
export function fixtureConfigRow(base: string, row: { id: string; adapter?: "leanpi" | "stock-pi" | "external"; vendor?: "claude" | "codex"; executor_model?: string; budget_usd?: number }): string {
	const dir = join(base, "configs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${row.id}.yaml`),
		stringifyYaml({
			id: row.id,
			label: row.id,
			adapter: row.adapter ?? "leanpi",
			...(row.vendor ? { vendor: row.vendor } : {}),
			jev: "disabled",
			executor_model: row.executor_model ?? "qwen3-coder-480b-a35b",
			features: [],
			budget_usd: row.budget_usd ?? 0,
		}),
	);
	return dir;
}

/** The §8 contract a lane hands the turn, trimmed to the fields telemetry reads. */
export function minimalContract(): ExecutionContract {
	return {
		task: {
			type: "bugfix",
			prd_required: false,
			planning_decision: "DIRECT_EXECUTION",
			execution_complexity: "LOW",
			review_risk: "R0",
			required_capability: { min_coding_index: 0 },
			user_request: "bench fixture",
		},
		routing: { executor_class: "quick", executor_backend: "unresolved", reviewer_class: "none" },
		reasoning: { effort: "low" },
		capabilities: { skills: [], mcps: [], lsp: false, rtk: "off" },
		context: { strategy: "targeted", budget_tokens: 4000 },
		verification: { required: ["git_status"] },
		limits: { execution_attempts: 1, semantic_review_rounds: 0 },
	} as unknown as ExecutionContract;
}

/** A stand-in for Pi's own session, so the stock-Pi adapter's plumbing is exercised without a model. */
export function fakePiSession(usage: { input: number; output: number }, workspace?: string) {
	return {
		messages: [{ role: "assistant", usage: { input: usage.input, output: usage.output }, content: [] }],
		modelRuntime: {},
		async prompt() {
			if (workspace !== undefined) writeFileSync(join(workspace, "bench-done-marker"), "done\n");
			return undefined;
		},
	};
}

/** Write a ledger + store pair by hand, for the recompute and report folds. */
export function writeRunFixture(dir: string, rows: BenchLedgerRow[], telemetry: RunTelemetry[]): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "ledger.jsonl"), rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
	writeFileSync(join(dir, "telemetry.jsonl"), telemetry.map((record) => `${JSON.stringify(record)}\n`).join(""));
}

/** Append one §52 record to a store file directly. */
export function appendRecords(path: string, records: RunTelemetry[]): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
}
