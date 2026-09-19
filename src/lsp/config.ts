/**
 * The `lsp` configuration surface (PRD-018, FR-090–FR-092).
 *
 * `LeanPiConfig.lsp` belongs to PRD-001's config loader; it is read here
 * *structurally* so this module never depends on that field's declaration
 * order. A config object without the block is valid and means `auto` — LSP is
 * optional by construction, and a missing or malformed block degrades to the
 * default instead of throwing. No absolute machine path appears here: `servers`
 * carries whatever command (or absolute path) the user wrote.
 */
import type { LeanPiConfig } from "../core/types.js";

/** The configured modes, verbatim (`auto` = decide per task). */
export const LSP_CONFIG_MODES = ["off", "diagnostics", "navigation", "full", "auto"] as const;

export type LspConfigMode = (typeof LSP_CONFIG_MODES)[number];

export interface LspConfig {
	mode?: LspConfigMode;
	/** language id → server command: a name probed on PATH, or an absolute path. */
	servers?: Record<string, string>;
}

/** Documented default: decide per task, no server overrides. */
export const DEFAULT_LSP_CONFIG = { mode: "auto" } as const satisfies { mode: LspConfigMode };

export interface ResolvedLspConfig {
	mode: LspConfigMode;
	servers: Record<string, string>;
}

/** Structural read with documented defaults; never throws on a malformed block. */
export function lspConfigOf(config: LeanPiConfig | undefined): ResolvedLspConfig {
	const block = (config as (LeanPiConfig & { lsp?: unknown }) | undefined)?.lsp;
	if (block === undefined || block === null || typeof block !== "object") return { mode: DEFAULT_LSP_CONFIG.mode, servers: {} };
	const record = block as Record<string, unknown>;
	const configured = record.mode;
	const mode =
		typeof configured === "string" && (LSP_CONFIG_MODES as readonly string[]).includes(configured)
			? (configured as LspConfigMode)
			: DEFAULT_LSP_CONFIG.mode;
	const servers: Record<string, string> = {};
	const raw = record.servers;
	if (raw !== undefined && raw !== null && typeof raw === "object") {
		for (const [language, command] of Object.entries(raw as Record<string, unknown>)) {
			if (typeof command === "string" && command.length > 0) servers[language] = command;
		}
	}
	return { mode, servers };
}
