/**
 * Selected MCP tools as Pi tool definitions (PRD-006 Phase 4's invocation
 * surface) and the per-turn tool surface that puts them on the model's reach
 * (PRD-045).
 *
 * The name is `mcp__<server>__<tool>`, which is the shape PRD-017's classifier
 * already resolves `mcp:<server>/<tool>` scopes from — so an MCP call reaches the
 * *same* dispatch guard as every other tool and no second permission check
 * exists in this module. `execute` is the one place a connection is opened: the
 * pool spawns on first use, which is what makes disclosure lazy end to end.
 *
 * The surface is one step, shared by both turn entry points: register the turn's
 * selected tools once, then set the active set to them plus the LSP mode's
 * group. A tool the guard would `ask` or `deny` is still on the surface — the
 * guard decides, not this module — but a vendor harness, which cannot prompt, is
 * handed only what resolves to `allow`.
 */
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkerMcpServer } from "../backends/worker.js";
import type { LeanPiConfig } from "../core/types.js";
import type { LspMode } from "../lsp/mode.js";
import { lspToolsForMode, LSP_TOOL_NAMES, setActiveLspTurn } from "../lsp/tools.js";
import { resolve, type PermissionDecision, type PermissionsConfig } from "../permissions/rules.js";
import type { McpCatalog, McpServerEntry } from "./catalog.js";
import type { McpPool } from "./client.js";
import { requestCapability, type JevSelector, type SelectedMcpTool } from "./select.js";

/** The mid-turn router's tool name (PRD-045 Phase 2). */
export const MCP_REQUEST_TOOL_NAME = "mcp_request";

export function mcpToolName(server: string, tool: string): string {
	return `mcp__${server}__${tool}`;
}

/** True for the names this module owns on the surface. */
export function isMcpToolName(name: string): boolean {
	return name.startsWith("mcp__");
}

export function mcpToolDefinition(tool: SelectedMcpTool, pool: McpPool): ToolDefinition {
	const parameters = (tool.inputSchema ?? {}) as Record<string, unknown>;
	return {
		name: mcpToolName(tool.server, tool.tool),
		label: `${tool.server}/${tool.tool}`,
		description: tool.description || `MCP tool ${tool.server}/${tool.tool}`,
		parameters: Object.keys(parameters).length > 0 ? (parameters as never) : (Type.Object({}) as never),
		execute: async (_id: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> => {
			const result = await pool.callTool(tool.server, tool.tool, params);
			return {
				content: result.content as AgentToolResult<unknown>["content"],
				details: { server: tool.server, tool: tool.tool },
				...(result.isError ? { isError: true } : {}),
			};
		},
	} as unknown as ToolDefinition;
}

/** One definition per admitted tool; the executor tool set's MCP half. */
export function mcpToolDefinitions(tools: SelectedMcpTool[], pool: McpPool): ToolDefinition[] {
	return tools.map((tool) => mcpToolDefinition(tool, pool));
}

// ---------------------------------------------------------------------------
// The per-turn tool surface (PRD-045 Phase 1)
// ---------------------------------------------------------------------------

/**
 * The Pi surface the lane edits. Narrower than `ExtensionAPI` on purpose: the
 * lane needs the registry and the active set, nothing else.
 */
export interface ToolSurfaceHost {
	getActiveTools?(): string[];
	setActiveTools?(names: string[]): void;
	registerTool(definition: ToolDefinition): void;
}

export interface ToolSurface {
	/** The tools this turn selected, in admission order. */
	live(): SelectedMcpTool[];
	/** The LSP mode of the current turn. */
	mode(): LspMode;
	/**
	 * Register this turn's tools (once each, for the activation's lifetime) and
	 * set the active set: the baseline/artifact/subagent names already active, this
	 * turn's MCP names, and the LSP group for `lspMode`. Returns the active names.
	 */
	apply(tools: SelectedMcpTool[], lspMode?: LspMode): string[];
}

export function createToolSurface(host: ToolSurfaceHost, pool: McpPool): ToolSurface {
	// Per activation, never module-global: a second session in one process must
	// not inherit the first one's registered names.
	const registered = new Set<string>();
	let live: SelectedMcpTool[] = [];
	let mode: LspMode = "LSP_OFF";

	const activate = (): string[] => {
		const owned = live.map((tool) => mcpToolName(tool.server, tool.tool));
		setActiveLspTurn(mode);
		// A host that exposes no tool-set API (a bench stub, a fake in a spec) keeps
		// its own list; the tools are still registered and the mode still recorded.
		if (host.getActiveTools === undefined || host.setActiveTools === undefined) return [];
		// Only the two namespaces this step owns are edited; every baseline,
		// artifact and subagent name passes through untouched.
		const kept = host.getActiveTools().filter((name) => !isMcpToolName(name) && !(LSP_TOOL_NAMES as readonly string[]).includes(name));
		const next = [...new Set([...kept, ...owned, ...lspToolsForMode(mode)])];
		host.setActiveTools(next);
		return next;
	};

	return {
		live: () => live,
		mode: () => mode,
		apply(tools, lspMode) {
			live = tools;
			if (lspMode !== undefined) mode = lspMode;
			for (const tool of tools) {
				const name = mcpToolName(tool.server, tool.tool);
				if (registered.has(name)) continue;
				host.registerTool(mcpToolDefinition(tool, pool));
				registered.add(name);
			}
			return activate();
		},
	};
}

// ---------------------------------------------------------------------------
// The mid-turn capability request (PRD-045 Phase 2)
// ---------------------------------------------------------------------------

export interface McpRequestDeps {
	surface: ToolSurface;
	/** Rebuilt per call, so a `/mcp refresh` is visible to the next request. */
	catalog: () => McpCatalog;
	config: LeanPiConfig;
	cwd: string;
	client?: JevSelector;
	maxTools?: number;
}

/**
 * The `mcp_request` tool: the model asks for a capability in words and JEV (or
 * the §49 lexical fallback) admits at most one tool, or refuses. An admission is
 * registered and activated in the same turn.
 */
export function mcpRequestDefinition(deps: McpRequestDeps): ToolDefinition {
	return {
		name: MCP_REQUEST_TOOL_NAME,
		label: MCP_REQUEST_TOOL_NAME,
		description: "Ask for one more MCP capability by describing what you need. JEV admits at most one tool, or refuses.",
		parameters: Type.Object({ query: Type.String({ description: "What capability you need, in one sentence." }) }),
		execute: async (_id: string, params: Record<string, unknown>): Promise<AgentToolResult<unknown>> => {
			const query = typeof params.query === "string" ? params.query : "";
			const admission = await requestCapability({
				query,
				catalog: deps.catalog(),
				config: deps.config,
				cwd: deps.cwd,
				live: deps.surface.live(),
				...(deps.client ? { client: deps.client } : {}),
				...(deps.maxTools === undefined ? {} : { maxTools: deps.maxTools }),
			});
			if (!admission.ok || admission.admitted === null) {
				const message = admission.refusal?.message ?? "no capability was admitted";
				return { content: [{ type: "text", text: `mcp_request refused: ${message}` }], details: { ok: false } };
			}
			deps.surface.apply(admission.tools, deps.surface.mode());
			const evicted = admission.evicted === null ? "" : ` (evicted ${admission.evicted.server}/${admission.evicted.tool})`;
			return {
				content: [{ type: "text", text: `${mcpToolName(admission.admitted.server, admission.admitted.tool)} is now callable${evicted}` }],
				details: {
					ok: true,
					admitted: `${admission.admitted.server}/${admission.admitted.tool}`,
					...(admission.evicted === null ? {} : { evicted: `${admission.evicted.server}/${admission.evicted.tool}` }),
				},
			};
		},
	} as unknown as ToolDefinition;
}

// ---------------------------------------------------------------------------
// The vendor harness projection (PRD-045 Phase 3)
// ---------------------------------------------------------------------------

/** One MCP server as a vendor CLI configures it; the packet's own shape. */
export type VendorMcpServer = WorkerMcpServer;

export interface VendorMcpResolution {
	servers: VendorMcpServer[];
	/** Selected tools the guard did not resolve to `allow`, and why. */
	withheld: Array<{ capability: string; decision: Exclude<PermissionDecision, "allow"> }>;
}

function serverConfigOf(entry: McpServerEntry): VendorMcpServer {
	return entry.transport === "stdio"
		? { name: entry.name, transport: "stdio", command: entry.command ?? "", args: [...entry.args], env: { ...entry.env }, tools: [] }
		: { name: entry.name, transport: "http", url: entry.url ?? "", tools: [] };
}

/**
 * Project the selected tools onto vendor-ready server configs. A vendor loop is
 * outside PRD-017's guard and cannot `ask`, so only tools that resolve to
 * `allow` are handed over; `ask` and `deny` are withheld and reported.
 *
 * Secrets in a server's `env` travel in the child's argv/env and nowhere else:
 * this returns them, and the caller passes them straight to the spawn.
 */
export function resolveVendorServers(input: { tools: SelectedMcpTool[]; catalog: McpCatalog; permissions: PermissionsConfig }): VendorMcpResolution {
	const entries = new Map(input.catalog.entries.map((entry) => [entry.name, entry]));
	const byServer = new Map<string, VendorMcpServer>();
	const withheld: VendorMcpResolution["withheld"] = [];
	for (const tool of input.tools) {
		const capability = `mcp:${tool.server}/${tool.tool}`;
		const decision = resolve(capability, input.permissions).decision;
		if (decision !== "allow") {
			withheld.push({ capability, decision });
			continue;
		}
		const entry = entries.get(tool.server);
		if (!entry) continue;
		const server = byServer.get(tool.server) ?? serverConfigOf(entry);
		server.tools.push(mcpToolName(tool.server, tool.tool));
		byServer.set(tool.server, server);
	}
	return { servers: [...byServer.values()], withheld };
}
