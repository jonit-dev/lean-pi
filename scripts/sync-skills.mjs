#!/usr/bin/env node
/**
 * Vendor the bundled skill pack (PRD-026 Phase 1). Maintainer tool only: it
 * runs in a pull request, never at runtime and never on install.
 *
 * Usage:
 *   node scripts/sync-skills.mjs [--source <root>]   # re-vendor and rewrite the lock
 *   node scripts/sync-skills.mjs --check             # recompute hashes, non-zero on drift
 *
 * Source discovery: --source → $LEANPI_SKILL_SOURCE → $CLAUDE_PLUGIN_ROOT → $HOME/.claude.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPack, readJson, renderNotice, resolveSourceRoot, VendorError, vendorPack, writeLock } from "../src/skills/vendor.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PACK_ROOT = join(repoRoot, "skills");
export const PACK_LOCK = join(PACK_ROOT, "pack.lock.json");
const NOTICE = join(PACK_ROOT, "NOTICE.md");

const PLUGIN_CACHE = "plugins/cache";

/**
 * The pack, with one line of justification per entry in the PRD. `source` is
 * relative to the resolved source root (`$HOME/.claude` by default), so no
 * machine path is written down here.
 */
export const PACK_SPEC = [
	{ name: "prd-creator", source: "skills/prd-creator", allowlist: ["SKILL.md"], licence: "First-party (LeanPi repository owner)", attribution: "joao" },
	{ name: "prd-manager", source: "skills/prd-manager", allowlist: ["SKILL.md", "scripts/**"], licence: "First-party (LeanPi repository owner)", attribution: "joao" },
	{ name: "prd-executor", source: "skills/prd-executor", allowlist: ["SKILL.md"], licence: "First-party (LeanPi repository owner)", attribution: "joao" },
	{ name: "i-have-adhd", source: `${PLUGIN_CACHE}/i-have-adhd/i-have-adhd/0.3.0/skills/i-have-adhd`, allowlist: ["SKILL.md", "agents/**"], attribution: "Ayoub Ghriss" },
	{ name: "ponytail-review", source: `${PLUGIN_CACHE}/ponytail/ponytail/4.9.0/skills/ponytail-review`, allowlist: ["SKILL.md"], attribution: "DietrichGebert" },
	{ name: "ponytail-audit", source: `${PLUGIN_CACHE}/ponytail/ponytail/4.9.0/skills/ponytail-audit`, allowlist: ["SKILL.md"], attribution: "DietrichGebert" },
	{ name: "ponytail-debt", source: `${PLUGIN_CACHE}/ponytail/ponytail/4.9.0/skills/ponytail-debt`, allowlist: ["SKILL.md"], attribution: "DietrichGebert" },
];

export function syncSkills({ sourceRoot, destRoot = PACK_ROOT, lockPath = PACK_LOCK, noticePath = NOTICE, spec = PACK_SPEC, now } = {}) {
	const previousLock = readJson(lockPath);
	const lock = vendorPack({ spec, sourceRoot, destRoot, previousLock, ...(now ? { now } : {}) });
	mkdirSync(destRoot, { recursive: true });
	writeLock(lockPath, lock);
	writeFileSync(noticePath, renderNotice(lock));
	return lock;
}

function main(argv) {
	const check = argv.includes("--check");
	const flagIndex = argv.indexOf("--source");
	const sourceFlag = flagIndex === -1 ? undefined : argv[flagIndex + 1];

	if (check) {
		const result = checkPack({ lock: readJson(PACK_LOCK), destRoot: PACK_ROOT });
		if (!result.ok) {
			console.error(`sync-skills --check FAILED: ${result.reason}`);
			process.exit(1);
		}
		console.log("sync-skills --check OK: every vendored file matches pack.lock.json");
		return;
	}

	const sourceRoot = resolveSourceRoot({ sourceFlag });
	if (!sourceRoot) {
		console.error("sync-skills: no upstream root found. Pass --source <root>, set LEANPI_SKILL_SOURCE, or install the plugins so $CLAUDE_PLUGIN_ROOT/$HOME discovery resolves.");
		process.exit(1);
	}
	try {
		const lock = syncSkills({ sourceRoot });
		console.log(`sync-skills: vendored ${lock.skills.length} skills, ${lock.skills.reduce((sum, skill) => sum + skill.files.length, 0)} files from ${sourceRoot}`);
	} catch (error) {
		if (error instanceof VendorError) {
			console.error(`sync-skills FAILED: ${error.message}`);
			process.exit(1);
		}
		throw error;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	main(process.argv.slice(2));
}
