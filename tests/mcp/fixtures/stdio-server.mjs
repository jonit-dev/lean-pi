#!/usr/bin/env node
/**
 * A minimal MCP stdio server, the PRD-006 fixture.
 *
 * Newline-delimited JSON-RPC 2.0 over stdin/stdout: `initialize`,
 * `notifications/initialized`, `tools/list`, `tools/call`. It writes a marker
 * file on startup and appends every `tools/call` to a request log, so a spec can
 * observe both "the process was spawned" and "the call actually reached it"
 * without mocking a transport.
 *
 * Env: MCP_NAME, MCP_MARKER, MCP_LOG, MCP_TOOLS (JSON array of tool definitions).
 */
import { appendFileSync, writeFileSync } from "node:fs";

const name = process.env.MCP_NAME ?? "fixture";
const marker = process.env.MCP_MARKER;
if (marker) writeFileSync(marker, `${process.pid}\n`);

const logPath = process.env.MCP_LOG;
let tools = [];
try {
	tools = JSON.parse(process.env.MCP_TOOLS ?? "[]");
} catch {
	tools = [];
}
let errorTools = [];
try {
	errorTools = JSON.parse(process.env.MCP_ERROR_TOOLS ?? "[]");
} catch {
	errorTools = [];
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
	if (message.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } },
		});
		return;
	}
	if (message.method === "notifications/initialized") return;
	if (message.method === "tools/list") {
		send({ jsonrpc: "2.0", id: message.id, result: { tools } });
		return;
	}
	if (message.method === "tools/call") {
		const tool = message.params?.name;
		if (logPath) appendFileSync(logPath, `${JSON.stringify({ server: name, tool, arguments: message.params?.arguments ?? {} })}\n`);
		if (errorTools.includes(tool)) {
			send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `${name}/${tool} failed` }], isError: true } });
			return;
		}
		send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `${name}/${tool} ok` }], isError: false } });
		return;
	}
	send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line.length > 0) {
			try {
				handle(JSON.parse(line));
			} catch {
				// A malformed line is not a protocol message.
			}
		}
		index = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));
