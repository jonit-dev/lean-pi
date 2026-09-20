/**
 * Keeping LeanPi's own state out of the operator's `git status`.
 *
 * `.leanpi/` is where sessions, artifacts, telemetry, decisions and worktrees
 * land. In a repository that has never seen LeanPi that is a dozen untracked
 * paths the operator did not create and cannot commit.
 *
 * The exclusion goes in `.git/info/exclude` — this clone only — never in a
 * tracked `.gitignore`: editing a tracked file to clean `git status` would
 * itself dirty `git status`, and the operator did not ask LeanPi to change a
 * file their collaborators share.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Exclude `relativePath` from this clone, unless git already ignores it.
 * Idempotent, and silent when `repoRoot` is not a repository at all.
 */
export function ensureGitIgnored(repoRoot: string, relativePath: string): void {
	if (relativePath.length === 0 || relativePath.startsWith("..")) return;
	const pattern = `${relativePath.split(/[\\/]/).join("/")}/`;
	const git = (args: string[]): string => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	let excludePath: string;
	try {
		// The trailing slash matters: a `.leanpi/` rule does not match the bare
		// name until the directory exists on disk, and this runs before it does.
		git(["check-ignore", "-q", pattern]);
		return; // Already ignored — by .gitignore, by a parent rule, or by us.
	} catch {
		// Not ignored. `check-ignore` also exits non-zero outside a repository,
		// so the git-dir lookup below is what actually decides that case.
	}
	try {
		excludePath = resolve(repoRoot, git(["rev-parse", "--git-common-dir"]).trim(), "info", "exclude");
	} catch {
		return; // Not a repository: nothing to exclude from.
	}
	const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
	if (existing.split("\n").some((line) => line.trim() === pattern)) return;
	mkdirSync(dirname(excludePath), { recursive: true });
	writeFileSync(excludePath, `${existing}${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${pattern}\n`);
}
