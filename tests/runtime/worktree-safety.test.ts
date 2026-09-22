import { chmodSync, statSync, existsSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch, cleanup, pruneOrphans, runIsolated, worktreeRoot } from "../../src/runtime/index.js";
import { git, permissionConfig, scratchRepo } from "./support.js";
import { changeSnapshot, changedPathsSince } from "../../src/runtime/git.js";
import { workspaceHash } from "../../src/verify/hash.js";
import { workspaceChange } from "../../src/review/packet.js";

const permissions = permissionConfig("git_destructive", "allow");

describe("worktree ownership and data preservation", () => {
	it("confines custom roots to the primary .worktrees directory", () => {
		const repo = scratchRepo();
		expect(() => worktreeRoot(repo, "runs")).toThrow();
		expect(worktreeRoot(repo, ".worktrees/custom")).toBe(join(repo, ".worktrees/custom"));
	});
	it("refuses roots nested under another registered checkout", async () => {
		const repo = scratchRepo();
		const kept = await runIsolated("sibling", { repoRoot: repo, permissions, keep: true, run: async () => {} });
		expect(() => worktreeRoot(repo, join(kept.path, ".worktrees"))).toThrow();
	});
	it("retains ignored files with the exact checkout and reason", async () => {
		const repo = scratchRepo({ "app.txt": "before\n", ".gitignore": "private.txt\n" });
		const run = await runIsolated("ignored", { repoRoot: repo, permissions, run: async cwd => {
			writeFileSync(join(cwd, "app.txt"), "after\n");
			writeFileSync(join(cwd, "private.txt"), "irreplaceable\n");
		}});
		expect(run.cleanup?.removed).toBe(false);
		expect(run.cleanup && !run.cleanup.removed ? run.cleanup.reason : "").toMatch(/ignored/i);
		expect(readFileSync(join(run.path, "private.txt"), "utf8")).toBe("irreplaceable\n");
	});
	it("never prunes a live run even when liveRunIds is omitted", async () => {
		const repo = scratchRepo();
		const run = await runIsolated("active", { repoRoot: repo, permissions, run: async cwd => {
			expect(pruneOrphans({ repoRoot: repo })).toEqual([]);
			expect(existsSync(cwd)).toBe(true);
			expect(cleanup("active", { repoRoot: repo }).removed).toBe(false);
		}});
		expect(run.cleanup?.removed).toBe(true);
	});
	it("preflights manifest paths before applying a complete diff", async () => {
		const repo = scratchRepo({ "app.txt": "before\n" });
		const run = await runIsolated("escape", { repoRoot: repo, permissions, run: async cwd => {
			writeFileSync(join(cwd, "app.txt"), "after\n");
		}});
		const target = scratchRepo({ "app.txt": "before\n" });
		const patch = { ...run.patch, untracked: [{path: "../outside.txt", content: "bad", encoding: "utf8" as const}] };
		expect(() => applyPatch(patch, target)).toThrow();
		expect(readFileSync(join(target, "app.txt"), "utf8")).toBe("before\n");
	});
	it("accepts an empty complete patch without invoking git apply", async () => {
		const repo = scratchRepo();
		const run = await runIsolated("empty", { repoRoot: repo, permissions, run: async () => {} });
		expect(applyPatch(run.patch, repo)).toEqual({ paths: [] });
		expect(git(repo, ["status", "--porcelain"])).toBe("");
	});
});


describe("exact git filenames", () => {
	it.each([" odd name ", "literal -> arrow.txt", "line\nbreak.txt", 'quoted"file.txt'])("attributes and hashes edits to %j", path => {
		const repo = scratchRepo({ [path]: "base\n" });
		writeFileSync(join(repo, path), "first\n");
		const before = changeSnapshot(repo)!;
		const hash = workspaceHash(repo, [path]);
		writeFileSync(join(repo, path), "second\n");
		expect(changedPathsSince(before, repo)).toEqual([path]);
		expect(workspaceHash(repo, [path])).not.toBe(hash);
		expect(workspaceChange(repo).files).toEqual([path]);
	});
	it("preserves rename source and destination", async () => {
		const from = "old -> name.txt";
		const to = 'new\n"name.txt';
		const repo = scratchRepo({ [from]: "base\n" });
		const run = await runIsolated("odd-patch", {repoRoot: repo, permissions, run: async cwd => {
			git(cwd, ["mv", from, to]);
			writeFileSync(join(cwd, to), "updated\n");
		}});
		expect(run.cleanup?.removed).toBe(true);
		const target = scratchRepo({ [from]: "base\n" });
		applyPatch(run.patch, target);
		expect(existsSync(join(target, from))).toBe(false);
		expect(readFileSync(join(target, to), "utf8")).toBe("updated\n");
	});
});


describe("symlink patch data", () => {
	it("captures link identities without copying outside target bytes", async () => {
		const secret = scratchRepo({ "secret.txt": "PRIVATE-OUTSIDE-CONTENT\n" });
		const repo = scratchRepo();
		const run = await runIsolated("links", { repoRoot: repo, permissions, run: async cwd => {
			symlinkSync(join(secret, "secret.txt"), join(cwd, "outside-link"));
			symlinkSync("missing-target", join(cwd, "broken-link"));
		}});
		expect(JSON.stringify(run.patch)).not.toContain("PRIVATE-OUTSIDE-CONTENT");
		expect(run.patch.paths).toEqual(["broken-link", "outside-link"]);
		expect(run.cleanup?.removed).toBe(true);
		const target = scratchRepo();
		applyPatch(run.patch, target);
		expect(readlinkSync(join(target, "outside-link"))).toBe(join(secret, "secret.txt"));
		expect(readlinkSync(join(target, "broken-link"))).toBe("missing-target");
		expect(readFileSync(join(secret, "secret.txt"), "utf8")).toBe("PRIVATE-OUTSIDE-CONTENT\n");
	});
});

it("preserves a failed run's patch even without an onPatch callback", async () => {
	const repo = scratchRepo({ "app.txt": "before\n" });
	await expect(runIsolated("failed-capture", { repoRoot: repo, permissions, run: async cwd => {
		writeFileSync(join(cwd, "app.txt"), "work before failure\n");
		throw new Error("worker failed");
	}})).rejects.toThrow("worker failed");
	const patch = JSON.parse(readFileSync(join(repo, ".worktrees/failed-capture.patch.json"), "utf8"));
	expect(patch.completeDiff).toContain("+work before failure");
	expect(existsSync(join(repo, ".worktrees/failed-capture"))).toBe(false);
});

it("retains mode changes made after the patch was surfaced", async () => {
	const repo = scratchRepo({ "app.txt": "before\n" });
	const run = await runIsolated("mode-drift", { repoRoot: repo, permissions, keep: true, run: async cwd => {
		writeFileSync(join(cwd, "app.txt"), "after\n");
	}});
	chmodSync(join(run.path, "app.txt"), 0o755);
	const result = cleanup(run.runId, { repoRoot: repo, patch: run.patch });
	expect(result.removed).toBe(false);
	expect(statSync(join(run.path, "app.txt")).mode & 0o111).toBe(0o111);
});

it("retains unmerged index entries and conflict contents", async () => {
	const repo = scratchRepo({ "app.txt": "base\n" });
	git(repo, ["checkout", "-b", "other"]);
	writeFileSync(join(repo, "app.txt"), "theirs\n");
	git(repo, ["commit", "-am", "other change"]);
	git(repo, ["checkout", "main"]);
	writeFileSync(join(repo, "app.txt"), "ours\n");
	git(repo, ["commit", "-am", "main change"]);
	const run = await runIsolated("unmerged", { repoRoot: repo, permissions, run: async cwd => {
		expect(() => git(cwd, ["merge", "--no-edit", "other"])).toThrow();
	}});
	expect(run.cleanup?.removed).toBe(false);
	expect(run.cleanup && !run.cleanup.removed ? run.cleanup.reason : "").toMatch(/unmerged/i);
	expect(git(run.path, ["ls-files", "--unmerged"])).toContain("app.txt");
	expect(readFileSync(join(run.path, "app.txt"), "utf8")).toContain("<<<<<<<");
});
