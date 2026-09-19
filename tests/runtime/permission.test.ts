/**
 * PRD-022 E7 — the destructive-git permission scope (AC-9).
 *
 * Worktree creation, removal and pruning are ROADMAP §47's `destructive git
 * operations`, so they route through PRD-017: `deny` refuses before anything is
 * created, `ask` presents the scope and the concrete path, and no confirmation
 * channel means no. The filesystem assertion is the point — a refusal that still
 * created a directory would be the bug this criterion exists to catch.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { builtinPermissions } from "../../src/permissions/index.js";
import { runIsolated, WorktreePermissionError, worktreePermissionPrompt, worktreePath, worktreeRoot } from "../../src/runtime/index.js";
import { gitStatus, gitWorktreePaths, permissionConfig, scratchRepo } from "./support.js";

describe("AC-9 — a worktree run is refused unless the destructive-git scope allows it", () => {
	it("refuses under DENY, naming the scope, with nothing created", async () => {
		const repo = scratchRepo();
		const path = worktreePath(repo, "run-denied");

		const failure = await runIsolated("run-denied", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "deny"),
			async run() {
				throw new Error("the executor must never be reached");
			},
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(WorktreePermissionError);
		const refusal = failure as WorktreePermissionError;
		expect(refusal.scope).toBe("git_destructive");
		expect(refusal.decision.decision).toBe("deny");
		expect(refusal.path).toBe(path);
		expect(refusal.capability).toBe(`git_destructive:git worktree add --detach ${path} HEAD`);
		expect(refusal.message).toContain('scope "git_destructive"');
		expect(refusal.message).toContain(path);
		expect(refusal.message).toContain("nothing was created");

		// The filesystem is exactly as it was: no run root, no worktree, no branch.
		expect(existsSync(worktreeRoot(repo))).toBe(false);
		expect(gitWorktreePaths(repo)).toEqual([repo]);
		expect(gitStatus(repo)).toBe("");
	});

	it("defaults to the built-in conservative posture, where the scope is denied", async () => {
		const repo = scratchRepo();
		// No `permissions` at all: PRD-017's built-ins answer, and they deny this scope.
		expect(builtinPermissions().defaults.git_destructive).toBe("deny");

		const failure = await runIsolated("run-default", {
			repoRoot: repo,
			async run() {
				throw new Error("the executor must never be reached");
			},
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(WorktreePermissionError);
		expect(existsSync(worktreeRoot(repo))).toBe(false);
	});

	it("asks with the scope and the concrete path, and declining changes nothing", async () => {
		const repo = scratchRepo();
		const asked: Array<{ prompt: string; path: string; existed: boolean }> = [];

		const failure = await runIsolated("run-declined", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "ask"),
			confirm: (request) => {
				asked.push({ prompt: worktreePermissionPrompt(request), path: request.path, existed: existsSync(request.path) });
				return false;
			},
			async run() {
				throw new Error("the executor must never be reached");
			},
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(WorktreePermissionError);
		expect((failure as Error).message).toContain("confirmation prompt");
		expect(asked).toHaveLength(1);
		// The prompt is presented *before* the worktree exists, naming both.
		expect(asked[0]!.existed).toBe(false);
		expect(asked[0]!.path).toBe(worktreePath(repo, "run-declined"));
		expect(asked[0]!.prompt).toContain('scope "git_destructive"');
		expect(asked[0]!.prompt).toContain(asked[0]!.path);
		expect(existsSync(worktreeRoot(repo))).toBe(false);
		expect(gitStatus(repo)).toBe("");
	});

	it("treats an ask with no confirmation channel as a refusal", async () => {
		const repo = scratchRepo();

		const failure = await runIsolated("run-no-ui", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "ask"),
			async run() {
				throw new Error("the executor must never be reached");
			},
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(WorktreePermissionError);
		expect((failure as Error).message).toContain("declined or unavailable");
		expect(existsSync(worktreeRoot(repo))).toBe(false);
	});

	it("runs when PRD-017's rules allow the scope, without asking", async () => {
		const repo = scratchRepo();
		// A rule, not a default: the concrete command is what it matches.
		const permissions = permissionConfig("git_destructive", "deny");
		permissions.rules.push({ capability: "git_destructive:git worktree*", decision: "allow", source: "user" });
		let asked = 0;

		const run = await runIsolated("run-allowed", {
			repoRoot: repo,
			permissions,
			confirm: () => {
				asked += 1;
				return false;
			},
			async run(cwd) {
				expect(existsSync(cwd)).toBe(true);
			},
		});

		expect(asked).toBe(0);
		expect(run.cleanup?.removed).toBe(true);
		expect(gitWorktreePaths(repo)).toEqual([repo]);
	});
});
