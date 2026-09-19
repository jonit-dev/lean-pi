/**
 * The out-of-context MCP catalog (PRD-006 Phase 1, ROADMAP §17).
 *
 * A server is worth ~one line of context: the catalog merges the trusted
 * user-scope and project-scope `mcp.json` files and produces *compact* records
 * (`server, transport, scope, tool, summary, risk`) — never a tool schema. Full
 * schemas stay on disk in `.leanpi/cache/mcp-catalog.json`, written after a
 * connection, and are read only for tools that were actually selected (§15).
 *
 * Nothing here connects to anything: a server with neither a cache entry nor
 * `tools` hints contributes zero rows and `tool count: 0` until `/mcp refresh`
 * gives it a cache entry (the cold-start escape hatch).
 *
 * Project-scope configuration is untrusted input. PRD-017's `assertTrusted()`
 * runs inside `loadConfig`, so this module reads the trust verdict and drops the
 * project-local files when the project is not trusted (ROADMAP §48) — it defines
 * no trust logic of its own.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { configPathFor } from "../core/config.js";
import type { LeanPiConfig } from "../core/types.js";
import { isProjectLocal } from "../permissions/index.js";

export type McpTransport = "stdio" | "http";
export type McpScope = "user" | "project";
export type McpHealth = "disconnected" | "connected" | "error" | "auth_required";

/** A `tools` hint from a config entry: the row a never-connected server contributes. */
export interface McpToolHint {
	name: string;
	summary: string;
	risk: string | null;
}

/** The compact catalog row. No schema, ever. */
export interface McpToolRecord {
	server: string;
	transport: McpTransport;
	scope: McpScope;
	tool: string;
	summary: string;
	risk: string | null;
}

/** One merged, enabled-or-not server, as `/mcp` renders it. */
export interface McpServerView {
	name: string;
	transport: McpTransport;
	scope: McpScope;
	enabled: boolean;
	pinned: boolean;
	projectDefault: boolean;
	health: McpHealth;
	lastError: string | null;
	authorizationUrl: string | null;
	toolCount: number;
}

/** A merged server entry; the client pool connects from exactly this. */
export interface McpServerEntry {
	name: string;
	transport: McpTransport;
	scope: McpScope;
	configPath: string;
	command: string | null;
	args: string[];
	env: Record<string, string>;
	url: string | null;
	headers: Record<string, string>;
	tokenEnv: string | null;
	oauthClientId: string | null;
	/** Config-provided hints; the cold-start row source. */
	tools: McpToolHint[];
	enabled: boolean;
	pinned: boolean;
	projectDefault: boolean;
}

export interface McpCatalog {
	/** Merged entries, disabled servers included, sorted by name. */
	servers: McpServerView[];
	/** Compact rows of *enabled* servers only. */
	tools: McpToolRecord[];
	entries: McpServerEntry[];
	maxTools: number;
	pinnedServers: string[];
	projectDefaults: string[];
}

/** Runtime enable/disable/pin state, persisted under `mcp.state` (a runtime knob). */
export interface McpStateEntry {
	enabled?: boolean;
	pinned?: boolean;
	default?: boolean;
}

export interface McpHealthRecord {
	health: McpHealth;
	lastError?: string;
	authorizationUrl?: string;
}

export const DEFAULT_MAX_TOOLS = 6;
export const DEFAULT_PROJECT_CONFIG = ".leanpi/mcp.json";
export const DEFAULT_USER_CONFIG = ".leanpi/mcp.json";

/**
 * `mcp.maxTools` / `mcp.state`, read structurally: the typed config block is an
 * integration concern, so the runtime knob also works straight off the config
 * file — that is what makes a `/mcp disable` survive a session resume.
 */
export function mcpConfigOf(config: LeanPiConfig, cwd?: string): { maxTools: number; state: Record<string, McpStateEntry> } {
	const block = (config as LeanPiConfig & { mcp?: { maxTools?: unknown; state?: unknown } }).mcp;
	const state: Record<string, McpStateEntry> = {};
	const persisted: unknown[] = [];
	if (cwd !== undefined) {
		const path = configPathFor(cwd);
		if (existsSync(path)) {
			try {
				const parsed = parseYaml(readFileSync(path, "utf8")) as { mcp?: { maxTools?: unknown; state?: unknown } } | null;
				persisted.push(parsed?.mcp?.maxTools);
				Object.assign(state, parseState(parsed?.mcp?.state));
			} catch {
				// A config that is being rewritten is not a reason to lose the defaults.
			}
		}
	}
	Object.assign(state, parseState(block?.state));
	const candidates = [...persisted, block?.maxTools];
	const maxTools = candidates.find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0) ?? DEFAULT_MAX_TOOLS;
	return { maxTools, state };
}

function parseState(raw: unknown): Record<string, McpStateEntry> {
	const state: Record<string, McpStateEntry> = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return state;
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const entry = value as Record<string, unknown>;
		state[name] = {
			...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
			...(typeof entry.pinned === "boolean" ? { pinned: entry.pinned } : {}),
			...(typeof entry.default === "boolean" ? { default: entry.default } : {}),
		};
	}
	return state;
}

/** Persist `/mcp enable|disable` without disturbing unrelated config keys. */
export function writeMcpState(cwd: string, state: Record<string, McpStateEntry>): void {
	const path = configPathFor(cwd);
	const parsed = existsSync(path) ? (parseYaml(readFileSync(path, "utf8")) as unknown) : undefined;
	const root = parsed === undefined || parsed === null ? {} : (parsed as Record<string, unknown>);
	const currentRaw = root.mcp;
	const current = currentRaw && typeof currentRaw === "object" && !Array.isArray(currentRaw) ? (currentRaw as Record<string, unknown>) : {};
	root.mcp = { ...current, state };
	writeFileSync(path, stringifyYaml(root));
}

export function schemaCachePath(cwd: string): string {
	return join(cwd, ".leanpi", "cache", "mcp-catalog.json");
}

export interface CachedTool {
	name: string;
	description: string;
	inputSchema: unknown;
}

/** `{ servers: { [name]: { updatedAt, tools: [...] } } }`; tolerant of a corrupt file. */
export function readSchemaCache(cwd: string): Record<string, CachedTool[]> {
	const path = schemaCachePath(cwd);
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as { servers?: Record<string, { tools?: unknown }> };
		const servers = parsed.servers ?? {};
		const result: Record<string, CachedTool[]> = {};
		for (const [name, value] of Object.entries(servers)) {
			const tools = Array.isArray(value?.tools) ? value.tools : [];
			result[name] = tools
				.filter((tool): tool is CachedTool => Boolean(tool) && typeof (tool as CachedTool).name === "string")
				.map((tool) => ({ name: tool.name, description: typeof tool.description === "string" ? tool.description : "", inputSchema: tool.inputSchema ?? {} }));
		}
		return result;
	} catch {
		return {};
	}
}

/** Write one server's full schemas; other servers' entries are preserved. */
export function writeServerSchemas(cwd: string, server: string, tools: CachedTool[]): void {
	const path = schemaCachePath(cwd);
	const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
	const servers = (existing.servers ?? {}) as Record<string, unknown>;
	servers[server] = { updatedAt: new Date().toISOString(), tools };
	existing.servers = servers;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
}

/**
 * The config files the catalog reads: user scope always, project scope only
 * while the project is trusted. A declared path outside the project is user
 * scope by definition and is kept, mirroring `loadConfig`'s skill-root filter.
 */
export function resolveConfigPaths(cwd: string, config: LeanPiConfig, home: string = homedir()): { user: string[]; project: string[] } {
	const declared = config.capabilities.mcpConfigPaths ?? [];
	const user = [join(home, DEFAULT_USER_CONFIG), ...declared.filter((entry) => !isProjectLocal(cwd, entry))];
	const local = declared.filter((entry) => isProjectLocal(cwd, entry)).map((entry) => (isAbsolute(entry) ? resolve(entry) : resolve(cwd, entry)));
	const project = local.length > 0 ? local : [resolve(cwd, DEFAULT_PROJECT_CONFIG)];
	return {
		user: [...new Set(user)],
		project: config.permissions.trust.trusted ? [...new Set(project)] : [],
	};
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringMap(value: unknown): Record<string, string> {
	const source = record(value);
	if (!source) return {};
	return Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function hints(value: unknown): McpToolHint[] {
	if (!Array.isArray(value)) return [];
	const result: McpToolHint[] = [];
	for (const entry of value) {
		if (typeof entry === "string" && entry.length > 0) {
			result.push({ name: entry, summary: "", risk: null });
			continue;
		}
		const object = record(entry);
		if (!object || typeof object.name !== "string" || object.name.length === 0) continue;
		result.push({
			name: object.name,
			summary: typeof object.summary === "string" ? object.summary : typeof object.description === "string" ? object.description : "",
			risk: typeof object.risk === "string" ? object.risk : null,
		});
	}
	return result;
}

/** Parse one `mcp.json` into entries; an entry that cannot ever connect is skipped. */
export function parseServerEntries(path: string, scope: McpScope, state: Record<string, McpStateEntry> = {}): McpServerEntry[] {
	if (!existsSync(path)) return [];
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return [];
	}
	const servers = record(parsed.mcpServers) ?? record(parsed.servers) ?? {};
	const entries: McpServerEntry[] = [];
	for (const [name, value] of Object.entries(servers)) {
		const entry = record(value);
		if (!entry) continue;
		const command = typeof entry.command === "string" && entry.command.length > 0 ? entry.command : null;
		const url = typeof entry.url === "string" && entry.url.length > 0 ? entry.url : null;
		const declared = entry.transport ?? entry.type;
		const transport: McpTransport | null =
			declared === "http" || declared === "streamable-http" || declared === "sse" ? "http" : declared === "stdio" ? "stdio" : command ? "stdio" : url ? "http" : null;
		if (transport === null || (transport === "stdio" && command === null) || (transport === "http" && url === null)) continue;
		const oauth = record(entry.oauth);
		const runtime = state[name] ?? {};
		entries.push({
			name,
			transport,
			scope,
			configPath: path,
			command,
			args: Array.isArray(entry.args) ? entry.args.map(String) : [],
			env: stringMap(entry.env),
			url,
			headers: stringMap(entry.headers),
			tokenEnv: typeof entry.tokenEnv === "string" ? entry.tokenEnv : null,
			oauthClientId: oauth && typeof oauth.clientId === "string" ? oauth.clientId : null,
			tools: hints(entry.tools),
			enabled: runtime.enabled ?? (entry.enabled !== false),
			pinned: runtime.pinned ?? entry.pinned === true,
			projectDefault: runtime.default ?? entry.default === true,
		});
	}
	return entries;
}

export interface BuildCatalogOptions {
	cwd: string;
	config: LeanPiConfig;
	/** `$HOME` used to resolve the user-scope file; defaults to `os.homedir()`. */
	home?: string;
	/** Health records from the connection pool, when one exists. */
	health?: Record<string, McpHealthRecord>;
}

/**
 * Merge user scope then project scope (project shadows user for the same server
 * name) and build the compact rows. Never connects; never reads a schema.
 */
export function buildCatalog(options: BuildCatalogOptions): McpCatalog {
	const { cwd, config } = options;
	const { maxTools, state } = mcpConfigOf(config, cwd);
	const paths = resolveConfigPaths(cwd, config, options.home);
	const cache = readSchemaCache(cwd);
	const byName = new Map<string, McpServerEntry>();
	for (const path of paths.user) for (const entry of parseServerEntries(path, "user", state)) byName.set(entry.name, entry);
	for (const path of paths.project) for (const entry of parseServerEntries(path, "project", state)) byName.set(entry.name, entry);

	const entries = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
	const tools: McpToolRecord[] = [];
	const servers: McpServerView[] = [];
	for (const entry of entries) {
		const cached = cache[entry.name];
		// A connected server's cache is authoritative; hints stand in until then.
		const rows = cached && cached.length > 0
			? cached.map((tool) => ({ name: tool.name, summary: tool.description, risk: null as string | null }))
			: entry.tools;
		const health = options.health?.[entry.name] ?? { health: "disconnected" as McpHealth };
		servers.push({
			name: entry.name,
			transport: entry.transport,
			scope: entry.scope,
			enabled: entry.enabled,
			pinned: entry.pinned,
			projectDefault: entry.projectDefault,
			health: health.health,
			lastError: health.lastError ?? null,
			authorizationUrl: health.authorizationUrl ?? null,
			toolCount: rows.length,
		});
		if (!entry.enabled) continue;
		for (const row of rows) {
			tools.push({ server: entry.name, transport: entry.transport, scope: entry.scope, tool: row.name, summary: row.summary, risk: row.risk });
		}
	}
	return {
		servers,
		tools,
		entries,
		maxTools,
		pinnedServers: entries.filter((entry) => entry.enabled && entry.pinned).map((entry) => entry.name),
		projectDefaults: entries.filter((entry) => entry.enabled && entry.projectDefault).map((entry) => entry.name),
	};
}

/** The `/mcp` listing: transport, scope, enabled state, health and tool count per server. */
export function renderCatalog(catalog: McpCatalog): string {
	if (catalog.servers.length === 0) return "no MCP servers configured";
	const lines = catalog.servers.map((server) => {
		const fields = [
			`transport: ${server.transport}`,
			`scope: ${server.scope}`,
			`enabled: ${server.enabled}`,
			`health: ${server.health}`,
			`tool count: ${server.toolCount}`,
		];
		if (server.authorizationUrl) fields.push(`authorization url: ${server.authorizationUrl}`);
		if (server.lastError) fields.push(`last error: ${server.lastError}`);
		return `  - ${server.name} (${fields.join(", ")})`;
	});
	return ["mcp servers:", ...lines].join("\n");
}
