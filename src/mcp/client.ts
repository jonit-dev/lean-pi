/**
 * The lazy MCP connection pool (PRD-006 Phase 2, ROADMAP §17).
 *
 * `getClient(server)` spawns the stdio child or opens the HTTP session on **first
 * actual tool use** — never at session start, never while the catalog is built.
 * Health (`disconnected` / `connected` / `error` / `auth_required`) and the last
 * error are recorded for `/mcp`, and a server that cannot authenticate is
 * skipped rather than failing the task.
 *
 * ponytail: `@modelcontextprotocol/sdk` is not a dependency of this package and
 * this PRD may not add one, so the wire protocol (JSON-RPC 2.0 over stdio lines
 * or streamable HTTP POST) is implemented directly here. Upgrade path: replace
 * `connectStdio`/`connectHttp` with the SDK's `StdioClientTransport` /
 * `StreamableHTTPClientTransport` when the dependency lands — the pool's surface
 * is the integration point, and nothing else changes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LEANPI_VERSION } from "../core/package-info.js";
import { writeServerSchemas, type CachedTool, type McpHealth, type McpHealthRecord, type McpServerEntry } from "./catalog.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_REQUEST_TIMEOUT_MS = 20_000;
/** The loopback redirect the SDK's OAuth provider would use; the exchange itself is PRD P1. */
export const MCP_REDIRECT_URI = "http://127.0.0.1:33418/callback";

/** A server that needs an interactive authorization before it can be used (FR-083). */
export class McpAuthRequiredError extends Error {
	constructor(
		message: string,
		readonly authorizationUrl: string | null,
	) {
		super(message);
		this.name = "McpAuthRequiredError";
	}
}

export interface ToolCallResult {
	content: unknown;
	isError: boolean;
}

export interface McpClientHandle {
	readonly server: string;
	readonly transport: McpServerEntry["transport"];
	listTools(): Promise<CachedTool[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
	close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The OAuth/token store
// ---------------------------------------------------------------------------

export function authStorePath(cwd: string): string {
	return join(cwd, ".leanpi", "mcp-auth.json");
}

/** `{ [server]: { access_token } }`; a bare string is accepted as the same thing. */
export function readMcpTokens(cwd: string): Record<string, string> {
	const path = authStorePath(cwd);
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const tokens: Record<string, string> = {};
		for (const [server, value] of Object.entries(parsed)) {
			if (typeof value === "string") tokens[server] = value;
			else if (value && typeof value === "object" && typeof (value as { access_token?: unknown }).access_token === "string") {
				tokens[server] = (value as { access_token: string }).access_token;
			}
		}
		return tokens;
	} catch {
		return {};
	}
}

export function writeMcpToken(cwd: string, server: string, token: string): void {
	const path = authStorePath(cwd);
	const parsed = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
	parsed[server] = { access_token: token };
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
}

export function clearMcpToken(cwd: string, server: string): void {
	const path = authStorePath(cwd);
	if (!existsSync(path)) return;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	delete parsed[server];
	writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
}

/** The token the HTTP transport will send: config `tokenEnv` first, then the store. */
export function resolveToken(entry: McpServerEntry, cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
	if (entry.tokenEnv) {
		const fromEnv = env[entry.tokenEnv];
		if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	}
	const stored = readMcpTokens(cwd)[entry.name];
	return stored && stored.length > 0 ? stored : null;
}

/**
 * The URL the SDK's OAuth provider would send the user to: discovered from the
 * server's own metadata endpoint, with PKCE placeholders. Discovery is
 * best-effort — an unreachable metadata document yields `null`, never a throw.
 */
export async function authorizationUrlFor(entry: McpServerEntry, timeoutMs = MCP_REQUEST_TIMEOUT_MS): Promise<string | null> {
	if (!entry.url) return null;
	const digest = createHash("sha256").update(`${entry.name}:${entry.url}`).digest("base64url");
	let endpoint: string | null = null;
	try {
		const metadata = await fetch(new URL("/.well-known/oauth-authorization-server", entry.url).toString(), {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (metadata.ok) {
			const body = (await metadata.json()) as { authorization_endpoint?: unknown };
			if (typeof body.authorization_endpoint === "string") endpoint = body.authorization_endpoint;
		}
	} catch {
		endpoint = null;
	}
	if (endpoint === null) return null;
	const url = new URL(endpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", entry.oauthClientId ?? "leanpi");
	url.searchParams.set("redirect_uri", MCP_REDIRECT_URI);
	url.searchParams.set("state", digest.slice(0, 16));
	url.searchParams.set("code_challenge", digest);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

interface RpcMessage {
	id?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string };
}

function errorOf(message: RpcMessage): Error {
	return new Error(message.error?.message ?? `MCP error ${message.error?.code ?? "unknown"}`);
}

/** A request/response channel over a line-oriented stdio server. */
class StdioChannel {
	private nextId = 1;
	private dead: Error | null = null;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

	constructor(
		private readonly write: (line: string) => void,
		private readonly timeoutMs: number,
	) {}

	notify(method: string, params: unknown): void {
		this.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
	}

	request(method: string, params: unknown): Promise<unknown> {
		// A server that exited fails its next call at once instead of stalling it
		// until the timeout.
		if (this.dead) return Promise.reject(this.dead);
		const id = this.nextId++;
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method}: the MCP server did not answer within ${this.timeoutMs}ms`));
			}, this.timeoutMs);
			timer.unref();
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
			} catch (error) {
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	settle(message: RpcMessage): void {
		if (typeof message.id !== "number") return;
		const entry = this.pending.get(message.id);
		if (!entry) return;
		this.pending.delete(message.id);
		clearTimeout(entry.timer);
		if (message.error) entry.reject(errorOf(message));
		else entry.resolve(message.result);
	}

	fail(error: Error): void {
		this.dead ??= error;
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}
}

/** `tools/list` / `tools/call` result shapes, tolerated leniently. */
function toolsOf(result: unknown): CachedTool[] {
	const tools = (result as { tools?: unknown })?.tools;
	if (!Array.isArray(tools)) return [];
	return tools
		.filter((tool): tool is { name: string; description?: unknown; inputSchema?: unknown } => Boolean(tool) && typeof (tool as { name?: unknown }).name === "string")
		.map((tool) => ({
			name: tool.name,
			description: typeof tool.description === "string" ? tool.description : "",
			inputSchema: tool.inputSchema ?? {},
		}));
}

function callResultOf(result: unknown): ToolCallResult {
	const value = (result ?? {}) as { content?: unknown; isError?: unknown };
	return { content: value.content ?? [], isError: value.isError === true };
}

async function handshake(request: (method: string, params: unknown) => Promise<unknown>, notify: () => void | Promise<void>): Promise<void> {
	await request("initialize", {
		protocolVersion: MCP_PROTOCOL_VERSION,
		capabilities: {},
		clientInfo: { name: "leanpi", version: LEANPI_VERSION },
	});
	await notify();
}

async function connectStdio(entry: McpServerEntry, cwd: string, timeoutMs: number): Promise<McpClientHandle> {
	const child: ChildProcess = spawn(entry.command!, entry.args, {
		cwd,
		env: { ...process.env, ...entry.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000);
	});
	const channel = new StdioChannel((line) => child.stdin!.write(`${line}\n`), timeoutMs);
	child.stdin?.on("error", (error: Error) => channel.fail(error));
	let buffer = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let index = buffer.indexOf("\n");
		while (index !== -1) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (line.length > 0) {
				try {
					channel.settle(JSON.parse(line) as RpcMessage);
				} catch {
					// A non-JSON line on stdout is server noise, not a protocol message.
				}
			}
			index = buffer.indexOf("\n");
		}
	});
	child.on("error", (error) => channel.fail(error));
	child.on("exit", (code) => channel.fail(new Error(`MCP server "${entry.name}" exited (code ${code ?? "signal"}): ${stderr.trim().slice(0, 200)}`)));

	const close = async (): Promise<void> => {
		channel.fail(new Error(`MCP server "${entry.name}" disconnected`));
		child.stdin?.end();
		if (child.exitCode === null && child.signalCode === null) child.kill();
	};
	try {
		await handshake(
			(method, params) => channel.request(method, params),
			() => channel.notify("notifications/initialized", {}),
		);
	} catch (error) {
		await close();
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(stderr.trim().length > 0 ? `${message} (stderr: ${stderr.trim().slice(0, 200)})` : message);
	}
	return {
		server: entry.name,
		transport: "stdio",
		async listTools() {
			return toolsOf(await channel.request("tools/list", {}));
		},
		async callTool(name, args) {
			return callResultOf(await channel.request("tools/call", { name, arguments: args }));
		},
		close,
	};
}

/** The streamable-HTTP transport: one POST per message, session id echoed back. */
async function connectHttp(entry: McpServerEntry, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<McpClientHandle> {
	const token = resolveToken(entry, cwd, env);
	if (token === null) throw new McpAuthRequiredError(`MCP server "${entry.name}" requires authorization`, await authorizationUrlFor(entry, timeoutMs));
	const session = { id: null as string | null };
	let nextId = 1;

	const post = async (payload: Record<string, unknown>): Promise<Response> => {
		const response = await fetch(entry.url!, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${token}`,
				...entry.headers,
				...(session.id ? { "mcp-session-id": session.id } : {}),
			},
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const header = response.headers.get("mcp-session-id");
		if (header) session.id = header;
		return response;
	};

	const request = async (method: string, params: unknown): Promise<unknown> => {
		const response = await post({ jsonrpc: "2.0", id: nextId++, method, params });
		if (response.status === 401 || response.status === 403) {
			throw new McpAuthRequiredError(`MCP server "${entry.name}" rejected the stored token (HTTP ${response.status})`, await authorizationUrlFor(entry, timeoutMs));
		}
		if (!response.ok) throw new Error(`MCP server "${entry.name}" answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
		const text = await response.text();
		const contentType = response.headers.get("content-type") ?? "";
		const lines = contentType.includes("text/event-stream") ? text.split("\n").filter((line) => line.startsWith("data:")) : [text];
		for (const line of lines.reverse()) {
			const raw = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
			if (raw.length === 0) continue;
			try {
				const message = JSON.parse(raw) as RpcMessage;
				if (message.error) throw errorOf(message);
				if (message.result !== undefined) return message.result;
			} catch (error) {
				if (error instanceof SyntaxError) continue;
				throw error;
			}
		}
		throw new Error(`MCP server "${entry.name}" returned no JSON-RPC result for ${method}`);
	};

	try {
		await handshake(request, async () => {
			await post({ jsonrpc: "2.0", method: "notifications/initialized" });
		});
	} catch (error) {
		if (error instanceof McpAuthRequiredError) throw error;
		throw new Error(error instanceof Error ? error.message : String(error));
	}
	return {
		server: entry.name,
		transport: "http",
		listTools: async () => toolsOf(await request("tools/list", {})),
		callTool: async (name, args) => callResultOf(await request("tools/call", { name, arguments: args })),
		close: async () => undefined,
	};
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

export interface McpPoolOptions {
	cwd: string;
	/** The merged entries, resolved per call so a `/mcp disable` is visible at once. */
	servers: () => McpServerEntry[];
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	/** Health observer, e.g. a `/mcp` renderer or a test's marker check. */
	onHealth?: (server: string, record: McpHealthRecord) => void;
}

export interface McpRefreshResult {
	server: string;
	transport: McpServerEntry["transport"];
	tools: number;
	error?: string;
}

export interface McpPool {
	/** Health per server, for `/mcp`. */
	health(): Record<string, McpHealthRecord>;
	isConnected(server: string): boolean;
	getClient(server: string): Promise<McpClientHandle>;
	listTools(server: string): Promise<CachedTool[]>;
	callTool(server: string, tool: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
	/** Connect → `tools/list` → write the schema cache → disconnect. */
	refresh(server?: string): Promise<McpRefreshResult[]>;
	disconnect(server: string): Promise<void>;
	disconnectAll(): Promise<void>;
}

export function createMcpPool(options: McpPoolOptions): McpPool {
	const env = options.env ?? process.env;
	const timeoutMs = options.timeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
	const connections = new Map<string, McpClientHandle>();
	const pending = new Map<string, Promise<McpClientHandle>>();
	const health = new Map<string, McpHealthRecord>();

	const record = (server: string, next: McpHealth): void => {
		const previous = health.get(server);
		const entry: McpHealthRecord = { health: next, ...(previous?.lastError ? { lastError: previous.lastError } : {}) };
		if (next === "connected" || next === "disconnected") delete entry.lastError;
		health.set(server, entry);
		options.onHealth?.(server, entry);
	};

	const entryFor = (server: string): McpServerEntry => {
		const entry = options.servers().find((candidate) => candidate.name === server);
		if (!entry) throw new Error(`unknown MCP server "${server}"`);
		if (!entry.enabled) throw new Error(`MCP server "${server}" is disabled`);
		return entry;
	};

	const fail = async (server: string, error: unknown): Promise<never> => {
		if (error instanceof McpAuthRequiredError) {
			health.set(server, { health: "auth_required", lastError: error.message, ...(error.authorizationUrl ? { authorizationUrl: error.authorizationUrl } : {}) });
			options.onHealth?.(server, health.get(server)!);
		} else {
			const message = error instanceof Error ? error.message : String(error);
			health.set(server, { health: "error", lastError: message });
			options.onHealth?.(server, health.get(server)!);
		}
		throw error;
	};

	const getClient = async (server: string): Promise<McpClientHandle> => {
		const connected = connections.get(server);
		if (connected) return connected;
		const inFlight = pending.get(server);
		if (inFlight) return inFlight;
		const entry = entryFor(server);
		const promise = (entry.transport === "stdio" ? connectStdio(entry, options.cwd, timeoutMs) : connectHttp(entry, options.cwd, env, timeoutMs))
			.then((handle) => {
				connections.set(server, handle);
				record(server, "connected");
				return handle;
			})
			.catch(async (error: unknown) => fail(server, error))
			.finally(() => pending.delete(server));
		pending.set(server, promise);
		return promise;
	};

	const disconnect = async (server: string): Promise<void> => {
		const handle = connections.get(server);
		connections.delete(server);
		if (handle) await handle.close();
		record(server, "disconnected");
	};

	const targets = (server?: string): McpServerEntry[] => {
		if (server !== undefined) return [entryFor(server)];
		return options.servers().filter((entry) => entry.enabled);
	};

	return {
		health: () => Object.fromEntries(health.entries()),
		isConnected: (server) => connections.has(server),
		getClient,
		async listTools(server) {
			return (await getClient(server)).listTools();
		},
		async callTool(server, tool, args = {}) {
			return (await getClient(server)).callTool(tool, args);
		},
		async refresh(server) {
			const results: McpRefreshResult[] = [];
			for (const entry of targets(server)) {
				try {
					const tools = await (await getClient(entry.name)).listTools();
					writeServerSchemas(options.cwd, entry.name, tools);
					results.push({ server: entry.name, transport: entry.transport, tools: tools.length });
				} catch (error) {
					results.push({ server: entry.name, transport: entry.transport, tools: 0, error: error instanceof Error ? error.message : String(error) });
				} finally {
					// The cold-start cycle never leaves a process or session held open.
					await disconnect(entry.name);
				}
			}
			return results;
		},
		disconnect,
		async disconnectAll() {
			for (const server of [...connections.keys()]) await disconnect(server);
		},
	};
}
