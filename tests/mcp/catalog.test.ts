/**
 * PRD-006 Phase 1 — AC-1, AC-2: the merged scope catalog and `/mcp`.
 *
 * Everything goes through the real command entry point (`createCommandRegistry`
 * + `/mcp`) and the real stdio fixture process, which records its own startup.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandRegistry, grantTrust, loadConfig } from "../../src/index.js";
import { registerMcpCommand, type McpRuntime } from "../../src/mcp/index.js";
import { nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { mcpEnv, stdioFixtures, tempHome, writeProjectMcpConfig, writeUserMcpConfig } from "./helpers.js";

const runtimes: McpRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.pool.disconnectAll();
});

function baseConfig(cwd: string): void {
	writeConfig(cwd, { backends: { local: nativeBackend("http://127.0.0.1:1/v1") }, models: { balanced: { backend: "local", model: "stub" } } });
}

/** The persisted runtime knob, read straight off the config file a resume would load. */
function persistedState(cwd: string): Record<string, { enabled?: boolean }> {
	const doc = parseYaml(readFileSync(join(cwd, "leanpi.config.yaml"), "utf8")) as { mcp?: { state?: Record<string, { enabled?: boolean }> } };
	return doc.mcp?.state ?? {};
}

function track(runtime: McpRuntime): McpRuntime {
	runtimes.push(runtime);
	return runtime;
}

describe("PRD-006 AC-1 — `/mcp` lists the merged user and project scope", () => {
	it("shows transport, scope, enabled state, health and tool count; a duplicate name resolves to project", async () => {
		const home = tempHome();
		const cwd = tempDir("leanpi-mcp-catalog-");
		const env = mcpEnv(home);
		const user = stdioFixtures(join(cwd, "user-fixtures"), [{ name: "files", hints: ["read_file", "write_file"] }]);
		writeUserMcpConfig(home, { ...user.entries, "remote-api": { transport: "http", url: "http://127.0.0.1:9/mcp", tools: ["query"] } });
		// The project copy of `files` shadows the user copy; it is also the one whose
		// tool count the listing must report.
		const project = stdioFixtures(join(cwd, "project-fixtures"), [{ name: "files", hints: ["project_read", "project_write", "project_search"] }]);
		writeProjectMcpConfig(cwd, project.entries);
		writeConfig(cwd, {
			backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
			models: { balanced: { backend: "local", model: "stub" } },
			capabilities: { mcpConfigPaths: [".leanpi/mcp.json"] },
		});
		grantTrust(cwd, env, { mcpConfigPaths: [".leanpi/mcp.json"] });
		const config = loadConfig(cwd, {}, env);
		expect(config.permissions.trust.trusted).toBe(true);

		const registry = createCommandRegistry();
		const runtime = track(registerMcpCommand(registry, { cwd, config, home }));
		const result = await registry.dispatch("/mcp", { cwd });

		expect(result.ok).toBe(true);
		expect(result.text).toContain("transport: stdio");
		expect(result.text).toContain("transport: http");
		expect(result.text).toContain("scope: user");
		expect(result.text).toContain("scope: project");
		expect(result.text).toContain("enabled: true");
		expect(result.text).toContain("health: disconnected");
		expect(result.text).toContain("tool count: 3");
		expect(result.text).toContain("tool count: 1");
		expect(result.text.match(/- files \(/g)).toHaveLength(1);

		const catalog = runtime.catalog();
		expect(catalog.servers.map((server) => server.name)).toEqual(["files", "remote-api"]);
		expect(catalog.servers.find((server) => server.name === "files")).toMatchObject({ scope: "project", transport: "stdio", toolCount: 3 });
		expect(catalog.servers.find((server) => server.name === "remote-api")).toMatchObject({ scope: "user", transport: "http", toolCount: 1 });
		// The project hints are the rows, so the shadow really happened.
		expect(catalog.tools.map((tool) => `${tool.server}/${tool.tool}`)).toContain("files/project_read");
		expect(catalog.tools.map((tool) => `${tool.server}/${tool.tool}`)).not.toContain("files/read_file");
		expect(catalog.tools).toHaveLength(4);
		// Nothing connected: the catalog is out of band.
		expect(user.started("files")).toBe(false);
		expect(project.started("files")).toBe(false);

		// Negative control: an empty config pair yields zero rows.
		const emptyHome = tempHome();
		const emptyCwd = tempDir("leanpi-mcp-empty-");
		baseConfig(emptyCwd);
		const emptyConfig = loadConfig(emptyCwd, {}, mcpEnv(emptyHome));
		const emptyRegistry = createCommandRegistry();
		const emptyRuntime = track(registerMcpCommand(emptyRegistry, { cwd: emptyCwd, config: emptyConfig, home: emptyHome }));
		expect(emptyRuntime.catalog().tools).toHaveLength(0);
		expect((await emptyRegistry.dispatch("/mcp", { cwd: emptyCwd })).text).toBe("no MCP servers configured");
	});

	it("drops the project-local mcp.json while the project is untrusted (PRD-017's gate)", async () => {
		const home = tempHome();
		const cwd = tempDir("leanpi-mcp-untrusted-");
		const env = mcpEnv(home);
		const user = stdioFixtures(join(cwd, "user-fixtures"), [{ name: "files", hints: ["read_file"] }]);
		writeUserMcpConfig(home, user.entries);
		writeProjectMcpConfig(cwd, { files: { transport: "stdio", command: "/bin/false", tools: ["project_read", "project_write"] } });
		writeConfig(cwd, {
			backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
			models: { balanced: { backend: "local", model: "stub" } },
			capabilities: { mcpConfigPaths: [".leanpi/mcp.json"] },
		});

		const config = loadConfig(cwd, {}, env);
		expect(config.permissions.trust.trusted).toBe(false);
		const runtime = track(registerMcpCommand(createCommandRegistry(), { cwd, config, home }));
		const files = runtime.catalog().servers.find((server) => server.name === "files");
		expect(files).toMatchObject({ scope: "user", toolCount: 1 });
		expect(runtime.catalog().tools.map((tool) => tool.tool)).toEqual(["read_file"]);
	});
});

describe("PRD-006 AC-2 — `/mcp disable|enable` controls exposure and survives a resume", () => {
	it("removes the rows, never connects the server, persists the state, and restores on enable", async () => {
		const home = tempHome();
		const cwd = tempDir("leanpi-mcp-disable-");
		const env = mcpEnv(home);
		const fixture = stdioFixtures(join(cwd, "fixtures"), [
			{ name: "files", hints: ["read_file", "write_file"] },
			{ name: "pulse", hints: ["ping"] },
		]);
		writeUserMcpConfig(home, fixture.entries);
		baseConfig(cwd);

		const registry = createCommandRegistry();
		const runtime = track(registerMcpCommand(registry, { cwd, config: loadConfig(cwd, {}, env), home }));
		expect(runtime.catalog().tools.map((tool) => `${tool.server}/${tool.tool}`)).toEqual(["files/read_file", "files/write_file", "pulse/ping"]);

		const disabled = await registry.dispatch("/mcp disable files", { cwd });
		expect(disabled.ok).toBe(true);
		expect(runtime.catalog().servers.find((server) => server.name === "files")!.enabled).toBe(false);
		expect(runtime.catalog().tools.some((tool) => tool.server === "files")).toBe(false);
		expect((await registry.dispatch("/mcp", { cwd })).text).toContain("- files (transport: stdio, scope: user, enabled: false");

		// A disabled server is never connected: the call is refused before any spawn.
		await expect(runtime.pool.callTool("files", "read_file")).rejects.toThrow(/disabled/);
		expect(fixture.started("files")).toBe(false);
		expect(persistedState(cwd).files?.enabled).toBe(false);

		// Resume: a freshly loaded config and a fresh runtime see the same state.
		const resumedRegistry = createCommandRegistry();
		const resumed = track(registerMcpCommand(resumedRegistry, { cwd, config: loadConfig(cwd, {}, env), home }));
		expect(resumed.catalog().tools.map((tool) => tool.server)).toEqual(["pulse"]);
		expect(resumed.catalog().servers.find((server) => server.name === "files")!.toolCount).toBe(2);
		// The enabled sibling is still lazy: nothing starts until its first call.
		expect(fixture.started("pulse")).toBe(false);
		const call = await resumed.pool.callTool("pulse", "ping", { path: "x" });
		expect(call.isError).toBe(false);
		expect(fixture.callsOf("pulse")).toEqual([{ server: "pulse", tool: "ping", arguments: { path: "x" } }]);
		expect(fixture.started("files")).toBe(false);

		const enabled = await resumedRegistry.dispatch("/mcp enable files", { cwd });
		expect(enabled.ok).toBe(true);
		expect(resumed.catalog().tools.map((tool) => `${tool.server}/${tool.tool}`)).toContain("files/read_file");
		// Enabling is a catalog change only; it does not connect either.
		expect(fixture.started("files")).toBe(false);
		expect(persistedState(cwd).files?.enabled).toBe(true);

		const unknown = await resumedRegistry.dispatch("/mcp disable nope", { cwd });
		expect(unknown.ok).toBe(false);
		expect(unknown.text).toContain('no server named "nope"');
	});
});
