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
import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { isAbsolute, join } from "node:path";
import { porcelainPaths, readPorcelain, readTreeHash } from "../runtime/git.js";

/** Directories that are not workspace source; the fallback scan never descends into them. */
const SCAN_SKIP = new Set([".git", "node_modules", ".leanpi"]);
/** ponytail: bounded fallback scan; raise it if a non-git workspace ever exceeds it. */
const SCAN_LIMIT = 5_000;

/**
 * Every workspace file, sorted, for the one case git cannot name a scope: no
 * repository (or no git) and no touched path. Without it two different source
 * states hash the same and stale evidence reads as fresh.
 */
function workspaceFiles(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string, prefix: string): void => {
		if (found.length >= SCAN_LIMIT) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.isSymbolicLink() || SCAN_SKIP.has(entry.name)) continue;
			const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) walk(join(dir, entry.name), relative);
			else if (entry.isFile()) found.push(relative);
		}
	};
	walk(root, "");
	return found;
}

/**
 * The paths a hash covers: the touched set plus git's dirty set, or every
 * workspace file when git is unavailable and the caller named no scope.
 */
export function workspaceScope(root: string, touchedPaths: readonly string[] = []): string[] {
	const porcelain = readPorcelain(root);
	const dirty = porcelain === null ? [] : porcelainPaths(porcelain);
	// Git cannot name a file scope and the caller named none: the workspace itself
	// is the only identity left, so hash it rather than call two states equal.
	const scope = porcelain === null && touchedPaths.length === 0 ? workspaceFiles(root) : [...touchedPaths, ...dirty];
	return [...new Set(scope)].filter((path) => path.length > 0).sort();
}

/**
 * Deterministic hash of the tracked+dirty workspace state plus the given touched
 * paths: the tracked tree's identity, git's dirty listing, and sorted
 * `(path, size, sha256(content))` tuples over `scope` (computed here unless the
 * caller pinned it). A path that is absent contributes a `missing` marker —
 * absence is part of the state, not an error. Throws only on an unexpected read
 * failure; `verifyTask` turns that into an `error` record rather than a thrown
 * turn.
 */
export function workspaceHash(root: string, touchedPaths: readonly string[] = [], scope?: readonly string[]): string {
	const porcelain = readPorcelain(root);
	const paths = scope === undefined ? workspaceScope(root, touchedPaths) : [...scope].sort();

	const digest = createHash("sha256");
	digest.update(`git:${porcelain === null ? "unavailable" : "ok"}\0`);
	if (porcelain !== null) digest.update(`${porcelain}\0`);
	// The tracked tree's identity: a clean commit contributes its source bytes,
	// which the dirty listing alone cannot see.
	digest.update(`tree:${readTreeHash(root) ?? "unavailable"}\0`);

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
