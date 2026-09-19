/**
 * The `/mcp` command surface (PRD-006 Phases 1 and 2).
 *
 * `/mcp` lists the merged catalog with transport, scope, enabled state, health
 * and tool count; `/mcp enable|disable <server>` persists the runtime knob and
 * drops (or restores) the server's rows; `/mcp refresh [<server>]` is the single
 * cold-start escape hatch — connect → `tools/list` → write cache → disconnect —
 * which is what makes a hint-less, never-connected server reachable at all.
 *
 * `registerMcpCommand` registers the handler and returns the runtime it built:
 * the same pool serves tool invocation, so a lazily connected server is reused
 * rather than respawned.
 */
import type { CommandRegistry, CommandResult } from "../commands/registry.js";
import type { LeanPiConfig } from "../core/types.js";
import { buildCatalog, mcpConfigOf, renderCatalog, writeMcpState, type McpCatalog, type McpStateEntry } from "./catalog.js";
import { createMcpPool, type McpPool } from "./client.js";

export interface McpCommandDeps {
	cwd: string;
	config: LeanPiConfig;
	/** `$HOME` for the user-scope config file; defaults to `os.homedir()`. */
	home?: string;
	env?: NodeJS.ProcessEnv;
	/** Share the session's pool; one is created when absent. */
	pool?: McpPool;
}

export interface McpRuntime {
	/** Rebuilt per call, so a `/mcp disable` and a `/mcp refresh` are visible at once. */
	catalog(): McpCatalog;
	pool: McpPool;
}

const USAGE = "usage: /mcp [enable <server> | disable <server> | refresh [<server>]]";

export function registerMcpCommand(commands: CommandRegistry, deps: McpCommandDeps): McpRuntime {
	const { config } = deps;
	const home = deps.home;
	// The runtime's own copy of `mcp.state`: the loaded config is a snapshot, and a
	// `/mcp disable` must be visible to the very next catalog build.
	const state: Record<string, McpStateEntry> = { ...mcpConfigOf(config, deps.cwd).state };
	const withState = (): LeanPiConfig =>
		({
			...config,
			mcp: { ...(config as LeanPiConfig & { mcp?: Record<string, unknown> }).mcp, state },
		}) as LeanPiConfig;

	const pool =
		deps.pool ??
		createMcpPool({
			cwd: deps.cwd,
			servers: () => buildCatalog({ cwd: deps.cwd, config: withState(), ...(home === undefined ? {} : { home }) }).entries,
			...(deps.env ? { env: deps.env } : {}),
		});
	const catalog = (): McpCatalog => buildCatalog({ cwd: deps.cwd, config: withState(), ...(home === undefined ? {} : { home }), health: pool.health() });

	const setEnabled = async (name: string, enabled: boolean): Promise<CommandResult> => {
		const current = catalog();
		const known = current.servers.map((server) => server.name);
		if (!known.includes(name)) {
			return { ok: false, text: `mcp: no server named "${name}" (configured: ${known.join(", ") || "none"})` };
		}
		state[name] = { ...state[name], enabled };
		writeMcpState(deps.cwd, state);
		// A disabled server is never connected, so an open connection is dropped now.
		if (!enabled) await pool.disconnect(name);
		return { ok: true, text: `mcp: ${name} ${enabled ? "enabled" : "disabled"} (persisted to leanpi.config.yaml)` };
	};

	commands.register("mcp", async (args): Promise<CommandResult> => {
		const [action, target] = args.split(/\s+/).filter((token) => token.length > 0);
		if (action === undefined) return { ok: true, text: renderCatalog(catalog()) };
		if (action === "enable" || action === "disable") {
			if (target === undefined) return { ok: false, text: `${USAGE}\n${renderCatalog(catalog())}` };
			return setEnabled(target, action === "enable");
		}
		if (action === "refresh") {
			try {
				const results = await pool.refresh(target);
				const lines = results.map((result) =>
					result.error ? `mcp: ${result.server} refresh failed: ${result.error}` : `mcp: ${result.server} refreshed (${result.tools} tools, disconnected afterwards)`,
				);
				return { ok: !results.some((result) => result.error !== undefined), text: [lines.join("\n"), renderCatalog(catalog())].join("\n") };
			} catch (error) {
				return { ok: false, text: `mcp: refresh failed: ${error instanceof Error ? error.message : String(error)}` };
			}
		}
		return { ok: false, text: USAGE };
	});

	return { pool, catalog };
}
