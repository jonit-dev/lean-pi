/**
 * Workspace freshness stamping (PRD-009 Phase 1, FR-121).
 *
 * `workspaceHash` is the identity of the workspace state an evidence record was
 * collected against. It is content-based on purpose: two checkouts of the same
 * bytes hash the same no matter what mtimes the filesystem handed out, while a
 * single byte of change in any tracked or touched file changes the hash. That
 * equality is what `EvidenceStore.view()` compares to call a record fresh.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * The dirty/tracked file set as git reports it, or `null` when git cannot run
 * (not a repository, git absent) or does not answer within the timeout — on a
 * very large repository this degrades to the touched paths alone rather than
 * blocking the turn. The hash then covers less; it never throws.
 */
function gitPorcelain(root: string): string | null {
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

/** Porcelain lines are `XY <path>` with `R  old -> new` for renames and quoted odd paths. */
function porcelainPaths(porcelain: string): string[] {
	const paths: string[] = [];
	for (const line of porcelain.split("\n")) {
		if (line.trim().length === 0) continue;
		const body = line.slice(3);
		const target = body.includes(" -> ") ? body.split(" -> ").pop()! : body;
		paths.push(target.startsWith('"') && target.endsWith('"') ? target.slice(1, -1) : target);
	}
	return paths;
}

/**
 * Deterministic hash of the tracked+dirty workspace state plus the given touched
 * paths: sorted `(path, size, sha256(content))` tuples over the union of git's
 * dirty set and the task's touched paths, with the porcelain listing itself
 * mixed in. A path that is absent contributes a `missing` marker — absence is
 * part of the state, not an error. Throws only on an unexpected read failure;
 * `verifyTask` turns that into an `error` record rather than a thrown turn.
 */
export function workspaceHash(root: string, touchedPaths: readonly string[] = []): string {
	const porcelain = gitPorcelain(root);
	const dirty = porcelain === null ? [] : porcelainPaths(porcelain);
	const paths = [...new Set([...touchedPaths, ...dirty])].map((path) => path.trim()).filter((path) => path.length > 0).sort();

	const digest = createHash("sha256");
	digest.update(`git:${porcelain === null ? "unavailable" : "ok"}\0`);
	if (porcelain !== null) digest.update(`${porcelain}\0`);

	for (const path of paths) {
		const absolute = isAbsolute(path) ? path : join(root, path);
		let size = "-";
		let content = "missing";
		try {
			const bytes = readFileSync(absolute);
			size = String(bytes.byteLength);
			content = createHash("sha256").update(bytes).digest("hex");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				if (code !== "EISDIR" && code !== "EACCES" && code !== "EPERM") throw error;
				// ponytail: a directory in the touched set folds in as its unreadable
				// marker, not a recursive walk. Upgrade only if a contract ever names
				// a directory as its verification surface.
				content = `unreadable:${code}`;
			}
		}
		digest.update(`${path}\0${size}\0${content}\0`);
	}
	return digest.digest("hex");
}
