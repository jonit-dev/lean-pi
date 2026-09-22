/**
 * Git workspace state (PRD-007 change detection, PRD-009 freshness stamping).
 *
 * One porcelain reader and one porcelain parser, so `workspaceHash` and the
 * executor's change set cannot disagree about what git reported. `changeSnapshot`
 * is the dirty set keyed by path with a content hash: taken before and after a
 * worker run, it answers "what did this turn change" without trusting the
 * worker's own claim and without asking the packet which files to look at.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Raw `git status --porcelain`, or `null` when git cannot run (not a
 * repository, git absent) or does not answer within the timeout. Never throws:
 * a workspace without git degrades to "unknown", it does not fail a turn.
 */
export function readPorcelain(root: string): string | null {
	try {
		return execFileSync("git", ["status", "--porcelain"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		});
	} catch {
		return null;
	}
}

/** Porcelain lines are `XY <path>`, with `R  old -> new` for renames and quoted odd paths. */
export function porcelainPaths(porcelain: string): string[] {
	const paths: string[] = [];
	for (const line of porcelain.split("\n")) {
		if (line.trim().length === 0) continue;
		const body = line.slice(3);
		const target = body.includes(" -> ") ? body.split(" -> ").pop()! : body;
		paths.push(target.startsWith('"') && target.endsWith('"') ? target.slice(1, -1) : target);
	}
	return paths;
}

/** The dirty set keyed by path with its content hash; `null` when git is unavailable. */
export type ChangeSnapshot = Map<string, string>;

export function changeSnapshot(root: string): ChangeSnapshot | null {
	const porcelain = readPorcelain(root);
	if (porcelain === null) return null;
	const snapshot: ChangeSnapshot = new Map();
	for (const path of porcelainPaths(porcelain)) snapshot.set(path, contentHash(root, path));
	return snapshot;
}

/**
 * Paths that appeared, disappeared, or changed content since `before` — the
 * turn's own change set, with pre-existing dirty work that was not touched
 * excluded. `null` when git cannot answer now; the caller must treat that as
 * unknown rather than as "nothing changed".
 */
export function changedPathsSince(before: ChangeSnapshot, root: string): string[] | null {
	const after = changeSnapshot(root);
	if (after === null) return null;
	const changed = new Set<string>();
	for (const [path, hash] of after) if (before.get(path) !== hash) changed.add(path);
	for (const path of before.keys()) if (!after.has(path)) changed.add(path);
	return [...changed].sort();
}

function contentHash(root: string, path: string): string {
	const absolute = isAbsolute(path) ? path : join(root, path);
	try {
		return createHash("sha256").update(readFileSync(absolute)).digest("hex");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return "missing";
		if (code === "EISDIR" || code === "EACCES" || code === "EPERM") return `unreadable:${code}`;
		throw error;
	}
}
