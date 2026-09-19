#!/usr/bin/env node
/**
 * Vendor the installed Ponytail instruction bundle into the repository.
 *
 * The bundle is an external, versioned dependency (ROADMAP §6.1): LeanPi ships a
 * pinned copy as the STATIC instruction prefix and records its provenance in
 * `src/core/instructions/ponytail.lock.json`.
 *
 * Source discovery order (no absolute machine path is hard-coded):
 *   1. --source <path>
 *   2. $LEANPI_PONYTAIL_SOURCE
 *   3. $CLAUDE_PLUGIN_ROOT/cache/ponytail/ponytail/<version>/skills/ponytail/SKILL.md
 *   4. $HOME/.claude/plugins/cache/ponytail/ponytail/<version>/skills/ponytail/SKILL.md
 *
 * Usage:
 *   node scripts/sync-ponytail.mjs            # refresh the vendored copy + lock
 *   node scripts/sync-ponytail.mjs --check    # verify the vendored copy against the lock
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendoredPath = join(repoRoot, "src/core/instructions/ponytail.md");
const lockPath = join(repoRoot, "src/core/instructions/ponytail.lock.json");

const DEFAULT_VERSION = "4.9.0";
const SKILL_RELATIVE = (version) => join("cache", "ponytail", "ponytail", version, "skills", "ponytail", "SKILL.md");

export function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

export function readLock() {
	if (!existsSync(lockPath)) return undefined;
	return JSON.parse(readFileSync(lockPath, "utf8"));
}

export function resolveSource({ sourceFlag, env = process.env, home = homedir() } = {}) {
	const explicit = sourceFlag ?? env.LEANPI_PONYTAIL_SOURCE;
	if (explicit) return existsSync(explicit) ? resolve(explicit) : undefined;
	const version = env.LEANPI_PONYTAIL_VERSION ?? readLock()?.version ?? DEFAULT_VERSION;
	const candidates = [
		env.CLAUDE_PLUGIN_ROOT ? join(env.CLAUDE_PLUGIN_ROOT, SKILL_RELATIVE(version)) : undefined,
		home ? join(home, ".claude/plugins", SKILL_RELATIVE(version)) : undefined,
	].filter(Boolean);
	return candidates.find((candidate) => existsSync(candidate));
}

/**
 * The lock must not carry a machine-specific absolute path, so the discovered
 * source is rewritten against the roots the discovery order already uses.
 */
export function portableSource(sourcePath, { env = process.env, home = homedir() } = {}) {
	if (env.CLAUDE_PLUGIN_ROOT && sourcePath.startsWith(env.CLAUDE_PLUGIN_ROOT)) {
		return sourcePath.replace(env.CLAUDE_PLUGIN_ROOT, "$CLAUDE_PLUGIN_ROOT");
	}
	if (home && sourcePath.startsWith(home)) return sourcePath.replace(home, "$HOME");
	return sourcePath;
}

/** Pure check used by both the CLI and the test suite. */
export function checkVendored({ sourcePath } = {}) {
	const lock = readLock();
	if (!lock) return { ok: false, reason: "lock file missing" };
	if (!existsSync(vendoredPath)) return { ok: false, reason: "vendored ponytail.md missing" };
	const vendored = readFileSync(vendoredPath);
	const vendoredHash = sha256(vendored);
	if (vendoredHash !== lock.sha256) {
		return { ok: false, reason: `vendored ${vendoredPath} sha256 ${vendoredHash} does not match lock ${lock.sha256}` };
	}
	if (sourcePath && existsSync(sourcePath)) {
		const upstreamHash = sha256(readFileSync(sourcePath));
		if (upstreamHash !== lock.sha256) {
			return { ok: false, reason: `upstream ${sourcePath} sha256 ${upstreamHash} differs from lock ${lock.sha256}` };
		}
	}
	return { ok: true, lock, vendoredHash };
}

function main(argv) {
	const check = argv.includes("--check");
	const sourceFlagIndex = argv.indexOf("--source");
	const sourceFlag = sourceFlagIndex === -1 ? undefined : argv[sourceFlagIndex + 1];
	const sourcePath = resolveSource({ sourceFlag });

	if (check) {
		const result = checkVendored({ sourcePath });
		if (!result.ok) {
			console.error(`sync-ponytail --check FAILED: ${result.reason}`);
			process.exit(1);
		}
		console.log(
			sourcePath
				? `sync-ponytail --check OK: vendored copy matches lock and upstream (${sourcePath})`
				: "sync-ponytail --check OK: vendored copy matches lock (upstream plugin not installed)",
		);
		return;
	}

	if (!sourcePath) {
		console.error(
			"sync-ponytail: no upstream source found. Pass --source <path>, set LEANPI_PONYTAIL_SOURCE, " +
				"or install the Ponytail plugin so $CLAUDE_PLUGIN_ROOT/$HOME discovery resolves.",
		);
		process.exit(1);
	}

	const bytes = readFileSync(sourcePath);
	const version = process.env.LEANPI_PONYTAIL_VERSION ?? readLock()?.version ?? DEFAULT_VERSION;
	mkdirSync(dirname(vendoredPath), { recursive: true });
	copyFileSync(sourcePath, vendoredPath);
	writeFileSync(
		lockPath,
		`${JSON.stringify({ source: portableSource(sourcePath), version, sha256: sha256(bytes), syncedAt: new Date().toISOString() }, null, 2)}\n`,
	);
	console.log(`sync-ponytail: vendored ${bytes.length} bytes from ${sourcePath} (ponytail@${version})`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2));
}
