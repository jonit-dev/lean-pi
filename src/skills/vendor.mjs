#!/usr/bin/env node
/**
 * The one vendoring implementation in the repository (PRD-026 Phase 1).
 *
 * Both the Ponytail prefix (PRD-001, a single `kind: "prefix"` entry) and the
 * bundled skill pack call this core: resolve an upstream through a discovery
 * order that never hard-codes a machine path, copy an allowlist of files with
 * symlinked directories resolved through `realpath`, hash every copied byte,
 * resolve a version and a licence, and write a lock.
 *
 * It is `.mjs` and not TypeScript because it runs from `scripts/` without a
 * build step, exactly like the script PRD-001 shipped.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Discovery order, highest first: an explicit flag, the environment override,
 * `$CLAUDE_PLUGIN_ROOT`, then `$HOME/.claude`. A shipped file never contains an
 * absolute machine path, which is why the lock stores the portable form below.
 */
export function resolveSourceRoot({ sourceFlag, env = process.env, home = homedir(), envVar = "LEANPI_SKILL_SOURCE" } = {}) {
	const explicit = sourceFlag ?? env[envVar];
	if (explicit) return existsSync(explicit) ? resolve(explicit) : undefined;
	const candidates = [env.CLAUDE_PLUGIN_ROOT ? dirname(env.CLAUDE_PLUGIN_ROOT) : undefined, home ? join(home, ".claude") : undefined].filter(Boolean);
	return candidates.find((candidate) => existsSync(candidate));
}

/** The lock must not carry a machine-specific absolute path. */
export function portableSource(sourcePath, { env = process.env, home = homedir() } = {}) {
	if (env.CLAUDE_PLUGIN_ROOT && sourcePath.startsWith(env.CLAUDE_PLUGIN_ROOT)) return sourcePath.replace(env.CLAUDE_PLUGIN_ROOT, "$CLAUDE_PLUGIN_ROOT");
	if (home && sourcePath.startsWith(home)) return sourcePath.replace(home, "$HOME");
	return sourcePath;
}

/** `SKILL.md`, `scripts/**`, `agents/**` — patterns, not an import graph. */
export function matchesAllowlist(relPath, allowlist) {
	const normalized = relPath.split(sep).join("/");
	return allowlist.some((pattern) => {
		if (pattern.endsWith("/**")) return normalized.startsWith(`${pattern.slice(0, -3)}/`);
		return normalized === pattern;
	});
}

/** Every allowlisted file under `root`, symlinked directories resolved. */
export function collectFiles(root, allowlist) {
	const real = realpathSync(root);
	const found = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const abs = join(dir, entry.name);
			const resolved = entry.isSymbolicLink() ? realpathSync(abs) : abs;
			const rel = relative(real, abs);
			if (statSync(resolved).isDirectory()) {
				// Descend only where the allowlist can still match, so an upstream
				// bundle's unrelated trees are never walked.
				if (allowlist.some((pattern) => pattern.startsWith(`${rel.split(sep).join("/")}/`) || pattern.startsWith(`${rel.split(sep).join("/")}/**`.slice(0, -2)))) walk(abs);
				continue;
			}
			if (matchesAllowlist(rel, allowlist)) found.push({ rel: rel.split(sep).join("/"), abs: resolved });
		}
	};
	walk(real);
	return found;
}

/** Frontmatter `license:` → upstream `LICENSE` → the spec's declaration. */
export function resolveLicence(entry, sourceDir, skillBody) {
	const declared = /^license:\s*(.+)$/im.exec(frontmatterOf(skillBody) ?? "");
	if (declared) return { licence: declared[1].trim(), licenceFile: licenceFileIn(sourceDir) };
	const file = licenceFileIn(sourceDir);
	if (file) return { licence: entry.licence ?? "MIT", licenceFile: file };
	if (entry.licence) return { licence: entry.licence, licenceFile: undefined };
	return { licence: undefined, licenceFile: undefined };
}

function licenceFileIn(dir) {
	for (let current = dir, depth = 0; depth < 4; depth += 1, current = dirname(current)) {
		const candidate = join(current, "LICENSE");
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

export function frontmatterOf(body) {
	const match = /^---\n([\s\S]*?)\n---/.exec(body);
	return match ? match[1] : undefined;
}

/** Upstream declared version → plugin-cache path segment → content pin. */
export function resolveVersion(sourceDir, skillBody) {
	const frontmatter = frontmatterOf(skillBody) ?? "";
	const declared = /^version:\s*(.+)$/im.exec(frontmatter);
	if (declared) return declared[1].trim();
	const segment = /\/cache\/[^/]+\/[^/]+\/(\d+\.\d+\.\d+)\//.exec(`${sourceDir}/`);
	if (segment) return segment[1];
	return `sha256-${sha256(skillBody).slice(0, 12)}`;
}

export class VendorError extends Error {
	constructor(message) {
		super(message);
		this.name = "VendorError";
	}
}

/**
 * Copy one spec's entries into `destRoot` and return the lock object. Nothing is
 * written until every entry resolves, so a licence-less entry aborts the run
 * with the pack untouched.
 */
export function vendorPack({ spec, sourceRoot, destRoot, now = () => new Date(), previousLock }) {
	const planned = [];
	for (const entry of spec) {
		const sourceDir = resolve(sourceRoot, entry.source);
		if (!existsSync(sourceDir)) throw new VendorError(`upstream for "${entry.name}" not found at ${sourceDir}`);
		const files = collectFiles(sourceDir, entry.allowlist);
		const skill = files.find((file) => file.rel === "SKILL.md");
		if (!skill) throw new VendorError(`upstream for "${entry.name}" has no SKILL.md`);
		const body = readFileSync(skill.abs, "utf8");
		const { licence, licenceFile } = resolveLicence(entry, realpathSync(sourceDir), body);
		if (!licence) throw new VendorError(`no licence resolved for "${entry.name}": declare one in the spec, add a LICENSE upstream, or set frontmatter license:`);
		if (!entry.attribution) throw new VendorError(`no attribution declared for "${entry.name}"`);
		planned.push({ entry, sourceDir, files, body, licence, licenceFile, version: entry.version ?? resolveVersion(realpathSync(sourceDir), body) });
	}

	const lockEntries = [];
	for (const plan of planned) {
		const skillDir = join(destRoot, plan.entry.name);
		rmSync(skillDir, { recursive: true, force: true });
		const files = [];
		for (const file of plan.files) {
			const target = join(skillDir, file.rel);
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(file.abs, target);
			const bytes = readFileSync(target);
			files.push({ path: `${plan.entry.name}/${file.rel}`, sha256: sha256(bytes), bytes: bytes.length });
		}
		if (plan.licenceFile) {
			const target = join(skillDir, "LICENSE");
			copyFileSync(plan.licenceFile, target);
			const bytes = readFileSync(target);
			files.push({ path: `${plan.entry.name}/LICENSE`, sha256: sha256(bytes), bytes: bytes.length });
		}
		files.sort((a, b) => a.path.localeCompare(b.path));
		lockEntries.push({
			name: plan.entry.name,
			source: portableSource(plan.sourceDir),
			version: plan.version,
			files,
			licence: plan.licence,
			attribution: plan.entry.attribution,
			syncedAt: unchangedSince(previousLock, plan.entry.name, files) ?? now().toISOString(),
		});
	}
	lockEntries.sort((a, b) => a.name.localeCompare(b.name));
	return { version: 1, skills: lockEntries };
}

/** Idempotence: an entry whose bytes did not move keeps its original stamp. */
function unchangedSince(previousLock, name, files) {
	const previous = previousLock?.skills?.find((skill) => skill.name === name);
	if (!previous || previous.files.length !== files.length) return undefined;
	const same = previous.files.every((file, index) => file.path === files[index].path && file.sha256 === files[index].sha256);
	return same ? previous.syncedAt : undefined;
}

/** `NOTICE.md`, generated from the lock — never hand-maintained. */
export function renderNotice(lock) {
	const rows = lock.skills.map((skill) => `| \`${skill.name}\` | ${skill.source} | ${skill.version} | ${skill.licence} | ${skill.attribution} |`);
	return [
		"# Bundled skill pack — third-party notices",
		"",
		"Generated by `scripts/sync-skills.mjs` from `skills/pack.lock.json`. Do not edit by hand.",
		"",
		"| Skill | Upstream source | Pinned version | Licence | Attribution |",
		"|---|---|---|---|---|",
		...rows,
		"",
	].join("\n");
}

/**
 * Paths under the pack root that the lock never covers: the pack's own metadata
 * (`NOTICE.md`, the lock itself) and this repository's folder instructions for
 * agents (`AGENTS.md`, `CLAUDE.md`), which are not vendored content. Exported so
 * the pack's coverage rule has exactly one definition.
 */
export const PACK_UNLOCKED = new Set(["pack.lock.json", "NOTICE.md", "AGENTS.md", "CLAUDE.md"]);

/** Recompute every locked hash against the pack on disk. */
export function checkPack({ lock, destRoot }) {
	if (!lock) return { ok: false, reason: "pack.lock.json missing" };
	for (const skill of lock.skills) {
		for (const file of skill.files) {
			const path = join(destRoot, file.path);
			if (!existsSync(path)) return { ok: false, reason: `locked file missing: ${file.path}` };
			const actual = sha256(readFileSync(path));
			if (actual !== file.sha256) return { ok: false, reason: `${file.path} sha256 ${actual} does not match lock ${file.sha256}` };
		}
	}
	const locked = new Set(lock.skills.flatMap((skill) => skill.files.map((file) => file.path)));
	for (const path of listPackFiles(destRoot)) {
		if (PACK_UNLOCKED.has(path)) continue;
		if (!locked.has(path)) return { ok: false, reason: `file under the pack with no lock entry: ${path}` };
	}
	return { ok: true };
}

export function listPackFiles(destRoot) {
	if (!existsSync(destRoot)) return [];
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const abs = join(dir, entry.name);
			if (entry.isDirectory()) walk(abs);
			else out.push(relative(destRoot, abs).split(sep).join("/"));
		}
	};
	walk(destRoot);
	return out.sort();
}

/**
 * The single-file case (PRD-001's Ponytail prefix): the same copy → hash →
 * lock mechanism as the pack, with a one-entry lock shape.
 */
export function vendorFile({ sourcePath, destPath, lockPath, version, now = () => new Date() }) {
	const bytes = readFileSync(sourcePath);
	mkdirSync(dirname(destPath), { recursive: true });
	copyFileSync(sourcePath, destPath);
	const lock = { source: portableSource(sourcePath), version, sha256: sha256(bytes), syncedAt: now().toISOString() };
	writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
	return { lock, bytes: bytes.length };
}

/** Verify one vendored file against its lock, and against upstream when present. */
export function checkFile({ destPath, lockPath, sourcePath }) {
	const lock = readJson(lockPath);
	if (!lock) return { ok: false, reason: "lock file missing" };
	if (!existsSync(destPath)) return { ok: false, reason: `vendored ${destPath} missing` };
	const vendoredHash = sha256(readFileSync(destPath));
	if (vendoredHash !== lock.sha256) return { ok: false, reason: `vendored ${destPath} sha256 ${vendoredHash} does not match lock ${lock.sha256}` };
	if (sourcePath && existsSync(sourcePath)) {
		const upstreamHash = sha256(readFileSync(sourcePath));
		if (upstreamHash !== lock.sha256) return { ok: false, reason: `upstream ${sourcePath} sha256 ${upstreamHash} differs from lock ${lock.sha256}` };
	}
	return { ok: true, lock, vendoredHash };
}

export function writeLock(path, lock) {
	writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
}

export function readJson(path) {
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
