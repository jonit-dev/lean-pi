/**
 * The bundled skill pack at runtime (PRD-026 Phase 2).
 *
 * Three functions and no state machine: where the packaged `skills/` directory
 * is, what the lock says about it, and whether a file's bytes are the bytes the
 * lock pinned. The integrity check is a hard gate — a bundled body that cannot
 * be proven to be the vendored bytes is not returned, not skipped, and not
 * resolved from another root.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackFile {
	path: string;
	sha256: string;
	bytes: number;
}

export interface PackEntry {
	name: string;
	source: string;
	version: string;
	files: PackFile[];
	licence: string;
	attribution: string;
	syncedAt: string;
}

export interface PackLock {
	version: number;
	skills: PackEntry[];
}

export const PACK_LOCK_FILE = "pack.lock.json";

/**
 * The packaged `skills/` directory, resolved relative to this module rather
 * than to `process.cwd()`, so it works from `node_modules` and from `dist/`.
 */
export function bundledRoot(moduleUrl: string = import.meta.url): string {
	const here = dirname(fileURLToPath(moduleUrl));
	// `src/skills/` when running from source, `dist/skills/` after a build; the
	// pack ships at the package root in both cases.
	for (let dir = here, depth = 0; depth < 4; depth += 1, dir = dirname(dir)) {
		const candidate = join(dir, "skills", PACK_LOCK_FILE);
		if (existsSync(candidate)) return join(dir, "skills");
	}
	return resolve(here, "../../skills");
}

const cache = new Map<string, PackLock | null>();

/** Parsed once per pack root per process. */
export function packLock(root: string = bundledRoot()): PackLock | null {
	const cached = cache.get(root);
	if (cached !== undefined) return cached;
	const path = join(root, PACK_LOCK_FILE);
	const lock = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as PackLock) : null;
	cache.set(root, lock);
	return lock;
}

export function clearPackCache(): void {
	cache.clear();
}

export function packEntries(root: string = bundledRoot()): PackEntry[] {
	return packLock(root)?.skills ?? [];
}

/** The pinned version `/skills` reports for a bundled row. */
export function packVersion(name: string, root: string = bundledRoot()): string | null {
	return packEntries(root).find((entry) => entry.name === name)?.version ?? null;
}

export class BundledIntegrityError extends Error {
	constructor(
		readonly path: string,
		readonly expected: string | null,
		readonly actual: string,
	) {
		super(
			expected === null
				? `Bundled skill file ${path} has no entry in ${PACK_LOCK_FILE} (actual sha256 ${actual}); refusing to load unvendored bytes.`
				: `Bundled skill file ${path} sha256 ${actual} does not match ${PACK_LOCK_FILE} ${expected}; refusing to load tampered bytes.`,
		);
		this.name = "BundledIntegrityError";
	}
}

/**
 * Hash `absolutePath` and compare it to the lock. Throws on mismatch, on a
 * missing entry and on an unreadable lock — every "cannot prove it" case is the
 * same hard failure, because a warning here is a supply-chain hole.
 */
export function verifyBundledFile(absolutePath: string, root: string = bundledRoot()): void {
	const lock = packLock(root);
	const relPath = relative(root, absolutePath).split(sep).join("/");
	const actual = existsSync(absolutePath) ? createHash("sha256").update(readFileSync(absolutePath)).digest("hex") : "";
	if (!lock) throw new BundledIntegrityError(relPath, null, actual);
	const entry = lock.skills.flatMap((skill) => skill.files).find((file) => file.path === relPath);
	if (!entry) throw new BundledIntegrityError(relPath, null, actual);
	if (entry.sha256 !== actual) throw new BundledIntegrityError(relPath, entry.sha256, actual);
}

/** Whether a path lives inside the pack, which is what selects the gate. */
export function isBundledPath(absolutePath: string, root: string = bundledRoot()): boolean {
	const rel = relative(root, absolutePath);
	return rel.length > 0 && !rel.startsWith("..") && !resolve(rel).startsWith(sep);
}
