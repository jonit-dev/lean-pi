/**
 * LSP integration (PRD-018, FR-090–FR-094, ROADMAP §15/§18).
 *
 * Four pieces, each with one owner: `mode` selects, `detect` resolves a server,
 * `client` speaks LSP lazily over stdio, `tools` exposes the mode's group. The
 * provider is the only thing PRD-004's compiler touches.
 */
export { DEFAULT_LSP_CONFIG, LSP_CONFIG_MODES, lspConfigOf, type LspConfig, type LspConfigMode, type ResolvedLspConfig } from "./config.js";
export {
	changedLanguagesWithServers,
	cheapestMode,
	LSP_MODE_ORDER,
	LSP_MODES,
	LSP_TIE_CANDIDATES,
	preferTargetedCheck,
	selectLspMode,
	type LspMode,
	type LspModeInput,
	type LspSelection,
	type LspTokenUsage,
	type LspUsefulnessAsker,
	type LspUsefulnessContext,
	type TargetedCheck,
} from "./mode.js";
export {
	commandOnPath,
	detectServers,
	LANGUAGE_BY_EXTENSION,
	languageOfPath,
	lookupServer,
	LSP_SERVER_COMMANDS,
	serverCommandsFor,
	type DetectOptions,
	type DetectedServer,
	type ServerLookup,
} from "./detect.js";
export { closeLspClients, getClient, lspProcessStats, LspClient, LspUnavailableError, type ClientLookup, type LspClientOptions, type LspDiagnostic } from "./client.js";
export {
	cheapestTiedCandidate,
	LSP_MODE_QUESTION_ID,
	LSP_MODE_RUBRIC,
	LSP_SITE_ID,
	lspUsefulnessQuestions,
	registerLspSite,
} from "./site.js";
export {
	applyLspTools,
	DIAGNOSTICS_TOOL_NAMES,
	getActiveLspMode,
	invokeLspTool,
	lspToolDefinitions,
	lspToolsForMode,
	LSP_TOOLS_BY_MODE,
	LSP_TOOL_NAMES,
	NAVIGATION_TOOL_NAMES,
	registerLspTools,
	setActiveLspTurn,
	type LspSessionTools,
	type LspToolName,
	type LspToolOptions,
	type LspToolOutcome,
} from "./tools.js";
export {
	changedLanguagesOf,
	createJevAsker,
	createLspProvider,
	lspSelectionOf,
	lspTelemetryOf,
	lspToolsForTurn,
	lspTurnRecordOf,
	type LspProviderOptions,
	type LspTurnRecord,
} from "./provider.js";
