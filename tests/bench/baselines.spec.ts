/**
 * PRD-021 AC-3 and AC-4 — the stock-Pi baseline and the owner-gated subscription baselines.
 *
 * AC-3's claim is that a row can run Pi with **no LeanPi extension loaded** and
 * still produce a complete five-metric row. The extension list is read back from
 * Pi's own resource loader, so "no LeanPi" is observed rather than asserted. The
 * model transport is scripted (there is no local model in CI); everything around
 * it — Pi's services, its `models.json` custom-provider path, PRD-015's record
 * writer — is the production path.
 *
 * AC-4's rows run joao's own logged-in CLIs. They must refuse to run without the
 * explicit flag and must fail loudly when the CLI is missing, rather than
 * reporting an empty row.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT } from "../../src/index.js";
import { EXTERNAL_BASELINES_FLAG, externalAttempt, stockPiAttempt, stockPiExtensions, vendorAvailable, writeStockPiModels } from "../../src/bench/adapters.js";
import { main } from "../../src/bench/cli.js";
import { runBench } from "../../src/bench/runner.js";
import type { BenchConfigRow } from "../../src/bench/types.js";
import type { HarnessSpawn, HarnessSpawnRequest, HarnessSpawnResult } from "../../src/backends/index.js";
import { capturingIo, fakePiSession, fixtureConfig, fixtureConfigRow, fixtureSuite, preparedWorkspaces, scriptedJudge, tempDir } from "./helpers.js";

const CLAUDE_ROW: BenchConfigRow = {
	id: "claude-code",
	label: "Claude Code baseline (owner-gated)",
	adapter: "external",
	vendor: "claude",
	jev: "disabled",
	executor_model: "claude-sonnet-4-5",
	reviewer_model: null,
	features: [],
	owner_gated: true,
	subscription: true,
	budget_usd: 0,
};

/** The vendor CLI's argv, as PRD-008's descriptor builds it, captured instead of spawned. */
function recordingSpawn(stdout: string): { spawn: HarnessSpawn; requests: HarnessSpawnRequest[] } {
	const requests: HarnessSpawnRequest[] = [];
	return {
		requests,
		spawn: async (request: HarnessSpawnRequest): Promise<HarnessSpawnResult> => {
			requests.push(request);
			return { code: 0, signal: null, stdout, stderr: "", error: null, timedOut: false };
		},
	};
}

describe("PRD-021 AC-3 — the stock-Pi baseline", () => {
	it("loads no LeanPi extension and still reports a complete five-metric row", async () => {
		const root = tempDir();
		const cleanRepo = join(root, "clean-repo");
		mkdirSync(cleanRepo, { recursive: true });
		const extensions = await stockPiExtensions(cleanRepo, join(root, "clean-agent"));
		expect(extensions.extensions).toEqual([]);
		expect(extensions.errors).toEqual([]);

		const suiteDir = fixtureSuite(root);
		const configDir = fixtureConfigRow(root, { id: "stock-pi", adapter: "stock-pi" });
		const config = fixtureConfig(root);
		const run = await runBench({
			cwd: PACKAGE_ROOT,
			config,
			suiteDir,
			configDir,
			configIds: ["stock-pi"],
			runId: "ac3",
			outDir: join(root, "out"),
			prepare: preparedWorkspaces(root).prepare,
			rubricJudge: scriptedJudge(true),
			now: () => new Date("2026-09-19T00:00:00.000Z"),
			execute: stockPiAttempt({
				config,
				agentDir: join(root, "agent"),
				// The session does the only thing the fixture's acceptance check looks
				// for, then reports the tokens Pi would report.
				session: async (attempt) => fakePiSession({ input: 1_000, output: 100 }, attempt.workspace) as unknown as AgentSession,
			}),
		});
		const row = run.report.configs[0];
		expect(row?.attempts).toBe(3);
		expect(row?.loaded_extensions).toEqual([]);
		expect(row?.subscription_usage).toBe(0);
		expect(row?.verified_solve_rate).toBeCloseTo(2 / 3, 10);
		expect(row?.adjudicated_incomplete).toBe(1);
		expect(row?.false_completion_rate).toBeCloseTo(1 / 3, 10);
		expect(row?.time_to_verified_success_ms.n).toBe(2);
		expect(row?.generator_tokens_per_verified_success).toBeCloseTo((3 * 1_100) / 2, 6);
		expect(JSON.parse(readFileSync(run.report_json_path, "utf8"))).toMatchObject({ configs: [{ loaded_extensions: [] }] });
		expect(readFileSync(run.report_path, "utf8")).toContain("loaded extensions: none (no LeanPi)");
		// The record carries the tokens Pi reported, priced from the backend's rates.
		const stored = readFileSync(join(run.dir, "telemetry.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { usage: { input_tokens: number }; cost: { api_usd: number } });
		expect(stored).toHaveLength(3);
		expect(stored[0]?.usage.input_tokens).toBe(1_000);
		expect(stored[0]?.cost.api_usd).toBeCloseTo(0.0012, 6);
	});

	it("writes Pi's custom-provider models.json from the configuration's local backend", () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		writeStockPiModels(fixtureConfig(root), agentDir);
		const written = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")) as {
			providers: Record<string, { baseUrl: string; models: Array<{ id: string }> }>;
		};
		expect(written.providers.local?.baseUrl).toBe("http://127.0.0.1:1/v1");
		expect(written.providers.local?.models.map((model) => model.id)).toContain("qwen3-coder-480b-a35b");
	});
});

describe("PRD-021 AC-4 — the owner-gated subscription baselines", () => {
	it("refuses to run a subscription baseline without the explicit owner flag", async () => {
		const root = tempDir();
		const io = capturingIo();
		const exit = await main(["--suite", fixtureSuite(root), "--configs", "claude-code"], {
			cwd: PACKAGE_ROOT,
			config: fixtureConfig(root),
			io,
			env: { PATH: "/nonexistent", [EXTERNAL_BASELINES_FLAG]: "0" },
			adapterDeps: {},
		});
		expect(exit).toBe(1);
		expect(io.errors).toContain(EXTERNAL_BASELINES_FLAG);
	});

	it("names the missing CLI instead of emitting an empty row", async () => {
		const root = tempDir();
		const io = capturingIo();
		const exit = await main(["--suite", fixtureSuite(root), "--configs", "codex"], {
			cwd: PACKAGE_ROOT,
			config: fixtureConfig(root),
			io,
			env: { PATH: "/nonexistent", [EXTERNAL_BASELINES_FLAG]: "1" },
			adapterDeps: {},
		});
		expect(exit).toBe(1);
		expect(io.errors).toContain("codex");
		expect(io.errors).toContain("PATH");
	});

	it("drives PRD-008's workers and records the subscription draw the worker reported", async () => {
		const root = tempDir();
		const config = fixtureConfig(root);
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const baselineEnv = { [EXTERNAL_BASELINES_FLAG]: "1" };
		for (const vendor of ["claude", "codex"] as const) {
			const externalConfig = { ...config, backends: { ...config.backends, [vendor]: { type: "external_harness" as const, vendor, command: vendor } } };
			const recorder = recordingSpawn(
				vendor === "claude" ? JSON.stringify({ session_id: "s1", result: "done" }) : JSON.stringify({ thread_id: "t1", item: { text: "done" } }),
			);
			const storePath = join(root, `telemetry-${vendor}.jsonl`);
			const task = {
				id: "fix-the-thing",
				prompt: "fix the thing",
				source: { repo: "r", commit: "0".repeat(40), fix_commit: null, pinned_via: "fixture" },
				categories: ["localized-bugs"],
				setup: [],
				golden: { kind: "none" as const, files: [], command: "", validated_at: null },
				notes: "",
			};
			const result = await externalAttempt({ config: externalConfig, env: baselineEnv, spawn: recorder.spawn })({
				task,
				config: { ...CLAUDE_ROW, id: vendor, vendor, executor_model: vendor === "claude" ? "claude-sonnet-4-5" : "gpt-5" },
				workspace,
				session_id: `s-${vendor}`,
				telemetry_task_id: `fix-the-thing@${vendor}`,
				telemetry_path: storePath,
			});
			expect(result.operator).toBe(vendor);
			expect(result.subscription_usage).toBe(1);
			expect(recorder.requests).toHaveLength(1);
			// LeanPi adds no vendor flag of its own: the descriptor's argv is the whole
			// invocation, and the credential stays with the CLI (§48).
			expect(recorder.requests[0]?.args[0]).toBe(vendor === "claude" ? "-p" : "exec");
			// The environment crosses verbatim: LeanPi adds no variable, so no
			// credential is introduced on the way to the vendor's own CLI.
			expect(recorder.requests[0]?.env).toBe(baselineEnv);
			const record = JSON.parse(readFileSync(storePath, "utf8").trim()) as {
				usage: { subscription_usage: number; external_harness_calls: number };
				result: { success: boolean };
			};
			expect(record.usage.subscription_usage).toBe(1);
			expect(record.usage.external_harness_calls).toBe(1);
			expect(record.result.success).toBe(true);
		}
	});

	it("fails loudly when the vendor CLI cannot start, and names a limit instead of retrying around it", async () => {
		const root = tempDir();
		const config = fixtureConfig(root);
		const workspace = join(root, "workspace");
		mkdirSync(workspace, { recursive: true });
		const externalConfig = { ...config, backends: { ...config.backends, claude: { type: "external_harness" as const, vendor: "claude" as const, command: "claude" } } };
		const attempt = {
			task: {
				id: "fix-the-thing",
				prompt: "fix the thing",
				source: { repo: "r", commit: "0".repeat(40), fix_commit: null, pinned_via: "fixture" },
				categories: ["localized-bugs"],
				setup: [],
				golden: { kind: "none" as const, files: [], command: "", validated_at: null },
				notes: "",
			},
			config: CLAUDE_ROW,
			workspace,
			session_id: "s",
			telemetry_task_id: "fix-the-thing@claude-code",
			telemetry_path: join(root, "telemetry.jsonl"),
		};
		const env = { [EXTERNAL_BASELINES_FLAG]: "1" };
		const missing: HarnessSpawn = async () => ({
			code: null,
			signal: null,
			stdout: "",
			stderr: "",
			error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
			timedOut: false,
		});
		await expect(externalAttempt({ config: externalConfig, env, spawn: missing })(attempt)).rejects.toThrow(/could not start/);
		const limited: HarnessSpawn = async () => ({ code: 1, signal: null, stdout: "", stderr: "you have hit your usage limit", error: null, timedOut: false });
		await expect(externalAttempt({ config: externalConfig, env, spawn: limited })(attempt)).rejects.toThrow(/usage limit/);
	});

	it("sees the vendor CLI's presence on PATH, so a missing baseline is caught before the run", () => {
		expect(vendorAvailable(CLAUDE_ROW, { PATH: "/nonexistent" })).toBe(false);
		expect(vendorAvailable({ ...CLAUDE_ROW, adapter: "leanpi", vendor: null }, { PATH: "/nonexistent" })).toBeNull();
	});
});
