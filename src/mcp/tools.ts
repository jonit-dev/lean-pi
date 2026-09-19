/**
 * Selected MCP tools as Pi tool definitions (PRD-006 Phase 4's invocation surface).
 *
 * The name is `mcp__<server>__<tool>`, which is the shape PRD-017's classifier
 * already resolves `mcp:<server>/<tool>` scopes from — so an MCP call reaches the
 * *same* dispatch guard as every other tool and no second permission check
 * exists in this module. `execute` is the one place a connection is opened: the
 * pool spawns on first use, which is what makes disclosure lazy end to end.
 */
import type { AgentToolResult, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { McpPool } from "./client.js";
import type { SelectedMcpTool } from "./select.js";

export function mcpToolName(server: string, tool: string): string {
	return `mcp__${server}__${tool}`;
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
