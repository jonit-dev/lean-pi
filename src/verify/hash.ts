/**
 * Workspace freshness stamping (PRD-009 Phase 1, FR-121).
 *
 * `workspaceHash` is the identity of the workspace state an evidence record was
 * collected against. It is content-based on purpose: two checkouts of the same
 * bytes hash the same no matter what mtimes the filesystem handed out, while a
 * single byte of change in any tracked or touched file changes the hash. That
 * equality is what `EvidenceStore.view()` compares to call a record fresh.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { porcelainPaths, readPorcelain } from "../runtime/git.js";

/**
 * Deterministic hash of the tracked+dirty workspace state plus the given touched
 * paths: sorted `(path, size, sha256(content))` tuples over the union of git's
 * dirty set and the task's touched paths, with the porcelain listing itself
 * mixed in. A path that is absent contributes a `missing` marker — absence is
 * part of the state, not an error. Throws only on an unexpected read failure;
 * `verifyTask` turns that into an `error` record rather than a thrown turn.
 */
export function workspaceHash(root: string, touchedPaths: readonly string[] = []): string {
	const porcelain = readPorcelain(root);
	const dirty = porcelain === null ? [] : porcelainPaths(porcelain);
	const paths = [...new Set([...touchedPaths, ...dirty])].filter((path) => path.length > 0).sort();

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
