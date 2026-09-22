/**
 * PRD-022 E5/E6 — worktree isolation, deterministic surfacing and cleanup
 * (AC-6, AC-7, AC-8).
 *
 * Every case runs against a scratch repository created by the spec, never the
 * operator's checkout: the destructive paths here are the ones the HIGH risk
 * override exists to cover, and a test that could delete real work would be
 * worse than no test. The isolation claim is proved by observation — `git status`
 * in the main checkout during and after the run — not by asserting which
 * directory the executor was handed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LeanPiConfig } from "../../src/core/types.js";
import { applyPatch, cleanup, PatchAlreadyAppliedError, pruneOrphans, runIsolated, surfacePatch, worktreeRoot, worktreeRootOf } from "../../src/runtime/index.js";
import { verifyTask } from "../../src/verify/index.js";
import type { EvidenceRecord } from "../../src/verify/evidence.js";
import { workspaceHash } from "../../src/verify/hash.js";
import { git, gitStatus, gitWorktreePaths, permissionConfig, runtimeContract, scratchRepo, sha256File, sha256Text } from "./support.js";
import { tempDir } from "../helpers/fixtures.js";

const BASE_FILE = "src/app.ts";
const BASE_CONTENT = "export const version = 1;\n";

describe("AC-6 — a bounded execution in a worktree leaves the main checkout untouched", () => {
	it("edits tracked and untracked files, and the main checkout never sees them", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT, "README.md": "scratch\n" });
		let statusDuringRun = "";

		const run = await runIsolated("run-1", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			async run(cwd) {
				// Two shapes of change: one tracked edit, one new file.
				writeFileSync(join(cwd, BASE_FILE), "export const version = 2;\n");
				writeFileSync(join(cwd, "src/added.ts"), "export const added = true;\n");
				statusDuringRun = gitStatus(repo);
				expect(cwd).not.toBe(repo);
			},
		});

		// The observable claim: the run's edits are absent from the main checkout.
		expect(statusDuringRun).toBe("");
		expect(gitStatus(repo)).toBe("");
		expect(readFileSync(join(repo, BASE_FILE), "utf8")).toBe(BASE_CONTENT);
		expect(existsSync(join(repo, "src/added.ts"))).toBe(false);

		// The patch is keyed by the run and holds exactly what the executor changed.
		expect(run.runId).toBe("run-1");
		expect(run.patch.paths).toEqual(["src/added.ts", BASE_FILE]);
		expect(run.patch.baseCommit).toBe(git(repo, ["rev-parse", "HEAD"]).trim());
		expect(run.patch.diff).toContain("+export const version = 2;");
		expect(run.patch.untracked).toEqual([{ path: "src/added.ts", content: "export const added = true;\n", encoding: "utf8" }]);
		expect(run.cleanup).toEqual({ removed: true, path: run.path });
	});

	it("places the worktree under the configured run root", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		expect(worktreeRootOf(undefined, repo)).toBe(join(repo, ".worktrees"));
		const configured = worktreeRootOf({ workspace: { worktreeRoot: ".worktrees/custom" } } as unknown as LeanPiConfig, repo);
		expect(configured).toBe(join(repo, ".worktrees/custom"));

		const run = await runIsolated("run-configured", {
			repoRoot: repo,
			root: configured,
			permissions: permissionConfig("git_destructive", "allow"),
			async run(cwd) {
				writeFileSync(join(cwd, BASE_FILE), "export const version = 12;\n");
			},
		});

		expect(run.path).toBe(join(repo, ".worktrees/custom", "run-configured"));
		expect(run.cleanup?.removed).toBe(true);
		expect(readdirSync(configured)).toEqual([]);
		expect(gitWorktreePaths(repo)).toEqual([repo]);
		expect(gitStatus(repo)).toBe("");
	});

	it("stamps evidence collected in the worktree with that tree's state, not the main checkout's", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		const mainHash = workspaceHash(repo, []);
		let record: EvidenceRecord | undefined;
		let worktreeHash = "";

		const run = await runIsolated("run-provenance", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			async run(cwd) {
				writeFileSync(join(cwd, BASE_FILE), "export const version = 11;\n");
				worktreeHash = workspaceHash(cwd, []);
				// The session's verification, pointed at the worktree: this is what makes
				// the record describe the tree the evidence came from.
				const verified = await verifyTask(runtimeContract({ required: ["git_status"] }), cwd, {});
				record = verified.records.find((entry) => entry.kind === "git_status");
			},
		});

		expect(record?.status).toBe("pass");
		// Stamped with the isolated tree's state while it existed, never the main
		// checkout's — a fresh label on stale evidence is exactly what this prevents.
		expect(record?.workspaceHash).toBe(worktreeHash);
		expect(record?.workspaceHash).not.toBe(mainHash);
		expect(run.cleanup?.removed).toBe(true);
	});

	it("still surfaces a patch and cleans up when the executor throws", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });

		await expect(
			runIsolated("run-throws", {
				repoRoot: repo,
				permissions: permissionConfig("git_destructive", "allow"),
				async run(cwd) {
					writeFileSync(join(cwd, BASE_FILE), "export const version = 3;\n");
					throw new Error("the executor gave up");
				},
			}),
		).rejects.toThrow("the executor gave up");

		expect(gitStatus(repo)).toBe("");
		expect(gitWorktreePaths(repo)).toEqual([repo]);
		expect(gitWorktreePaths(repo)).toHaveLength(1);
	});
});

describe("AC-7 — the surfaced patch reproduces the worktree byte for byte", () => {
	it("applies to a clean checkout with matching content hashes, and refuses a second apply", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT, "README.md": "scratch\n" });
		// The worktree's own hashes, read while it is still alive, are the yardstick.
		let liveHashes: Record<string, string> = {};

		const run = await runIsolated("run-apply", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			async run(cwd) {
				writeFileSync(join(cwd, BASE_FILE), "export const version = 9;\n");
				writeFileSync(join(cwd, "src/added.ts"), "export const added = 9;\n");
				// A nested directory the base commit does not have.
				mkdirSync(join(cwd, "docs"), { recursive: true });
				writeFileSync(join(cwd, "docs/note.md"), "# note\n");
				liveHashes = Object.fromEntries(
					["src/added.ts", "docs/note.md", BASE_FILE].map((path) => [path, sha256File(join(cwd, path))]),
				);
			},
		});

		expect(run.patch.hashes).toEqual(liveHashes);

		const clean = scratchRepo({ [BASE_FILE]: BASE_CONTENT, "README.md": "scratch\n" });
		const applied = applyPatch(run.patch, clean);
		expect(applied.paths).toEqual(run.patch.paths);
		for (const path of run.patch.paths) {
			expect(sha256File(join(clean, path))).toBe(run.patch.hashes[path]);
			expect(sha256Text(readFileSync(join(clean, path), "utf8"))).toBe(liveHashes[path]);
		}
		// The tracked edit really replaced the file, and the untracked content is verbatim.
		expect(readFileSync(join(clean, BASE_FILE), "utf8")).toBe("export const version = 9;\n");
		expect(readFileSync(join(clean, "docs/note.md"), "utf8")).toBe("# note\n");
		// The checkout now holds the run's work as uncommitted changes — surfacing is
		// a separate, explicit step from committing it.
		expect(gitStatus(clean).split("\n").sort()).toEqual([" M src/app.ts", "?? docs/", "?? src/added.ts"]);

		// Applying it twice is rejected rather than silently duplicating the work.
		expect(() => applyPatch(run.patch, clean)).toThrow(PatchAlreadyAppliedError);
		expect(() => applyPatch(run.patch, clean)).toThrow("was already applied");
		expect(readFileSync(join(clean, BASE_FILE), "utf8")).toBe("export const version = 9;\n");
	});

	it("records a deletion as an absent path", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT, "src/old.ts": "export const old = true;\n" });

		const run = await runIsolated("run-delete", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			async run(cwd) {
				rmSync(join(cwd, "src/old.ts"));
			},
		});

		expect(run.patch.paths).toEqual(["src/old.ts"]);
		expect(run.patch.hashes["src/old.ts"]).toBe("deleted");

		const clean = scratchRepo({ [BASE_FILE]: BASE_CONTENT, "src/old.ts": "export const old = true;\n" });
		applyPatch(run.patch, clean);
		expect(existsSync(join(clean, "src/old.ts"))).toBe(false);
		expect(gitStatus(clean)).toBe(" D src/old.ts");
	});
});

describe("AC-8 — cleanup, including the crash path", () => {
	it("leaves only the main checkout after a normal completion", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		const runRoot = worktreeRoot(repo);

		const run = await runIsolated("run-clean", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			async run(cwd) {
				writeFileSync(join(cwd, BASE_FILE), "export const version = 4;\n");
			},
		});

		expect(run.cleanup?.removed).toBe(true);
		expect(existsSync(run.path)).toBe(false);
		expect(gitWorktreePaths(repo)).toEqual([repo]);
		expect(readdirSync(runRoot)).toEqual([]);
		// A detached HEAD leaves no branch behind.
		expect(git(repo, ["branch", "--list", "--format=%(refname:short)"]).split("\n").filter((line) => line.length > 0)).toEqual(["main"]);
	});

	it("reclaims an orphan left by a killed executor, preserving its patch", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		const runRoot = worktreeRoot(repo);

		// `keep` is what a killed executor leaves behind: the worktree exists, the
		// session never reached its cleanup.
		const orphan = await runIsolated("run-orphan", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			keep: true,
			async run(cwd) {
				writeFileSync(join(cwd, BASE_FILE), "export const version = 5;\n");
				writeFileSync(join(cwd, "src/half-written.ts"), "export const half = true;\n");
			},
		});
		expect(orphan.cleanup).toBeUndefined();
		expect(existsSync(orphan.path)).toBe(true);

		// A live run is not touched; the orphan is, at the next session start.
		expect(pruneOrphans({ repoRoot: repo, liveRunIds: ["run-orphan"] })).toEqual([]);
		expect(existsSync(orphan.path)).toBe(true);

		const reclaimed = pruneOrphans({ repoRoot: repo });
		expect(reclaimed).toEqual([
			{ runId: "run-orphan", path: orphan.path, removed: true, patchPath: join(runRoot, "run-orphan.patch.json") },
		]);
		// Same clean state as a normal completion.
		expect(existsSync(orphan.path)).toBe(false);
		expect(gitWorktreePaths(repo)).toEqual([repo]);
		expect(gitStatus(repo)).toBe("");
		expect(readdirSync(runRoot)).toEqual(["run-orphan.patch.json"]);
		// The reclaimed run's work survived its directory.
		const preserved = JSON.parse(readFileSync(join(runRoot, "run-orphan.patch.json"), "utf8")) as { paths: string[]; diff: string };
		expect(preserved.paths).toEqual([BASE_FILE, "src/half-written.ts"]);
		expect(preserved.diff).toContain("+export const version = 5;");
	});

	it("refuses to remove a worktree holding a change the surfaced patch does not represent", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });

		const kept = await runIsolated("run-refused", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			keep: true,
			async run(cwd) {
				writeFileSync(join(cwd, BASE_FILE), "export const version = 6;\n");
			},
		});
		// A write that lands after the patch was surfaced: nothing it says covers this.
		writeFileSync(join(kept.path, "src/late.ts"), "export const late = true;\n");

		const result = cleanup("run-refused", { repoRoot: repo, patch: kept.patch });

		expect(result.removed).toBe(false);
		if (result.removed) throw new Error("unreachable");
		expect(result.paths).toEqual(["src/late.ts"]);
		expect(result.reason).toContain("does not represent");
		// Refused means refused: the directory and the unrepresented work are still there.
		expect(existsSync(join(kept.path, "src/late.ts"))).toBe(true);
		expect(gitWorktreePaths(repo)).toEqual([repo, kept.path]);

		// The same worktree with a patch that does cover it is reclaimed.
		const covering = surfacePatch("run-refused", { repoRoot: repo });
		expect(covering.paths).toEqual([BASE_FILE, "src/late.ts"]);
		expect(cleanup("run-refused", { repoRoot: repo, patch: covering }).removed).toBe(true);
		expect(gitWorktreePaths(repo)).toEqual([repo]);
	});

	it("refuses to remove a worktree that changed after its patch was surfaced", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });

		const kept = await runIsolated("run-drift", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			keep: true,
			async run(cwd) {
				writeFileSync(join(cwd, BASE_FILE), "export const version = 7;\n");
			},
		});
		writeFileSync(join(kept.path, BASE_FILE), "export const version = 8;\n");

		const result = cleanup("run-drift", { repoRoot: repo, patch: kept.patch });

		expect(result.removed).toBe(false);
		if (result.removed) throw new Error("unreachable");
		expect(result.paths).toEqual([BASE_FILE]);
		expect(result.reason).toContain("changed after its patch was surfaced");
		expect(readFileSync(join(kept.path, BASE_FILE), "utf8")).toBe("export const version = 8;\n");
	});

	it("refuses to remove a committed worktree rather than discarding its commits", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });

		const kept = await runIsolated("run-commit", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			keep: true,
			async run(cwd) {
				writeFileSync(join(cwd, BASE_FILE), "export const version = 10;\n");
				git(cwd, ["add", "-A"]);
				git(cwd, ["commit", "-q", "-m", "executor commit"]);
			},
		});

		const result = cleanup("run-commit", { repoRoot: repo, patch: kept.patch });

		expect(result.removed).toBe(false);
		if (result.removed) throw new Error("unreachable");
		expect(result.commits).toHaveLength(1);
		expect(result.reason).toContain("commit(s) the surfaced patch does not represent");
		expect(existsSync(kept.path)).toBe(true);
	});

	it("surfaces one complete diff that creates new files too", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		const run = await runIsolated("run-complete", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			async run(cwd) {
				writeFileSync(join(cwd, BASE_FILE), "export const version = 2;\n");
				writeFileSync(join(cwd, "src", "added.ts"), "export const added = true;\n");
			},
		});
		expect(run.patch.completeDiff).toBeDefined();
		expect(run.patch.completeDiff).toContain("src/added.ts");
		// The one displayed command applies the whole result to a fresh checkout.
		const clean = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		execFileSync("git", ["apply", "--binary", "-"], { cwd: clean, input: run.patch.completeDiff! });
		expect(readFileSync(join(clean, BASE_FILE), "utf8")).toBe("export const version = 2;\n");
		expect(readFileSync(join(clean, "src", "added.ts"), "utf8")).toBe("export const added = true;\n");
	});

	it("creates a new-files-only result through the complete diff", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		const run = await runIsolated("run-new-only", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			async run(cwd) {
				writeFileSync(join(cwd, "src", "brand-new.ts"), "export const fresh = true;\n");
			},
		});
		// The tracked-only diff is empty; the complete diff is what makes the
		// result applicable at all.
		expect(run.patch.diff.trim()).toBe("");
		expect(run.patch.completeDiff).toBeDefined();
		const clean = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		execFileSync("git", ["apply", "--binary", "-"], { cwd: clean, input: run.patch.completeDiff! });
		expect(readFileSync(join(clean, "src", "brand-new.ts"), "utf8")).toBe("export const fresh = true;\n");
	});

	it("refuses a conflicting apply without partially applying tracked edits", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		const kept = await runIsolated("run-conflict", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			keep: true,
			async run(cwd) {
				writeFileSync(join(cwd, BASE_FILE), "export const version = 2;\n");
				writeFileSync(join(cwd, "src", "new.ts"), "from the run\n");
			},
		});
		const target = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		// Only the new file conflicts: the tracked edit would apply cleanly, so a
		// partial apply would be visible as the tracked file changing.
		writeFileSync(join(target, "src", "new.ts"), "the user already wrote this\n");

		expect(() => applyPatch(kept.patch, target)).toThrow();
		// Refused means nothing changed: the tracked edit did not land and the
		// user's file still holds their content.
		expect(readFileSync(join(target, BASE_FILE), "utf8")).toBe(BASE_CONTENT);
		expect(readFileSync(join(target, "src", "new.ts"), "utf8")).toBe("the user already wrote this\n");
	});

	it("refuses a patch path that escapes the target", () => {
		const target = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		// A unique name, so a leftover from another run cannot mask the assertion.
		const escapeName = `leanpi-escape-${process.pid}-${Date.now()}.txt`;
		const escaped = join(target, "..", escapeName);
		const malicious = {
			runId: "run-escape",
			baseCommit: git(target, ["rev-parse", "HEAD"]).trim(),
			diff: "",
			untracked: [{ path: `../${escapeName}`, content: "pwned\n", encoding: "utf8" as const }],
			paths: [`../${escapeName}`],
			hashes: {},
		};
		try {
			expect(() => applyPatch(malicious, target)).toThrow(/escapes|relative path/);
			expect(existsSync(escaped)).toBe(false);
		} finally {
			rmSync(escaped, { force: true });
		}
	});

	it("confines every run root to the owning repository", () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		expect(() => worktreeRoot(repo, "/tmp/leanpi-outside")).toThrow("escapes the owning repository");
		expect(() => worktreeRoot(repo, "../sibling"), "a relative climb").toThrow("escapes the owning repository");
		// A custom relative root inside the repo is still allowed.
		expect(worktreeRoot(repo, ".worktrees/custom")).toBe(join(repo, ".worktrees/custom"));
	});

	it("refuses a root whose existing ancestor symlinks outside the repository", () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		const outside = tempDir("leanpi-outside-");
		symlinkSync(outside, join(repo, "escape"), "dir");
		expect(() => worktreeRoot(repo, "escape/runs")).toThrow("escapes the owning repository");
	});

	it("leaves sibling unowned worktrees and a live owned run untouched", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		const runRoot = worktreeRoot(repo);
		// A developer's own registered worktree under the shared root, with no stamp.
		const sibling = join(runRoot, "sibling-dev");
		git(repo, ["worktree", "add", "--detach", sibling, "HEAD"]);
		writeFileSync(join(sibling, "src", "sibling.ts"), "export const sibling = 1;\n");
		// A plain directory that is not a worktree at all.
		mkdirSync(join(runRoot, "not-a-worktree"), { recursive: true });
		// A live owned run: ownership stamp plus a registered checkout, but running.
		const live = await runIsolated("run-live", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			keep: true,
			async run(cwd) {
				writeFileSync(join(cwd, BASE_FILE), "export const version = 30;\n");
			},
		});

		expect(pruneOrphans({ repoRoot: repo, liveRunIds: ["run-live"] })).toEqual([]);
		expect(existsSync(sibling)).toBe(true);
		expect(readFileSync(join(sibling, "src", "sibling.ts"), "utf8")).toBe("export const sibling = 1;\n");
		expect(existsSync(join(runRoot, "not-a-worktree"))).toBe(true);
		expect(existsSync(live.path)).toBe(true);

		// Cleanup refuses a clean worktree with no ownership stamp rather than
		// force-removing work this module never created.
		const refused = cleanup("sibling-dev", { repoRoot: repo });
		expect(refused.removed).toBe(false);
		if (refused.removed) throw new Error("unreachable");
		expect(refused.reason).toContain("no ownership stamp");
		expect(existsSync(sibling)).toBe(true);
	});

	it("surfaces untracked names with spaces and a leading dash through ls-files -z", async () => {
		const repo = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		const run = await runIsolated("run-weird", {
			repoRoot: repo,
			permissions: permissionConfig("git_destructive", "allow"),
			async run(cwd) {
				writeFileSync(join(cwd, "weird name.txt"), "hello\n");
				writeFileSync(join(cwd, "-dash.txt"), "dash\n");
			},
		});
		expect(run.patch.untracked.map((file) => file.path).sort()).toEqual(["-dash.txt", "weird name.txt"]);
		expect(run.patch.paths).toEqual(["-dash.txt", "weird name.txt"]);
	});

	it("owns a run started from a linked checkout under the primary repository", async () => {
		const primary = scratchRepo({ [BASE_FILE]: BASE_CONTENT });
		const linked = join(tempDir("leanpi-linked-"), "checkout");
		// A linked checkout, as an agent's own task worktree would be.
		git(primary, ["worktree", "add", "--detach", linked, "HEAD"]);

		expect(worktreeRoot(linked, undefined)).toBe(join(primary, ".worktrees"));

		const run = await runIsolated("run-linked", {
			repoRoot: linked,
			permissions: permissionConfig("git_destructive", "allow"),
			async run(cwd) {
				writeFileSync(join(cwd, BASE_FILE), "export const version = 21;\n");
			},
		});

		// The worktree is owned by the primary repository, and never nested under
		// the linked checkout that started the run.
		expect(run.path).toBe(join(primary, ".worktrees", "run-linked"));
		expect(run.cleanup?.removed).toBe(true);
		expect(existsSync(join(linked, ".worktrees"))).toBe(false);
		expect(readFileSync(join(primary, BASE_FILE), "utf8")).toBe(BASE_CONTENT);
	});
});
