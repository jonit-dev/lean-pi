/**
 * `.leanpi/` must not reach the operator's `git status`, and the exclusion must
 * stay out of the tracked `.gitignore` their collaborators share.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureGitIgnored } from "../../src/runtime/ignore.js";

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "leanpi-ignore-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	return root;
}

function status(root: string): string {
	return execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
}

describe("ensureGitIgnored", () => {
	it("keeps .leanpi out of git status without touching the tracked .gitignore", () => {
		const root = repo();
		mkdirSync(join(root, ".leanpi", "sessions"), { recursive: true });
		writeFileSync(join(root, ".leanpi", "telemetry.jsonl"), "{}\n");
		expect(status(root)).toContain(".leanpi/");

		ensureGitIgnored(root, ".leanpi");

		expect(status(root)).toBe("");
		expect(existsSync(join(root, ".gitignore"))).toBe(false);
		expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toContain(".leanpi/");
	});

	it("is idempotent and writes nothing when a .gitignore already covers the path", () => {
		const root = repo();
		ensureGitIgnored(root, ".leanpi");
		const after = readFileSync(join(root, ".git", "info", "exclude"), "utf8");
		ensureGitIgnored(root, ".leanpi");
		expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toBe(after);

		const covered = repo();
		writeFileSync(join(covered, ".gitignore"), ".leanpi/\n");
		const before = existsSync(join(covered, ".git", "info", "exclude")) ? readFileSync(join(covered, ".git", "info", "exclude"), "utf8") : "";
		ensureGitIgnored(covered, ".leanpi");
		expect(existsSync(join(covered, ".git", "info", "exclude")) ? readFileSync(join(covered, ".git", "info", "exclude"), "utf8") : "").toBe(before);
	});

	it("does nothing outside a repository", () => {
		const root = mkdtempSync(join(tmpdir(), "leanpi-norepo-"));
		expect(() => ensureGitIgnored(root, ".leanpi")).not.toThrow();
		expect(existsSync(join(root, ".git"))).toBe(false);
	});
});
