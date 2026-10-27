/**
 * PRD-045 Phase 3 — E3: the `allow`-only projection a vendor harness is handed.
 *
 * A vendor loop is outside PRD-017's guard and cannot prompt, so only tools the
 * guard resolves to `allow` may travel. Everything else is withheld and named in
 * an `mcp.withheld` site row on the executor outcome.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerTaskPacket } from "../../src/backends/worker.js";
import { clearCapabilityProviders, registerCapabilityProvider } from "../../src/compiler/index.js";
import { builtinPermissions, type PermissionsConfig } from "../../src/permissions/index.js";
import { resolveVendorServers } from "../../src/mcp/index.js";
import type { McpCatalog } from "../../src/mcp/index.js";
import type { SelectedMcpTool } from "../../src/mcp/select.js";
import { runExecutor } from "../../src/executor/index.js";
import { claudeMcpConfig, codexMcpArgs, opencodeMcpConfig } from "../../src/backends/harness.js";
import { fakeExec, harness, quickContract, VERIFY_COMMANDS } from "../executor/helpers.js";

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
	clearCapabilityProviders();
	while (open.length > 0) await open.pop()?.close();
});

function tool(server: string, name: string): SelectedMcpTool {
	return { server, transport: "stdio", tool: name, description: `${server}/${name}`, inputSchema: { type: "object" }, score: 1 };
}

const CATALOG = {
	servers: [],
	tools: [],
	entries: [
		{
			name: "stub",
			transport: "stdio" as const,
			scope: "project" as const,
			configPath: "fixture",
			command: "/usr/bin/node",
			args: ["/tmp/stub.mjs"],
			env: { STUB_TOKEN: "s3cret" },
			url: null,
			headers: {},
			tokenEnv: null,
			oauthClientId: null,
			tools: [],
			enabled: true,
			pinned: false,
			projectDefault: false,
		},
	],
	maxTools: 6,
	pinnedServers: [],
	projectDefaults: [],
};

/** The built-in `mcp: ask`, plus one explicit `allow` for `stub/echo`. */
function permissionsWithAllow(): PermissionsConfig {
	const base = builtinPermissions();
	return { ...base, rules: [...base.rules, { capability: "mcp:stub/echo", decision: "allow", source: "user" }] };
}

const VENDOR_TOKEN = "synthetic-vendor-mcp-token-7831";
const ENV_TOKEN = "synthetic-env-mcp-token-42";

/** The same catalog with two authenticated HTTP servers: one header, one tokenEnv reference. */
const AUTH_CATALOG: McpCatalog = {
	servers: [],
	tools: [],
	entries: [
		{
			name: "remote",
			transport: "http",
			scope: "user",
			configPath: "fixture",
			command: null,
			args: [],
			env: {},
			url: "https://mcp.example.com/api",
			headers: { Authorization: `Bearer ${VENDOR_TOKEN}` },
			tokenEnv: null,
			oauthClientId: null,
			tools: [],
			enabled: true,
			pinned: false,
			projectDefault: false,
		},
		{
			name: "remote-env",
			transport: "http",
			scope: "user",
			configPath: "fixture",
			command: null,
			args: [],
			env: {},
			url: "https://mcp.example.com/env",
			headers: {},
			tokenEnv: "AUDIT_MCP_TOKEN",
			oauthClientId: null,
			tools: [],
			enabled: true,
			pinned: false,
			projectDefault: false,
		},
	],
	maxTools: 6,
	pinnedServers: [],
	projectDefaults: [],
};

function permissionsWithHttpAllow(): PermissionsConfig {
	const base = builtinPermissions();
	return {
		...base,
		rules: [
			...base.rules,
			{ capability: "mcp:remote/echo", decision: "allow", source: "user" },
			{ capability: "mcp:remote-env/echo", decision: "allow", source: "user" },
		],
	};
}

describe("PRD-045 Phase 3 — only `allow` reaches a vendor (AC-8)", () => {
	it("keeps the allowed tool, withholds the asked one, and names it in the resolution", () => {
		const resolved = resolveVendorServers({ tools: [tool("stub", "echo"), tool("stub", "other")], catalog: CATALOG, permissions: permissionsWithAllow() });
		expect(resolved.servers).toEqual([
			{ name: "stub", transport: "stdio", command: "/usr/bin/node", args: ["/tmp/stub.mjs"], env: { STUB_TOKEN: "s3cret" }, tools: ["mcp__stub__echo"] },
		]);
		expect(resolved.withheld).toEqual([{ capability: "mcp:stub/other", decision: "ask" }]);
	});

	it("carries an HTTP server's configured authentication into every vendor form", () => {
		const tools = [tool("remote", "echo"), tool("remote-env", "echo")];
		const resolved = resolveVendorServers({ tools, catalog: AUTH_CATALOG, permissions: permissionsWithHttpAllow(), env: { AUDIT_MCP_TOKEN: ENV_TOKEN } });

		expect(resolved.servers).toEqual([
			{ name: "remote", transport: "http", url: "https://mcp.example.com/api", headers: { Authorization: `Bearer ${VENDOR_TOKEN}` }, tools: ["mcp__remote__echo"] },
			// A `tokenEnv` reference is resolved at the spawn boundary, not emitted as config.
			{ name: "remote-env", transport: "http", url: "https://mcp.example.com/env", headers: { authorization: `Bearer ${ENV_TOKEN}` }, tools: ["mcp__remote-env__echo"] },
		]);

		const forms = [claudeMcpConfig(resolved.servers), codexMcpArgs(resolved.servers).join(" "), opencodeMcpConfig(resolved.servers)];
		for (const form of forms) {
			expect(form).toContain(VENDOR_TOKEN);
			expect(form).toContain(ENV_TOKEN);
			expect(form).not.toContain(`Bearer $`);
		}
	});

	it("hands the worker only the allowed server and records the withheld tool as a site row", async () => {
		const h = await harness();
		open.push(h);
		clearCapabilityProviders();
		registerCapabilityProvider({ kind: "mcps", supply: async () => [tool("stub", "echo"), tool("stub", "other")] });
		const contract = await quickContract(h);
		expect(contract.capabilities.mcps).toHaveLength(2);

		const seen: WorkerTaskPacket[] = [];
		const outcome = await runExecutor(contract, {
			registry: h.registry,
			cwd: h.cwd,
			config: h.config,
			store: h.store,
			artifacts: h.artifacts,
			worker: async (packet) => {
				seen.push(packet);
				return { status: "completed", backend: "local", result: { status: "ok", changedFiles: [], summary: "done" }, attempts: [] };
			},
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
			reviewRunner: async () => ({ status: "ok", changedFiles: [], summary: JSON.stringify({ decision: "PASS", findings: [] }) }),
			mcpResolver: (tools) => resolveVendorServers({ tools, catalog: CATALOG, permissions: permissionsWithAllow() }),
		});

		expect(seen[0]!.mcpServers).toEqual([
			{ name: "stub", transport: "stdio", command: "/usr/bin/node", args: ["/tmp/stub.mjs"], env: { STUB_TOKEN: "s3cret" }, tools: ["mcp__stub__echo"] },
		]);
		expect(outcome.sites.filter((row) => row.site === "mcp.withheld")).toEqual([{ site: "mcp.withheld", answer: "mcp:stub/other:ask", fallbackUsed: false }]);
	});
});
