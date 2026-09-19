/**
 * The STATIC instruction prefix (PRD-001 Phase 3, FR-002, ROADMAP §6.1/§22).
 *
 * The rendered prefix interpolates nothing task-dependent, so the same bytes
 * head every executor request in a session and stay cacheable as the STATIC
 * block of the §22 prompt layout.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LeanPiConfig } from "../types.js";
import { PACKAGE_ROOT } from "../package-info.js";

/** Size ceiling for the rendered prefix (§6.1 "short enough to preserve prefix efficiency"). */
export const PREFIX_MAX_BYTES = 8192;

export interface PonytailLock {
	source: string;
	version: string;
	sha256: string;
	syncedAt: string;
}

export const PONYTAIL_MD_PATH = join(PACKAGE_ROOT, "src/core/instructions/ponytail.md");
export const PONYTAIL_LOCK_PATH = join(PACKAGE_ROOT, "src/core/instructions/ponytail.lock.json");

export function readPonytailLock(): PonytailLock {
	return JSON.parse(readFileSync(PONYTAIL_LOCK_PATH, "utf8")) as PonytailLock;
}

export const PONYTAIL_VERSION: string = readPonytailLock().version;
export const PONYTAIL_MARKER = `ponytail@${PONYTAIL_VERSION}`;

let cachedBody: string | undefined;

/** The vendored upstream instruction bundle, verbatim. */
export function readVendoredPonytail(): string {
	cachedBody ??= readFileSync(PONYTAIL_MD_PATH, "utf8");
	return cachedBody;
}

/**
 * `''` when disabled; otherwise the marker line followed by the vendored body.
 * Byte-stable for a given vendored file — no task data, no timestamps.
 */
export function buildStaticPrefix(config: Pick<LeanPiConfig, "instructions">): string {
	if (config.instructions.ponytail === false) return "";
	return `${PONYTAIL_MARKER}\n\n${readVendoredPonytail()}`;
}
