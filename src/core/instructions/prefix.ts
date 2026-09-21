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
 * How LeanPi answers, as opposed to how it works. Ponytail governs what gets
 * built; this governs the shape of the reply the operator reads — so it stands
 * whether or not Ponytail is enabled.
 */
/**
 * Karpathy's coding guidelines, minus the one already vendored.
 *
 * Four guidelines, three of them here: "Simplicity First" is Ponytail's entire
 * subject and repeating it would spend prefix bytes to say the same thing twice.
 * What Ponytail does not cover is the part before the code (say what you assumed,
 * do not silently pick one of several readings) and the part around it (change
 * only what the request touches; decide the check before writing the thing it
 * checks). Condensed to fit the §6.1 prefix ceiling.
 */
export const WORKING_RULES = [
	"Working rules:",
	"- Think first. State your assumptions; ask rather than guess. Several readings of the request — give them, do not silently pick one. A simpler approach exists — say so. Confused — name it instead of proceeding.",
	"- Surgical. Every changed line traces to the request. Do not improve, reformat or refactor code you were not asked about; match the style already there. Pre-existing dead code: mention it, leave it. Delete only what your own change orphaned.",
	"- Verify. Turn the task into a check before writing the code — a bug becomes a failing test first. State a multi-step plan as `step → verify`, and loop until the check passes.",
].join("\n");

export const OUTPUT_STYLE = [
	"LeanPi output style:",
	"- End a finished task with a `TLDR:` block naming exactly what was delivered.",
	"- Mark states with the emoji on the line it describes: ✅ done, ⚠️ caveat, ❌ failed. Not decoration.",
	'- When you offer the operator options, rate each 1-5 stars (★), best first, and mark one "Recommended".',
].join("\n");

/**
 * The output style alone when Ponytail is disabled; otherwise the marker line,
 * the vendored body, then the style.
 * Byte-stable for a given vendored file — no task data, no timestamps.
 */
export function buildStaticPrefix(config: Pick<LeanPiConfig, "instructions">): string {
	if (config.instructions.ponytail === false) return `${WORKING_RULES}\n\n${OUTPUT_STYLE}`;
	return `${PONYTAIL_MARKER}\n\n${readVendoredPonytail()}\n\n${WORKING_RULES}\n\n${OUTPUT_STYLE}`;
}
