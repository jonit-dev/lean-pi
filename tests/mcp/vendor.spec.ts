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
import type { SelectedMcpTool } from "../../src/mcp/select.js";
import { runExecutor } from "../../src/executor/index.js";
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

describe("PRD-045 Phase 3 — only `allow` reaches a vendor (AC-8)", () => {
	it("keeps the allowed tool, withholds the asked one, and names it in the resolution", () => {
		const resolved = resolveVendorServers({ tools: [tool("stub", "echo"), tool("stub", "other")], catalog: CATALOG, permissions: permissionsWithAllow() });
		expect(resolved.servers).toEqual([
			{ name: "stub", transport: "stdio", command: "/usr/bin/node", args: ["/tmp/stub.mjs"], env: { STUB_TOKEN: "s3cret" }, tools: ["mcp__stub__echo"] },
		]);
		expect(resolved.withheld).toEqual([{ capability: "mcp:stub/other", decision: "ask" }]);
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
