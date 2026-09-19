/**
 * The LSP tool surface (PRD-018 Phase 3, FR-093, ROADMAP §15/§18).
 *
 * Seven read-only tools — six navigation, one diagnostics — exposed *only* in
 * the mode that needs them, never by default. Two gates agree: the turn's active
 * tool set is `lspToolsForMode(mode)`, and every handler re-checks the active
 * mode, so a stale tool call is answered with an `unavailable` result the
 * executor can read rather than an edit or a throw.
 *
 * Handlers translate LeanPi's path/position arguments into LSP positions and
 * return compact results (path, line, column, and the type string for hover) —
 * never raw protocol payloads, per §15's context argument. Diagnostics are
 * requested fresh; the client invalidates a file's result on `didChange`, so a
 * fixed error cannot be replayed. Every handler is an ordinary registered tool
 * and passes through PRD-017's permission guard: no bypass exists here.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentToolResult, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { LeanPiConfig } from "../core/types.js";
import { getClient, LspUnavailableError, type ClientLookup, type LspDiagnostic } from "./client.js";
import { detectServers, languageOfPath } from "./detect.js";
import type { LspMode } from "./mode.js";

/** The six navigation tools. */
export const NAVIGATION_TOOL_NAMES = [
	"lsp_definition",
	"lsp_references",
	"lsp_hover",
	"lsp_document_symbols",
	"lsp_workspace_symbols",
	"lsp_call_hierarchy",
] as const;

/** The diagnostics tool, alone in its mode. */
export const DIAGNOSTICS_TOOL_NAMES = ["lsp_diagnostics"] as const;

export type LspToolName = (typeof NAVIGATION_TOOL_NAMES)[number] | (typeof DIAGNOSTICS_TOOL_NAMES)[number];

export const LSP_TOOL_NAMES: readonly LspToolName[] = [...NAVIGATION_TOOL_NAMES, ...DIAGNOSTICS_TOOL_NAMES];

/** PRD-018's exposure table, verbatim. `LSP_OFF` exposes nothing at all. */
export const LSP_TOOLS_BY_MODE: Record<LspMode, readonly LspToolName[]> = {
	LSP_OFF: [],
	LSP_DIAGNOSTICS: DIAGNOSTICS_TOOL_NAMES,
	LSP_NAVIGATION: NAVIGATION_TOOL_NAMES,
	LSP_FULL: LSP_TOOL_NAMES,
};

export function lspToolsForMode(mode: LspMode): LspToolName[] {
	return [...LSP_TOOLS_BY_MODE[mode]];
}

export interface LspToolOptions {
	root: string;
	config?: LeanPiConfig;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

export type LspToolOutcome = { ok: true; result: unknown } | { ok: false; unavailable: string };

interface CompactLocation {
	path: string;
	line: number;
	column: number;
}

const SYMBOL_KIND: Record<number, string> = {
	1: "file",
	2: "module",
	3: "namespace",
	4: "package",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	15: "string",
	16: "number",
	17: "boolean",
	18: "array",
	19: "object",
	20: "key",
	21: "null",
	22: "enumMember",
	23: "struct",
	24: "event",
	25: "operator",
	26: "typeParameter",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function fileUrl(path: string): string {
	return pathToFileURL(path).href;
}

function pathFromUri(uri: string): string {
	try {
		return new URL(uri).protocol === "file:" ? decodeURIComponent(new URL(uri).pathname) : uri;
	} catch {
		return uri;
	}
}

/** The 1-based start of a range, or of an object carrying one. */
function startOf(raw: unknown): { line: number; column: number } {
	const record = asRecord(raw);
	const range = asRecord(record?.range) ?? record;
	const start = asRecord(range?.start);
	const line = typeof start?.line === "number" ? start.line : 0;
	const character = typeof start?.character === "number" ? start.character : 0;
	return { line: line + 1, column: character + 1 };
}

/** Location | LocationLink | URI, compacted to path/line/column. */
function locationsOf(raw: unknown): CompactLocation[] {
	if (!Array.isArray(raw)) return [];
	const found: CompactLocation[] = [];
	for (const entry of raw) {
		if (typeof entry === "string") {
			found.push({ path: pathFromUri(entry), line: 1, column: 1 });
			continue;
		}
		const record = asRecord(entry);
		if (!record) continue;
		const uri = typeof record.uri === "string" ? record.uri : typeof record.targetUri === "string" ? record.targetUri : null;
		if (uri === null) continue;
		const where = startOf(record.range ?? record.targetSelectionRange ?? record.targetRange);
		found.push({ path: pathFromUri(uri), line: where.line, column: where.column });
	}
	return found;
}

function symbolKindName(kind: unknown): string {
	return typeof kind === "number" ? (SYMBOL_KIND[kind] ?? `kind:${kind}`) : "unknown";
}

/** DocumentSymbol (hierarchical) and SymbolInformation (flat) both arrive here. */
function symbolOf(raw: unknown, withPath: boolean): Array<Record<string, unknown>> {
	if (!Array.isArray(raw)) return [];
	const found: Array<Record<string, unknown>> = [];
	for (const entry of raw) {
		const record = asRecord(entry);
		if (!record) continue;
		const location = asRecord(record.location);
		const uri = typeof record.uri === "string" ? record.uri : typeof location?.uri === "string" ? location.uri : "";
		const where = startOf(record.selectionRange ?? record.range ?? location);
		found.push({
			name: typeof record.name === "string" ? record.name : "",
			kind: symbolKindName(record.kind),
			...(withPath && uri.length > 0 ? { path: pathFromUri(uri) } : {}),
			line: where.line,
			column: where.column,
		});
	}
	return found;
}

/** Hover contents may be a string, MarkupContent, or marked strings. */
function hoverText(contents: unknown): string {
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) return contents.map(hoverText).filter((text) => text.length > 0).join("\n");
	const record = asRecord(contents);
	if (record && typeof record.value === "string") return record.value;
	const language = record?.language;
	if (typeof language === "string") return language;
	return "";
}

/** Strips the code fence and language tag so the executor sees the declared type. */
function declaredType(contents: unknown): string {
	return hoverText(contents)
		.split("\n")
		.filter((line) => !line.trim().startsWith("```"))
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function clientOptions(options: LspToolOptions): { config?: LeanPiConfig; env?: NodeJS.ProcessEnv; timeoutMs?: number } {
	return {
		...(options.config ? { config: options.config } : {}),
		...(options.env ? { env: options.env } : {}),
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
	};
}

function fileArgument(root: string, args: Record<string, unknown>): string {
	const candidate = typeof args.file === "string" ? args.file : typeof args.path === "string" ? args.path : null;
	if (candidate === null || candidate.length === 0) throw new LspUnavailableError("this LSP tool needs a `file` argument");
	return resolve(root, candidate);
}

function positionArgument(args: Record<string, unknown>): { line: number; character: number } {
	const line = typeof args.line === "number" ? args.line : 1;
	const column = typeof args.column === "number" ? args.column : 1;
	return { line: Math.max(line, 1) - 1, character: Math.max(column, 1) - 1 };
}

async function openClientFor(options: LspToolOptions, file: string): Promise<Extract<ClientLookup, { ok: true }>> {
	const language = languageOfPath(file);
	if (language === null) throw new LspUnavailableError(`no language server covers ${file}`);
	const lookup = await getClient(options.root, language, clientOptions(options));
	if (!lookup.ok) throw new LspUnavailableError(lookup.reason);
	await lookup.client.ensureOpen(file);
	return lookup;
}

async function runTool(options: LspToolOptions, tool: LspToolName, args: Record<string, unknown>): Promise<unknown> {
	if (tool === "lsp_workspace_symbols") {
		// ponytail: a workspace query has no file to derive a language from, so the
		// project's first available server answers it. Add a `language` argument if a
		// polyglot workspace ever needs another one.
		const server = detectServers(options.root, { config: options.config, env: options.env })[0];
		if (!server) throw new LspUnavailableError(`no language server is available under ${options.root}`);
		const lookup = await getClient(options.root, server.language, clientOptions(options));
		if (!lookup.ok) throw new LspUnavailableError(lookup.reason);
		const query = typeof args.query === "string" ? args.query : "";
		return symbolOf(await lookup.client.request("workspace/symbol", { query }), true);
	}

	const file = fileArgument(options.root, args);
	const lookup = await openClientFor(options, file);
	const textDocument = { uri: fileUrl(file) };
	const position = positionArgument(args);

	switch (tool) {
		case "lsp_definition":
			return locationsOf(await lookup.client.request("textDocument/definition", { textDocument, position }));
		case "lsp_references":
			return locationsOf(
				await lookup.client.request("textDocument/references", { textDocument, position, context: { includeDeclaration: true } }),
			);
		case "lsp_hover": {
			const hover = asRecord(await lookup.client.request("textDocument/hover", { textDocument, position }));
			const range = asRecord(hover?.range);
			const where = startOf(range);
			return { path: file, line: where.line, column: where.column, contents: declaredType(hover?.contents) };
		}
		case "lsp_document_symbols":
			return symbolOf(await lookup.client.request("textDocument/documentSymbol", { textDocument }), false);
		case "lsp_call_hierarchy": {
			const prepared = await lookup.client.request<unknown>("textDocument/prepareCallHierarchy", { textDocument, position });
			const [item] = Array.isArray(prepared) ? prepared : [];
			if (item === undefined) return [];
			const incoming = await lookup.client.request<unknown>("callHierarchy/incomingCalls", { item });
			if (!Array.isArray(incoming)) return [];
			return incoming.map((call) => {
				const record = asRecord(call);
				const from = asRecord(record?.from);
				const range = asRecord(from?.selectionRange) ?? asRecord(from?.range);
				const uri = typeof from?.uri === "string" ? from.uri : "";
				const where = startOf(range);
				return {
					name: typeof from?.name === "string" ? from.name : "",
					kind: symbolKindName(from?.kind),
					path: uri.length > 0 ? pathFromUri(uri) : "",
					line: where.line,
					column: where.column,
				};
			});
		}
		case "lsp_diagnostics":
			return await lookup.client.diagnosticsFor(file);
	}
}

/**
 * The single invocation point: mode-gated, then executed. An unexposed or
 * unavailable tool is a readable outcome, never a throw and never a session
 * failure.
 */
export async function invokeLspTool(options: LspToolOptions, mode: LspMode, tool: LspToolName, args: Record<string, unknown>): Promise<LspToolOutcome> {
	if (!LSP_TOOLS_BY_MODE[mode].includes(tool)) return { ok: false, unavailable: `${tool} is not exposed under ${mode}` };
	try {
		return { ok: true, result: await runTool(options, tool, args) };
	} catch (error) {
		return { ok: false, unavailable: error instanceof Error ? error.message : `${tool} failed` };
	}
}

export type { LspDiagnostic };

/** The turn's active LSP mode; set per turn, exactly like the active prefix. */
let activeMode: LspMode | undefined;

export function setActiveLspTurn(mode: LspMode | undefined): void {
	activeMode = mode;
}

export function getActiveLspMode(): LspMode | undefined {
	return activeMode;
}

export interface LspSessionTools {
	getActiveToolNames(): string[];
	setActiveToolsByName(names: string[]): void;
}

/**
 * Exposes exactly the mode's group to the turn, replacing any previous turn's
 * LSP tools and leaving the rest of the surface untouched. Returns the names the
 * mode names; names Pi does not know are dropped by `setActiveToolsByName`.
 */
export function applyLspTools(session: LspSessionTools, mode: LspMode): LspToolName[] {
	setActiveLspTurn(mode);
	const exposed = lspToolsForMode(mode);
	const kept = session.getActiveToolNames().filter((name) => !(LSP_TOOL_NAMES as readonly string[]).includes(name));
	session.setActiveToolsByName([...kept, ...exposed]);
	return exposed;
}

function toolResult(outcome: LspToolOutcome): AgentToolResult<Record<string, unknown>> {
	if (outcome.ok) return { content: [{ type: "text", text: JSON.stringify(outcome.result) }], details: {} };
	return {
		content: [{ type: "text", text: `unavailable: ${outcome.unavailable}` }],
		details: { unavailable: outcome.unavailable },
	};
}

const FILE_PROPERTY = {
	file: Type.String({ description: "Repository-relative or absolute path of the file the request starts in." }),
};

const POSITION_PROPERTIES = {
	...FILE_PROPERTY,
	line: Type.Number({ description: "1-based line of the symbol." }),
	column: Type.Number({ description: "1-based column of the symbol." }),
};

/** The seven handlers; each is registered as an ordinary tool. */
export function lspToolDefinitions(options: LspToolOptions): ToolDefinition[] {
	const invoke = (name: LspToolName) => async (args: unknown) =>
		toolResult(await invokeLspTool(options, getActiveLspMode() ?? "LSP_OFF", name, asRecord(args) ?? {}));

	return [
		{
			name: "lsp_definition",
			label: "lsp_definition",
			description: "Where is this symbol defined? Returns the defining file and position.",
			parameters: Type.Object(POSITION_PROPERTIES),
			execute: async (_id, params) => invoke("lsp_definition")(params),
		},
		{
			name: "lsp_references",
			label: "lsp_references",
			description: "Every location that references this symbol, including its declaration.",
			parameters: Type.Object(POSITION_PROPERTIES),
			execute: async (_id, params) => invoke("lsp_references")(params),
		},
		{
			name: "lsp_hover",
			label: "lsp_hover",
			description: "The declared type of the symbol at this position.",
			parameters: Type.Object(POSITION_PROPERTIES),
			execute: async (_id, params) => invoke("lsp_hover")(params),
		},
		{
			name: "lsp_document_symbols",
			label: "lsp_document_symbols",
			description: "The symbols declared in one file.",
			parameters: Type.Object(FILE_PROPERTY),
			execute: async (_id, params) => invoke("lsp_document_symbols")(params),
		},
		{
			name: "lsp_workspace_symbols",
			label: "lsp_workspace_symbols",
			description: "Workspace-wide symbol search by query, returning the declaring file for each match.",
			parameters: Type.Object({ query: Type.String({ description: "Symbol name or fragment to search for." }) }),
			execute: async (_id, params) => invoke("lsp_workspace_symbols")(params),
		},
		{
			name: "lsp_call_hierarchy",
			label: "lsp_call_hierarchy",
			description: "Who calls the function at this position? Returns the known callers.",
			parameters: Type.Object(POSITION_PROPERTIES),
			execute: async (_id, params) => invoke("lsp_call_hierarchy")(params),
		},
		{
			name: "lsp_diagnostics",
			label: "lsp_diagnostics",
			description: "The language server's current diagnostics for one file, requested fresh after any edit.",
			parameters: Type.Object(FILE_PROPERTY),
			execute: async (_id, params) => invoke("lsp_diagnostics")(params),
		},
	];
}

/** Registers all seven definitions; the mode, not registration, decides exposure. */
export function registerLspTools(pi: { registerTool(definition: ToolDefinition): void }, options: LspToolOptions): LspToolName[] {
	for (const definition of lspToolDefinitions(options)) pi.registerTool(definition);
	return [...LSP_TOOL_NAMES];
}
