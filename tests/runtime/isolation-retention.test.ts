/**
 * PRD-040 C — a retained isolated checkout is surfaced, not reported as removed.
 *
 * `cleanup` may refuse to reclaim a worktree it cannot account for (a commit the
 * patch does not carry). The lane used to set `removed: true` whenever it had
 * persisted a patch, losing the checkout's location and the refusal reason — so a
 * failed turn looked clean while its work sat in a kept directory. These cases
 * exercise the lane's success and failure surfacing plus the shared
 * persistence-failure retention directly.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setCompilerContext } from "../../src/compiler/index.js";
import { executorLane } from "../../src/commands/turn-lanes.js";
import type { TurnContext } from "../../src/commands/session.js";
import { compileTask } from "../../src/compiler/index.js";
import { loadConfig } from "../../src/core/config.js";
import { clearLanes, registerTurnLanes, runTurn } from "../../src/index.js";
import { resolvedDefaults } from "../../src/permissions/trust.js";
import { REVIEW_LEVEL_QUESTION_ID, REVIEW_LEVEL_SITE_ID } from "../../src/review/gate.js";
import { runIsolated, worktreePath, worktreeRootOf } from "../../src/runtime/index.js";
import { scoutTask } from "../../src/scout/index.js";
import { choice, fakeExec, harness, scriptedJev, VERIFY_COMMANDS, type ExecHarness } from "../executor/helpers.js";

const open: ExecHarness[] = [];

afterEach(async () => {
	clearLanes();
	while (open.length > 0) await open.pop()?.close();
});

function isolatedConfig(cwd: string) {
	const permissions = resolvedDefaults();
	permissions.defaults.git_destructive = "allow";
	return loadConfig(cwd, {
		configPath: null,
		backends: { first: { type: "external_harness", vendor: "claude", command: "/bin/true", priority: 30 } },
		models: { quick: { backend: "first", model: "m" }, balanced: { backend: "first", model: "m" }, strong: { backend: "first", model: "m" } },
		limits: { executionAttempts: 2, semanticReviewRounds: 1, isolation: "worktree" },
		permissions,
	});
}

describe("PRD-040 C — turn-lanes surfaces a retained isolated checkout", () => {
	it("reports removed:false with the exact path and reason when the worker committed", async () => {
		const h = await harness({ config: isolatedConfig });
		open.push(h);
		setCompilerContext({ config: h.config, cwd: h.cwd } as never);
		registerTurnLanes({
			cwd: h.cwd,
			config: h.config,
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
			jev: scriptedJev({ [REVIEW_LEVEL_SITE_ID]: () => choice(REVIEW_LEVEL_QUESTION_ID, "NO_SEMANTIC_REVIEW") }),
			worker: async (_packet, run) => {
				writeFileSync(join(run.cwd, "src", "target.ts"), "export const value = 42;\n");
				execFileSync("git", ["add", "-A"], { cwd: run.cwd });
				execFileSync("git", ["commit", "-q", "-m", "worker commit"], { cwd: run.cwd });
				return { status: "completed", backend: "first", result: { status: "ok", changedFiles: ["src/target.ts"], summary: "committed" }, attempts: [] };
			},
		});

		const context = await runTurn({ text: "rename the helper in src/target.ts" }, { config: h.config, cwd: h.cwd });

		expect(context.isolation?.removed).toBe(false);
		expect(context.isolation?.retained?.path).toBeDefined();
		expect(existsSync(context.isolation!.retained!.path)).toBe(true);
		expect(context.isolation?.retained?.reason).toContain("commit(s) the surfaced patch does not represent");
		// The persisted patch names the represented paths even though cleanup retained.
		expect(context.isolation?.patchPath).toBeDefined();
		expect(readFileSync(context.isolation!.patchPath!, "utf8")).toContain("src/target.ts");
	});

	it("surfaces the retained checkout on the turn context when the run throws", async () => {
		const h = await harness({ config: isolatedConfig });
		open.push(h);
		setCompilerContext({ config: h.config, cwd: h.cwd } as never);
		const request = "fix the parse bug";
		const contract = await compileTask(request, scoutTask(h.cwd, request));
		// Obstruct the patch directory so persistence throws after the checkout exists.
		writeFileSync(join(h.cwd, ".leanpi"), "not a directory\n");
		const deps = {
			cwd: h.cwd,
			config: h.config,
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
			jev: scriptedJev({ [REVIEW_LEVEL_SITE_ID]: () => choice(REVIEW_LEVEL_QUESTION_ID, "NO_SEMANTIC_REVIEW") }),
			worker: async (_packet: unknown, run: { cwd: string }) => {
				writeFileSync(join(run.cwd, "src", "target.ts"), "export const value = 9;\n");
				return { status: "completed", backend: "first", result: { status: "ok", changedFiles: ["src/target.ts"], summary: "edited" }, attempts: [] };
			},
		};
		const context = {
			turn: { text: request },
			role: "balanced",
			cwd: h.cwd,
			config: h.config,
			modelRef: { backend: "first", model: "m" },
			skills: [],
			prefix: "",
			contract,
		} as unknown as TurnContext;

		await expect(executorLane(deps as never).run(context.turn, context)).rejects.toThrow();
		expect(context.isolation?.removed).toBe(false);
		expect(context.isolation?.retained?.path).toBeDefined();
		expect(existsSync(context.isolation!.retained!.path)).toBe(true);
	});

	it("retains the checkout and reports its location when persistence fails", async () => {
		const h = await harness({ config: isolatedConfig });
		open.push(h);
		const runRoot = worktreeRootOf(h.config, h.cwd);
		const runId = "run-persist-fail";
		const path = worktreePath(h.cwd, runId, runRoot);
		let reported: { removed: boolean; path: string; reason: string; paths: string[] } | undefined;

		await expect(
			runIsolated(runId, {
				repoRoot: h.cwd,
				permissions: h.config.permissions,
				onPatch: () => {
					throw new Error("disk full");
				},
				onCleanup: (result) => {
					if (!result.removed) reported = { removed: result.removed, path: result.path, reason: result.reason, paths: result.paths };
				},
				async run(cwd) {
					writeFileSync(join(cwd, "src", "target.ts"), "export const value = 7;\n");
				},
			}),
		).rejects.toThrow("disk full");

		expect(reported).toBeDefined();
		expect(reported!.removed).toBe(false);
		expect(reported!.path).toBe(path);
		expect(reported!.reason).toContain("persisting the surfaced patch failed");
		expect(reported!.paths).toContain("src/target.ts");
		// Nothing was discarded: the checkout and its edit are still on disk.
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(join(path, "src", "target.ts"), "utf8")).toBe("export const value = 7;\n");
	});
});
