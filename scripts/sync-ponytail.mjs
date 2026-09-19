#!/usr/bin/env node
/**
 * Vendor the installed Ponytail instruction bundle (PRD-001, FR-002).
 *
 * This is an argv wrapper: the copy/hash/lock mechanism lives once, in
 * `src/skills/vendor.mjs`, shared with the bundled skill pack (PRD-026). Only
 * the discovery order and the CLI contract are this script's own.
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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFile, portableSource, readJson, sha256, vendorFile } from "../src/skills/vendor.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendoredPath = join(repoRoot, "src/core/instructions/ponytail.md");
const lockPath = join(repoRoot, "src/core/instructions/ponytail.lock.json");

const DEFAULT_VERSION = "4.9.0";
const SKILL_RELATIVE = (version) => join("cache", "ponytail", "ponytail", version, "skills", "ponytail", "SKILL.md");

export { sha256, portableSource };

export function readLock() {
	return readJson(lockPath);
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

/** Pure check used by both the CLI and the test suite. */
export function checkVendored({ sourcePath } = {}) {
	return checkFile({ destPath: vendoredPath, lockPath, sourcePath });
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

	const version = process.env.LEANPI_PONYTAIL_VERSION ?? readLock()?.version ?? DEFAULT_VERSION;
	const { bytes } = vendorFile({ sourcePath, destPath: vendoredPath, lockPath, version });
	console.log(`sync-ponytail: vendored ${bytes} bytes from ${sourcePath} (ponytail@${version})`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2));
}
