/**
 * PRD-021 adapter and workspace plumbing — the parts the other specs stub out.
 *
 * These are the real code paths: a real `git clone` + detached checkout of a
 * pinned revision, the per-attempt budget cap, and the LeanPi adapter's turn.
 * The LeanPi session is the injected seam (a real boot needs a model); the lane
 * that hands the turn its contract and PRD-015's record writer are the
 * production ones.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT } from "../../src/index.js";
import { leanPiAttempt } from "../../src/bench/adapters.js";
import { runBench } from "../../src/bench/runner.js";
import { cloneWorkspace } from "../../src/bench/runner.js";
import { clearLanes, registerLane } from "../../src/commands/session.js";
import { fixtureConfig, fixtureConfigRow, fixtureSuite, minimalContract, preparedWorkspaces, stubExecutor, tempDir } from "./helpers.js";

/** A local git repository with two commits, so the clone has a real history to pin. */
function localRepo(root: string): { repo: string; parent: string; head: string } {
	const repo = join(root, "upstream");
	execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "ignore" });
	const run = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
	run(["config", "user.email", "fixture@example.com"]);
	run(["config", "user.name", "Fixture"]);
	writeFileSync(join(repo, "file.txt"), "parent revision\n");
	run(["add", "-A"]);
	run(["commit", "-q", "-m", "parent"]);
	const parent = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	writeFileSync(join(repo, "file.txt"), "fix revision\n");
	run(["add", "-A"]);
	run(["commit", "-q", "-m", "fix"]);
	const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	return { repo, parent, head };
}

const TASK = {
	id: "clone-me",
	prompt: "fix the thing",
	source: { repo: "", commit: "", fix_commit: null, pinned_via: "fixture" },
	categories: ["localized-bugs"],
	setup: [],
	golden: { kind: "upstream-test" as const, files: [], command: "test -f file.txt", validated_at: null },
	notes: "",
};

describe("PRD-021 workspace preparation", () => {
	it("clones the source repository and checks out the pinned revision", () => {
		const root = tempDir();
		const upstream = localRepo(root);
		const workspace = cloneWorkspace({ ...TASK, source: { repo: upstream.repo, commit: upstream.parent, fix_commit: upstream.head, pinned_via: "fixture" } }, join(root, "run"));
		expect(existsSync(join(workspace.dir, "file.txt"))).toBe(true);
		expect(readFileSync(join(workspace.dir, "file.txt"), "utf8")).toBe("parent revision\n");
		const head = execFileSync("git", ["-C", workspace.dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		expect(head).toBe(upstream.parent);
		// The held-out fix commit is reachable from the clone, which is what lets the
		// adjudicator check the golden's files out after the attempt is sealed.
		expect(execFileSync("git", ["-C", workspace.dir, "cat-file", "-t", upstream.head], { encoding: "utf8" }).trim()).toBe("commit");
		workspace.cleanup();
		expect(existsSync(workspace.dir)).toBe(false);
	});

	it("fails with the pinned revision named when the repository has no such commit", () => {
		const root = tempDir();
		const upstream = localRepo(root);
		expect(() => cloneWorkspace({ ...TASK, source: { repo: upstream.repo, commit: "f".repeat(40), fix_commit: null, pinned_via: "fixture" } }, join(root, "run"))).toThrow(
			/no revision f{40}/,
		);
		expect(() => cloneWorkspace({ ...TASK, source: { repo: join(root, "absent"), commit: "0".repeat(40), fix_commit: null, pinned_via: "fixture" } }, join(root, "run"))).toThrow(/git clone/);
	});
});

describe("PRD-021 runner limits", () => {
	it("stops a row's task loop when its per-attempt budget is reached and says so in the ledger", async () => {
		const root = tempDir();
		const suiteDir = fixtureSuite(root);
		const configDir = fixtureConfigRow(root, { id: "leanpi-budget", budget_usd: 0.05 });
		const run = await runBench({
			cwd: PACKAGE_ROOT,
			config: fixtureConfig(root),
			suiteDir,
			configDir,
			configIds: ["leanpi-budget"],
			runId: "budget",
			outDir: join(root, "out"),
			prepare: preparedWorkspaces(root).prepare,
			execute: stubExecutor({ completes: () => true, cost: () => 0.03, reported_success: () => true }),
		});
		// 0.03 per attempt against a 0.05 ceiling: the second attempt crosses it, so
		// the third fixture task never runs for this row.
		expect(run.ledger).toHaveLength(2);
		expect(run.ledger[1]?.note).toContain("budget $0.05 reached");
		expect(run.report.configs[0]?.attempts).toBe(2);
		expect(run.report.configs[0]?.budget_usd).toBe(0.05);
	});

	it("refuses to append to a run id that already has a ledger", async () => {
		const root = tempDir();
		const runDir = join(root, "out", "twice");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "ledger.jsonl"), "");
		const options = {
			cwd: PACKAGE_ROOT,
			config: fixtureConfig(root),
			suiteDir: fixtureSuite(root),
			configDir: fixtureConfigRow(root, { id: "fixture-row" }),
			configIds: ["fixture-row"],
			runId: "twice",
			outDir: join(root, "out"),
			prepare: preparedWorkspaces(root).prepare,
			execute: stubExecutor({ completes: () => true, cost: () => 0.01, reported_success: () => true }),
		};
		await expect(runBench(options)).rejects.toThrow(/already exists/);
	});

	it("refuses a LeanPi row with no session factory rather than reporting an empty row", async () => {
		const root = tempDir();
		await expect(
			runBench({
				cwd: PACKAGE_ROOT,
				config: fixtureConfig(root),
				suiteDir: fixtureSuite(root),
				configDir: fixtureConfigRow(root, { id: "leanpi-no-session" }),
				configIds: ["leanpi-no-session"],
				runId: "no-session",
				outDir: join(root, "out"),
				prepare: preparedWorkspaces(root).prepare,
				adapterDeps: {},
			}),
		).rejects.toThrow(/needs a LeanPi session factory/);
	});
});

describe("PRD-021 LeanPi adapter", () => {
	it("runs the turn, writes the §52 record into the run's store, and claims no unearned success", async () => {
		const root = tempDir();
		const config = fixtureConfig(root);
		const workspace = join(root, "workspace");
		execFileSync("git", ["init", "-q", workspace], { stdio: "ignore" });
		const storePath = join(root, "run", "telemetry.jsonl");
		clearLanes();
		registerLane({
			name: "bench.test.executor",
			async run(_turn, context) {
				context.contract = minimalContract();
			},
		});
		const prompted: string[] = [];
		const session = {
			setModel: async () => undefined,
			prompt: async (text: string) => {
				prompted.push(text);
			},
			modelRuntime: { getModel: () => ({ id: "qwen3-coder-480b-a35b" }) },
		} as unknown as AgentSession;

		const result = await leanPiAttempt({ config, session: async () => ({ session }) })({
			task: TASK,
			config: {
				id: "leanpi-jev",
				label: "LeanPi + JEV",
				adapter: "leanpi",
				vendor: null,
				jev: "enabled",
				executor_model: "qwen3-coder-480b-a35b",
				reviewer_model: null,
				features: [],
				owner_gated: false,
				subscription: false,
				budget_usd: 0,
			},
			workspace,
			session_id: "session-1",
			telemetry_task_id: "clone-me@leanpi-jev",
			telemetry_path: storePath,
		});
		clearLanes();
		expect(result.extensions).toEqual(["leanpi"]);
		expect(result.operator).toBe("leanpi");
		expect(result.note).toContain("claims no success");
		expect(prompted).toEqual(["fix the thing"]);
		const record = JSON.parse(readFileSync(storePath, "utf8").trim()) as {
			result: { success: boolean; verification: string; proof_gate: string };
			task_id: string;
			usage: { jev_tokens: number };
		};
		expect(record.task_id).toBe("clone-me@leanpi-jev");
		// The default verdict is PRD-009's real verifier status with the proof gate
		// recorded as not run: the bench never invents a pass.
		expect(record.result.proof_gate).toBe("not_run");
		expect(record.result.success).toBe(false);
		expect(["pass", "incomplete", "deterministic_failure"]).toContain(record.result.verification);
	});

	it("records what the session did when no lane compiled a contract, instead of losing the attempt", async () => {
		const root = tempDir();
		const config = fixtureConfig(root);
		const workspace = join(root, "workspace");
		const storePath = join(root, "run", "telemetry.jsonl");
		execFileSync("git", ["init", "-q", workspace], { stdio: "ignore" });
		// Native executor roles (PRD-007's ownership rule): no lane registers, so
		// Pi's own loop is what ran and the record comes from its message list.
		clearLanes();
		const session = {
			setModel: async () => undefined,
			prompt: async () => undefined,
			modelRuntime: { getModel: () => ({ id: "x" }) },
			messages: [
				{ role: "assistant", usage: { input: 1200, cacheRead: 400, output: 60, reasoning: 0 }, content: [{ type: "toolCall" }, { type: "text" }] },
				{ role: "assistant", usage: { input: 1300, cacheRead: 800, output: 40, reasoning: 0 }, content: [{ type: "toolCall" }] },
			],
		} as unknown as AgentSession;
		const result = await leanPiAttempt({ config, session: async () => ({ session }) })({
			task: TASK,
			config: {
				id: "leanpi-jev",
				label: "LeanPi + JEV",
				adapter: "leanpi",
				vendor: null,
				jev: "enabled",
				executor_model: "qwen3-coder-480b-a35b",
				reviewer_model: null,
				features: [],
				owner_gated: false,
				subscription: false,
				budget_usd: 0,
			},
			workspace,
			session_id: "session-2",
			telemetry_task_id: "clone-me@leanpi-jev",
			telemetry_path: storePath,
		});
		expect(result.note).toContain("no contract");
		const record = JSON.parse(readFileSync(storePath, "utf8").trim()) as {
			usage: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
			execution: { tool_calls: number };
			result: { success: boolean; proof_gate: string };
		};
		expect(record.usage).toMatchObject({ input_tokens: 2500, cached_input_tokens: 1200, output_tokens: 100 });
		expect(record.execution.tool_calls).toBe(2);
		// The turn returning is never a success claim; the held-out golden decides.
		expect(record.result.success).toBe(false);
		expect(record.result.proof_gate).toBe("not_run");
	});

	it("prices native usage without double-charging reasoning, which Pi already includes in output", async () => {
		const root = tempDir();
		const config = fixtureConfig(root);
		const workspace = join(root, "workspace");
		const storePath = join(root, "run", "telemetry.jsonl");
		execFileSync("git", ["init", "-q", workspace], { stdio: "ignore" });
		clearLanes();
		// Pi's `Usage.output` includes `reasoning`; the synthesized call must bill
		// output once. Fixture rates: input $1/Mtok, output $2/Mtok, cacheRead $0.1/Mtok.
		const session = {
			setModel: async () => undefined,
			prompt: async () => undefined,
			modelRuntime: { getModel: () => ({ id: "x" }) },
			messages: [{ role: "assistant", usage: { input: 1000, cacheRead: 0, output: 100, reasoning: 40 }, content: [] }],
		} as unknown as AgentSession;
		await leanPiAttempt({ config, session: async () => ({ session }) })({
			task: TASK,
			config: {
				id: "leanpi-jev",
				label: "LeanPi + JEV",
				adapter: "leanpi",
				vendor: null,
				jev: "enabled",
				executor_model: "qwen3-coder-480b-a35b",
				reviewer_model: null,
				features: [],
				owner_gated: false,
				subscription: false,
				budget_usd: 0,
			},
			workspace,
			session_id: "session-3",
			telemetry_task_id: "clone-me@leanpi-jev",
			telemetry_path: storePath,
		});
		const record = JSON.parse(readFileSync(storePath, "utf8").trim()) as {
			usage: { output_tokens: number; reasoning_tokens: number };
			cost: { api_usd: number };
		};
		expect(record.usage).toMatchObject({ output_tokens: 100, reasoning_tokens: 40 });
		// 1000 input + 100 output = $0.0012; the double-counted price would be $0.00128.
		expect(record.cost.api_usd).toBe(0.0012);
	});
	it("does not start a request whose attempt ceiling expired during compilation", async () => {
		// The ceiling is absolute, so a slow compile must not be able to hand the
		// loop a request with no bound left: before this, the timer aborted a stream
		// that had not started and the turn ran unbounded anyway.
		const root = tempDir();
		const config = fixtureConfig(root);
		const workspace = join(root, "workspace");
		execFileSync("git", ["init", "-q", workspace], { stdio: "ignore" });
		const storePath = join(root, "run", "telemetry.jsonl");
		clearLanes();
		let prompts = 0;
		const session = {
			setModel: async () => undefined,
			prompt: async () => {
				prompts += 1;
			},
			agent: { abort: () => undefined },
			modelRuntime: { getModel: () => ({ id: "x" }) },
			messages: [],
		} as unknown as AgentSession;
		registerLane({
			name: "slow-compile",
			async run() {
				await new Promise((resolve) => setTimeout(resolve, 60));
			},
		});
		const result = await leanPiAttempt({ config, session: async () => ({ session }), timeoutMs: 5 })({
			task: TASK,
			config: {
				id: "leanpi-jev",
				label: "LeanPi + JEV",
				adapter: "leanpi",
				vendor: null,
				jev: "enabled",
				executor_model: "qwen3-coder-480b-a35b",
				reviewer_model: null,
				features: [],
				owner_gated: false,
				subscription: false,
				budget_usd: 0,
			},
			workspace,
			session_id: "session-slow",
			telemetry_task_id: "clone-me@leanpi-jev",
			telemetry_path: storePath,
		});
		clearLanes();
		// No request started: the ceiling covers the compile, so the attempt ends
		// with what the lanes spent and the note says why.
		expect(prompts).toBe(0);
		expect(result.note).toContain("attempt ceiling");
	});
});
