/**
 * Fixtures for the PRD-006 MCP specs.
 *
 * Two real servers: the stdio fixture process (`fixtures/stdio-server.mjs`),
 * which records its own startup and every call, and an in-process loopback HTTP
 * server speaking the same streamable-HTTP protocol. Nothing here mocks a
 * transport, so a pass cannot come from a stubbed connect.
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJevClient, loadConfig, setCompilerContext, type JevClient, type JevMode, type LeanPiConfig } from "../../src/index.js";
import { writeServerSchemas, type CachedTool } from "../../src/mcp/index.js";
import { tempDir } from "../helpers/fixtures.js";
import { startStubJev, type StubJev, type StubJevResponder } from "../helpers/stub-jev.js";

export const STDIO_SERVER = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));

export interface FixtureTool {
	name: string;
	description: string;
	inputSchema: unknown;
}

/** Every fixture schema carries a unique property, so "zero bytes from server B" is assertable. */
export function sentinelTool(server: string, tool: string): FixtureTool {
	return {
		name: tool,
		description: `${server}/${tool} fixture tool`,
		inputSchema: { type: "object", properties: { [`sentinel_${server}_${tool}`]: { type: "string" } }, required: [] },
	};
}

export function sentinelOf(server: string, tool: string): string {
	return `sentinel_${server}_${tool}`;
}

export function toolsFor(server: string, names: string[]): FixtureTool[] {
	return names.map((name) => sentinelTool(server, name));
}

/** A `$HOME` for the user-scope config file, so no spec ever reads the real one. */
export function tempHome(): string {
	const home = tempDir("leanpi-mcp-home-");
	mkdirSync(join(home, ".leanpi"), { recursive: true });
	return home;
}

export interface PermissionEnvLike {
	HOME: string;
	XDG_CONFIG_HOME: string;
}

/** The env a session needs to read *this* home and *this* permission store. */
export function mcpEnv(home: string): PermissionEnvLike {
	return { HOME: home, XDG_CONFIG_HOME: join(home, "xdg") };
}

export function writeUserMcpConfig(home: string, servers: Record<string, unknown>): string {
	const path = join(home, ".leanpi/mcp.json");
	mkdirSync(join(home, ".leanpi"), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
	return path;
}

export function writeProjectMcpConfig(cwd: string, servers: Record<string, unknown>): string {
	const path = join(cwd, ".leanpi/mcp.json");
	mkdirSync(join(cwd, ".leanpi"), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
	return path;
}

export interface StdioSpec {
	name: string;
	tools?: FixtureTool[];
	/** Config `tools` hints: what a never-connected server contributes. */
	hints?: string[];
	pinned?: boolean;
	projectDefault?: boolean;
	enabled?: boolean;
}

export interface StdioCall {
	server: string;
	tool: string;
	arguments: Record<string, unknown>;
}

export interface StdioFixture {
	entries: Record<string, unknown>;
	markerOf(name: string): string;
	logOf(name: string): string;
	started(name: string): boolean;
	/** The pid the fixture recorded at startup, while the marker is present. */
	pidOf(name: string): number | null;
	alive(name: string): boolean;
	callsOf(name: string): StdioCall[];
}

/** One config entry per spec, each pointing at the real fixture process. */
export function stdioFixtures(root: string, specs: StdioSpec[]): StdioFixture {
	mkdirSync(root, { recursive: true });
	const entries: Record<string, unknown> = {};
	const markerOf = (name: string): string => join(root, `${name}.marker`);
	const logOf = (name: string): string => join(root, `${name}.log.jsonl`);
	for (const spec of specs) {
		entries[spec.name] = {
			transport: "stdio",
			command: process.execPath,
			args: [STDIO_SERVER],
			env: {
				MCP_NAME: spec.name,
				MCP_MARKER: markerOf(spec.name),
				MCP_LOG: logOf(spec.name),
				MCP_TOOLS: JSON.stringify(spec.tools ?? []),
			},
			...(spec.hints ? { tools: spec.hints } : {}),
			...(spec.pinned ? { pinned: true } : {}),
			...(spec.projectDefault ? { default: true } : {}),
			...(spec.enabled === false ? { enabled: false } : {}),
		};
	}
	const pidOf = (name: string): number | null => {
		if (!existsSync(markerOf(name))) return null;
		const pid = Number.parseInt(readFileSync(markerOf(name), "utf8").trim(), 10);
		return Number.isNaN(pid) ? null : pid;
	};
	return {
		entries,
		markerOf,
		logOf,
		started: (name) => existsSync(markerOf(name)),
		pidOf,
		alive(name) {
			const pid = pidOf(name);
			if (pid === null) return false;
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		},
		callsOf(name) {
			if (!existsSync(logOf(name))) return [];
			return readFileSync(logOf(name), "utf8")
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as StdioCall);
		},
	};
}

export interface HttpFixture {
	url: string;
	/** Every request that reached the socket, in order. */
	requests: Array<{ method: string; authorized: boolean; rpc?: string }>;
	/** Every `tools/call` that reached the server. */
	calls: Array<{ tool: string; args: Record<string, unknown> }>;
	/** Require `Bearer <token>`; a request without it is refused with 401. */
	requireToken(token: string): void;
	/** Remove the accepted token: the server now refuses everything (an expired token). */
	expireToken(): void;
	close(): Promise<void>;
}

function rpcResponse(id: unknown, result: unknown): string {
	return JSON.stringify({ jsonrpc: "2.0", id, result });
}

export async function startHttpFixture(tools: FixtureTool[]): Promise<HttpFixture> {
	const requests: HttpFixture["requests"] = [];
	const calls: HttpFixture["calls"] = [];
	let accepted: string | null = null;
	let base = "";
	const server: Server = createServer((request, response) => {
		const url = request.url ?? "/";
		const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
			response.writeHead(status, { "content-type": "application/json", ...headers });
			response.end(JSON.stringify(body));
		};
		if (url.startsWith("/.well-known/oauth-authorization-server")) {
			json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
			return;
		}
		if (url.startsWith("/authorize")) {
			json(200, { ok: true });
			return;
		}
		let raw = "";
		request.on("data", (chunk) => (raw += chunk));
		request.on("end", () => {
			const rpc = (status: number, payload: string, headers: Record<string, string> = {}): void => {
				response.writeHead(status, { "content-type": "application/json", ...headers });
				response.end(payload);
			};
			const authorized = accepted === null || request.headers.authorization === `Bearer ${accepted}`;
			let body: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } = {};
			try {
				body = JSON.parse(raw) as typeof body;
			} catch {
				body = {};
			}
			requests.push({ method: request.method ?? "POST", authorized, ...(body.method ? { rpc: body.method } : {}) });
			if (!authorized) {
				json(401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-authorization-server"` });
				return;
			}
			switch (body.method) {
				case "initialize":
					rpc(200, rpcResponse(body.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1.0.0" } }), {
						"mcp-session-id": "fixture-session",
					});
					return;
				case "notifications/initialized":
					json(202, {});
					return;
				case "tools/list":
					rpc(200, rpcResponse(body.id, { tools }));
					return;
				case "tools/call":
					calls.push({ tool: String(body.params?.name ?? ""), args: body.params?.arguments ?? {} });
					rpc(200, rpcResponse(body.id, { content: [{ type: "text", text: `http/${body.params?.name ?? ""} ok` }], isError: false }));
					return;
				default:
					rpc(200, JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `unknown method ${body.method}` } }));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	base = `http://127.0.0.1:${port}`;
	return {
		url: `${base}/mcp`,
		requests,
		calls,
		requireToken: (token) => {
			accepted = token;
		},
		expireToken: () => {
			accepted = `expired-${Math.random()}`;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}

/** Write a server's full schemas the way `/mcp refresh` or a previous connect would. */
export function seedSchemaCache(cwd: string, servers: Record<string, FixtureTool[]>): void {
	for (const [server, tools] of Object.entries(servers)) {
		writeServerSchemas(cwd, server, tools as CachedTool[]);
	}
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await delay(20);
	}
	return predicate();
}

export interface JevHarness {
	stub: StubJev;
	client: JevClient;
	config: LeanPiConfig;
	cwd: string;
	close: () => Promise<void>;
}

/**
 * A real JEV client pointed at a stub endpoint, installed as the compiler
 * context, so `compileTask` and the MCP sites run the production path offline.
 */
export async function jevHarness(
	cwd: string,
	responders: StubJevResponder[],
	options: { env?: NodeJS.ProcessEnv; jevMode?: JevMode; overrides?: Partial<LeanPiConfig> } = {},
): Promise<JevHarness> {
	const stub = await startStubJev(responders);
	const config = loadConfig(
		cwd,
		{
			jev: { endpoint: stub.url, apiKey: "test-key", model: "jev-latest", mode: options.jevMode ?? "enabled" },
			...(options.overrides ?? {}),
		},
		options.env ?? process.env,
	);
	const client = createJevClient({ config, cwd });
	setCompilerContext({ client, config, cwd });
	return {
		stub,
		client,
		config,
		cwd,
		close: async () => {
			setCompilerContext(undefined);
			await stub.close();
		},
	};
}

export interface CatalogFixture {
	entries: Record<string, unknown>;
	tools: Record<string, FixtureTool[]>;
	/** `server/tool` ids in row order. */
	rows: string[];
	sentinels: string[];
}

/**
 * A ≥50-tool, ≥6-server catalog: `s1..sN`, nine tools each, one pinned server
 * and one project-default server. Rows come from the schema cache, so nothing
 * connects.
 */
export function catalogFixture(root: string, options: { servers?: number; pinned?: string[]; defaults?: string[] } = {}): CatalogFixture {
	const count = options.servers ?? 6;
	const pinned = options.pinned ?? ["s5"];
	const defaults = options.defaults ?? ["s6"];
	const entries: Record<string, unknown> = {};
	const tools: Record<string, FixtureTool[]> = {};
	const rows: string[] = [];
	const sentinels: string[] = [];
	for (let index = 1; index <= count; index += 1) {
		const server = `s${index}`;
		const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"];
		tools[server] = toolsFor(server, names);
		entries[server] = {
			transport: "stdio",
			command: process.execPath,
			args: [STDIO_SERVER],
			env: { MCP_NAME: server, MCP_MARKER: join(root, `${server}.marker`) },
			...(pinned.includes(server) ? { pinned: true } : {}),
			...(defaults.includes(server) ? { default: true } : {}),
		};
		for (const name of names) {
			rows.push(`${server}/${name}`);
			sentinels.push(sentinelOf(server, name));
		}
	}
	return { entries, tools, rows, sentinels };
}

export interface McpResponderSpec {
	/** Q1: does the task require any external capability? */
	any?: boolean;
	/** Q2: per-server relevance score (0-3); anything absent scores 0. */
	relevance?: Record<string, number>;
	/** Q3: `server/tool` ids the task needs; anything absent is rejected. */
	tools?: string[];
	/** The mid-task router's answer: an option key from the capability question. */
	capability?: string;
	confidence?: number;
}

/** Answers the `mcp.disclosure` questions and keeps the compiler's own sites sensible. */
export function mcpResponder(spec: McpResponderSpec): StubJevResponder {
	return (body) => {
		const questions = (body.questions ?? {}) as Record<string, { type?: string; criteria?: unknown }>;
		const answers: Record<string, unknown> = {};
		const confidence = spec.confidence ?? 0.95;
		for (const [id, question] of Object.entries(questions)) {
			const options = Array.isArray(question.criteria) ? [] : Object.keys((question.criteria ?? {}) as Record<string, unknown>);
			const choice = (value: string): void => {
				answers[id] = { type: "choice", choice: value, probabilities: { [value]: confidence }, confidence };
			};
			const score = (value: number): void => {
				answers[id] = { type: "score", score: value, legend: {}, probabilities: {}, confidence };
			};
			if (id === "any_mcp") choice(spec.any === false ? "no" : "yes");
			else if (id.startsWith("relevance:")) score(spec.relevance?.[id.slice("relevance:".length)] ?? 0);
			else if (id.startsWith("tool:")) choice((spec.tools ?? []).includes(id.slice("tool:".length)) ? "yes" : "no");
			else if (id === "capability") choice(spec.capability ?? "none");
			else if (question.type === "choice") choice(options.find((option) => option === "no") ?? options[0] ?? "no");
			else if (question.type === "score") score(1);
			else answers[id] = { type: "noul", noul: 0.9 };
		}
		return { answers };
	};
}
