/**
 * A1 — the executor's change set must come from the worktree, not from the
 * skill `source` labels the packet carries as prompt context.
 *
 * The lane used to fill `packet.files` with `class:path` skill labels and let
 * the worker report "changed files" by re-snapshotting those same strings, so a
 * real turn reported `changedFiles: []` and the review gate short-circuited.
 * This drives the real `runExecutor` through a real worker (the stub CLI edits
 * the workspace) and a real `verifyTask`, and asserts on the disk outcome.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackendRegistry } from "../../src/backends/index.js";
import type { ExecutionContract } from "../../src/compiler/contract.js";
import { createArtifactStore } from "../../src/context/artifacts.js";
import { loadConfig } from "../../src/core/config.js";
import { runExecutor, type ExecutorDeps } from "../../src/executor/index.js";
import { EvidenceStore } from "../../src/verify/evidence.js";
import { installStubCli, setStubScript } from "../backends/helpers.js";
import { quickContract, repoWithTest, type ExecHarness } from "./helpers.js";

const PASS_VERDICT = JSON.stringify({ decision: "PASS", findings: [] });

describe("A1 — executor change detection", () => {
	it("reports the worktree change, not the skill labels in packet.files", async () => {
		const { cwd, agentDir } = repoWithTest();
		// Compile against the clean repo, so the dirty fixtures below cannot change
		// the complexity (and therefore the required verifiers).
		const base = await quickContract({ cwd } as ExecHarness);
		const contract: ExecutionContract = {
			...base,
			task: { ...base.task, review_risk: "R0" },
			routing: { ...base.routing, executor_class: "quick", reviewer_class: "none" },
			// The lane's own selection output: a skill whose `source` is a
			// `class:path` label, never a workspace path.
			capabilities: { ...base.capabilities, skills: [{ name: "s", source: "user:/home/x/skills/s/SKILL.md", body: "b" }] },
		};

		// Two files are dirty before the turn: one the worker edits, one it does
		// not. Only the edited one may be attributed to this turn.
		writeFileSync(join(cwd, "src", "dirty.ts"), "export const d = 1;\n");
		writeFileSync(join(cwd, "src", "untouched.ts"), "export const u = 1;\n");
		execFileSync("git", ["add", "-A"], { cwd });
		execFileSync("git", ["commit", "-q", "-m", "dirty fixtures"], { cwd });
		writeFileSync(join(cwd, "src", "dirty.ts"), "export const d = 2; // pre-existing edit\n");
		writeFileSync(join(cwd, "src", "untouched.ts"), "export const u = 2; // untouched pre-existing edit\n");

		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, {
			// A brand-new file, an edit to an already-dirty file, and a new
			// security-sensitive file.
			files: { "new-file.txt": "created\n", "src/dirty.ts": "export const d = 3; // edited by the turn\n", "src/auth.ts": "export const token = 1;\n" },
			summary: "done",
			structured: { status: "ok", files: ["new-file.txt", "src/dirty.ts", "src/auth.ts"] },
		});

		const config = loadConfig(cwd, {
			configPath: null,
			backends: { claude: { type: "external_harness", command: cli.bin.claude } },
			models: { quick: { backend: "claude", model: "claude-model" } },
		});
		const deps: ExecutorDeps = {
			registry: new BackendRegistry(config),
			cwd,
			config,
			artifacts: createArtifactStore({ sessionDir: join(agentDir, "session") }),
			store: new EvidenceStore(() => new Date("2026-09-19T00:00:00.000Z")),
			// Real `verifyTask`, real commands; only the vendor transport is stubbed.
			verifyCommands: { typecheck: "true", targeted_test: "true", runtime_smoke: "true", lint: "true", build: "true", git_status: "git status --porcelain" },
			reviewRunner: async () => ({ status: "ok", changedFiles: [], summary: PASS_VERDICT }),
		};

		try {
			const outcome = await runExecutor(contract, deps);
			expect(outcome.status).toBe("completed");
			expect(outcome.changedFiles).toEqual(["new-file.txt", "src/auth.ts", "src/dirty.ts"]);
			expect(outcome.changedFiles).not.toContain("src/untouched.ts");
			// The gate reads the real change, so a security-sensitive file is not
			// short-circuited to "no files changed".
			expect(outcome.review.skipped).toBe(false);
			expect(outcome.review.level).not.toBe("NO_SEMANTIC_REVIEW");
		} finally {
			restore();
		}
	});
});
