/**
 * Fixtures for the PRD-017 permission specs: a stub MCP server, a loopback HTTP
 * server that logs inbound requests, and a permission-store writer.
 *
 * The PRD names `tests/fixtures/permissions/**`; the work is confined to
 * `tests/permissions/` by the lane's file ownership, so the same fixtures live
 * here as one module.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	writeUserDefault,
	writeUserRule,
	writeUserSecretsPolicy,
	type PermissionDecision,
	type PermissionEnv,
	type Scope,
	type SecretsPolicy,
} from "../../src/permissions/index.js";

/** A stub MCP server tool: `mcp__<server>__<tool>`, counting what reaches the server. */
export interface StubMcp {
	/** Bytes the server's stdin would have received; a refused call must leave this at zero. */
	bytesIn: number;
	calls: Array<Record<string, unknown>>;
}

export function stubMcpTool(server: string, tool: string, onCall: (args: Record<string, unknown>) => string): ToolDefinition & { stub: StubMcp } {
	const stub: StubMcp = { bytesIn: 0, calls: [] };
	const definition: ToolDefinition = {
		name: `mcp__${server}__${tool}`,
		label: `${server}/${tool}`,
		description: `stub MCP tool ${server}/${tool}`,
		parameters: Type.Object({ path: Type.Optional(Type.String()), content: Type.Optional(Type.String()) }),
		execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
			const args = params as Record<string, unknown>;
			stub.calls.push(args);
			stub.bytesIn += Buffer.byteLength(JSON.stringify(args));
			return { content: [{ type: "text", text: onCall(args) }] };
		},
	};
	return Object.assign(definition, { stub });
}

/** A capability tool that models spawning a child subagent session. */
export function stubSubagentTool(sessions: string[]): ToolDefinition {
	return {
		name: "subagent",
		label: "subagent",
		description: "stub subagent spawn",
		parameters: Type.Object({ task: Type.Optional(Type.String()) }),
		execute: async (_id, params): Promise<AgentToolResult<unknown>> => {
			const args = params as { task?: string };
			sessions.push(args.task ?? "child");
			return { content: [{ type: "text", text: `session ${sessions.length} created` }] };
		},
	};
}

export interface LoopbackServer {
	url: string;
	requests: string[];
	close(): Promise<void>;
}

/** A loopback HTTP server that logs every inbound request (socket-level evidence). */
export async function loopbackServer(): Promise<LoopbackServer> {
	const requests: string[] = [];
	const server: Server = createServer((request, response) => {
		requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("loopback ok\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

/** Seed the user-scope store the session will read. */
export function seedUserPermissions(
	env: PermissionEnv,
	state: {
		defaults?: Partial<Record<Scope, PermissionDecision>>;
		rules?: Array<[string, PermissionDecision]>;
		secrets?: Partial<SecretsPolicy>;
	},
): void {
	for (const [scope, decision] of Object.entries(state.defaults ?? {})) writeUserDefault(scope as Scope, decision, env);
	for (const [capability, decision] of state.rules ?? []) writeUserRule(capability, decision, env);
	if (state.secrets) writeUserSecretsPolicy(state.secrets, env);
}
