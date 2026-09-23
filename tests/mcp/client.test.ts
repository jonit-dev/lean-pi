/**
 * PRD-006 Phase 2 — AC-4, AC-6, AC-9: lazy transports, health and the cold-start
 * refresh.
 *
 * Every claim here is made against a real side effect: the stdio fixture
 * process's marker file and request log, the HTTP fixture's inbound log, and the
 * fixture process's own liveness. A mocked transport cannot produce a pass.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearCapabilityProviders,
	compileTask,
	createCommandRegistry,
	loadConfig,
	registerCapabilityProvider,
} from "../../src/index.js";
import {
	buildCatalog,
	clearMcpToken,
	createMcpPool,
	mcpCapabilityProvider,
	readSchemaCache,
	registerMcpCommand,
	selectMcpTools,
	writeMcpToken,
	type McpRuntime,
} from "../../src/mcp/index.js";
import { bootSession, nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { packet } from "../compiler/helpers.js";
import {
	catalogFixture,
	jevHarness,
	mcpEnv,
	mcpResponder,
	seedSchemaCache,
	startHttpFixture,
	stdioFixtures,
	tempHome,
	toolsFor,
	waitUntil,
	writeUserMcpConfig,
	type HttpFixture,
	type JevHarness,
} from "./helpers.js";

const runtimes: McpRuntime[] = [];
const fixtures: Array<() => Promise<void>> = [];
const harnesses: JevHarness[] = [];

afterEach(async () => {
	clearCapabilityProviders();
	for (const harness of harnesses.splice(0)) await harness.close();
	for (const runtime of runtimes.splice(0)) await runtime.pool.disconnectAll();
	for (const close of fixtures.splice(0)) await close();
});

function track(runtime: McpRuntime): McpRuntime {
	runtimes.push(runtime);
	return runtime;
}

function trackHttp(http: HttpFixture): HttpFixture {
	fixtures.push(http.close);
	return http;
}

function trackHarness(harness: JevHarness): JevHarness {
	harnesses.push(harness);
	return harness;
}

describe("PRD-006 AC-4 — nothing connects until a selected tool is used", () => {
	it("starts no process and opens no HTTP session at session start or compile; the invoked server is the only one that appears", async () => {
		const home = tempHome();
		const cwd = tempDir("leanpi-mcp-lazy-");
		const env = mcpEnv(home);
		const fixture = stdioFixtures(join(cwd, "fixtures"), [
			{ name: "files", tools: toolsFor("files", ["read_file"]), hints: ["read_file"] },
			{ name: "pulse", tools: toolsFor("pulse", ["ping"]), hints: ["ping"] },
		]);
		const http = trackHttp(await startHttpFixture(toolsFor("web", ["query"])));
		http.requireToken("web-token");
		writeMcpToken(cwd, "web", "web-token");
		writeUserMcpConfig(home, { ...fixture.entries, web: { transport: "http", url: http.url, tools: ["query"] } });
		// A previous session's cache: the schemas exist, so selection can admit them.
		seedSchemaCache(cwd, { files: toolsFor("files", ["read_file"]), pulse: toolsFor("pulse", ["ping"]), web: toolsFor("web", ["query"]) });
		const backend: StubBackend = await startStubBackend([{ text: "ok" }]);
		fixtures.push(backend.close);
		writeConfig(cwd, {
			backends: { local: nativeBackend(backend.baseUrl) },
			models: { balanced: { backend: "local", model: "stub" } },
		});

		const session = await bootSession({ cwd, agentDir: tempDir("leanpi-mcp-agent-"), env });
		expect(fixture.started("files")).toBe(false);
		expect(fixture.started("pulse")).toBe(false);
		expect(http.requests).toHaveLength(0);

		// Compile with the MCP provider registered: still nothing connects.
		const harness = trackHarness(
			await jevHarness(cwd, [mcpResponder({ any: true, relevance: { files: 3 }, tools: ["files/read_file"] })], { env }),
		);
		registerCapabilityProvider(mcpCapabilityProvider({ cwd, config: harness.config, home, client: harness.client }));
		const contract = await compileTask("read a file through the fixture server", packet());
		expect((contract.capabilities.mcps as Array<{ server: string; tool: string }>).map((tool) => `${tool.server}/${tool.tool}`)).toEqual(["files/read_file"]);
		expect(fixture.started("files")).toBe(false);
		expect(fixture.started("pulse")).toBe(false);
		expect(http.requests).toHaveLength(0);

		// First actual tool use: exactly that server's process appears.
		const registry = createCommandRegistry();
		const runtime = track(registerMcpCommand(registry, { cwd, config: loadConfig(cwd, {}, env), home }));
		const call = await runtime.pool.callTool("files", "read_file", { path: "a.txt" });
		expect(call.isError).toBe(false);
		expect(fixture.started("files")).toBe(true);
		expect(fixture.callsOf("files")).toEqual([{ server: "files", tool: "read_file", arguments: { path: "a.txt" } }]);
		expect(fixture.started("pulse")).toBe(false);
		expect(http.requests).toHaveLength(0);
		expect(runtime.pool.isConnected("pulse")).toBe(false);
		session.session.dispose();
	});
});

describe("PRD-006 AC-6 — HTTP servers authenticate, and a missing token degrades instead of failing", () => {
	it("is callable with a stored token, reports auth_required with an authorization URL without one, and the task continues", async () => {
		const home = tempHome();
		const cwd = tempDir("leanpi-mcp-auth-");
		const env = mcpEnv(home);
		const http = trackHttp(await startHttpFixture(toolsFor("remote", ["query"])));
		http.requireToken("good-token");
		const fixture = stdioFixtures(join(cwd, "fixtures"), [{ name: "files", tools: toolsFor("files", ["read_file"]), hints: ["read_file"] }]);
		writeUserMcpConfig(home, { ...fixture.entries, remote: { transport: "http", url: http.url, tools: ["query"] } });
		seedSchemaCache(cwd, { files: toolsFor("files", ["read_file"]), remote: toolsFor("remote", ["query"]) });
		writeConfig(cwd, { backends: { local: nativeBackend("http://127.0.0.1:1/v1") }, models: { balanced: { backend: "local", model: "stub" } } });
		writeMcpToken(cwd, "remote", "good-token");

		const registry = createCommandRegistry();
		const runtime = track(registerMcpCommand(registry, { cwd, config: loadConfig(cwd, {}, env), home }));
		const called = await runtime.pool.callTool("remote", "query", { q: "x" });
		expect(called.isError).toBe(false);
		expect(http.calls).toEqual([{ tool: "query", args: { q: "x" } }]);
		expect(runtime.pool.health().remote?.health).toBe("connected");

		// The token is removed: the server is unusable but the session is not.
		await runtime.pool.disconnect("remote");
		clearMcpToken(cwd, "remote");
		const registry2 = createCommandRegistry();
		const resumed = track(registerMcpCommand(registry2, { cwd, config: loadConfig(cwd, {}, env), home }));
		await expect(resumed.pool.callTool("remote", "query")).rejects.toThrow(/requires authorization/);
		expect(resumed.pool.isConnected("remote")).toBe(false);
		expect(http.calls).toHaveLength(1);

		const listing = await registry2.dispatch("/mcp", { cwd });
		expect(listing.text).toContain("- remote (transport: http, scope: user, enabled: true, health: auth_required");
		expect(listing.text).toMatch(/authorization url: http:\/\/127\.0\.0\.1:\d+\/authorize\?response_type=code/);

		// The task completes using the remaining server.
		const harness = trackHarness(
			await jevHarness(cwd, [mcpResponder({ any: true, relevance: { files: 3 }, tools: ["files/read_file"] })], { env }),
		);
		const selected = await selectMcpTools({ catalog: resumed.catalog(), request: "read a file", config: harness.config, cwd, client: harness.client });
		expect(selected.tools.map((tool) => `${tool.server}/${tool.tool}`)).toEqual(["files/read_file"]);
		expect(selected.decision.fallbackUsed).toBe(false);
		expect((await resumed.pool.callTool("files", "read_file")).isError).toBe(false);
		expect(fixture.callsOf("files")).toHaveLength(1);
		expect((await registry2.dispatch("/mcp", { cwd })).text).toContain("health: connected");

		// A token the server rejects is the same typed outcome, never a crash: 401 → auth_required.
		writeMcpToken(cwd, "remote", "stale");
		http.expireToken();
		const registry3 = createCommandRegistry();
		const third = track(registerMcpCommand(registry3, { cwd, config: loadConfig(cwd, {}, env), home }));
		await expect(third.pool.callTool("remote", "query")).rejects.toThrow(/rejected the stored token/);
		expect(http.requests.at(-1)).toMatchObject({ authorized: false });
		expect((await registry3.dispatch("/mcp", { cwd })).text).toContain("health: auth_required");
		expect(third.pool.isConnected("remote")).toBe(false);
	});
});

describe("PRD-006 Phase 2 — health transitions", () => {
	it("records disconnected → connected → disconnected, and a dead server as error with its last error", async () => {
		const home = tempHome();
		const cwd = tempDir("leanpi-mcp-health-");
		const env = mcpEnv(home);
		const fixture = stdioFixtures(join(cwd, "fixtures"), [
			{ name: "files", tools: toolsFor("files", ["read_file"]), hints: ["read_file"] },
			{ name: "broken", tools: toolsFor("broken", ["ping"]), hints: ["ping"] },
		]);
		fixture.entries.broken = { transport: "stdio", command: "/nonexistent/leanpi-mcp-fixture", args: [] };
		writeUserMcpConfig(home, fixture.entries);
		seedSchemaCache(cwd, { files: toolsFor("files", ["read_file"]), broken: toolsFor("broken", ["ping"]) });
		writeConfig(cwd, { backends: { local: nativeBackend("http://127.0.0.1:1/v1") }, models: { balanced: { backend: "local", model: "stub" } } });

		const config = loadConfig(cwd, {}, env);
		const transitions: string[] = [];
		// The session's own pool, with a health observer: `/mcp` reports this one.
		const pool = createMcpPool({
			cwd,
			env,
			servers: () => buildCatalog({ cwd, config, home }).entries,
			onHealth: (server, record) => transitions.push(`${server}:${record.health}`),
		});
		const registry = createCommandRegistry();
		const runtime = track(registerMcpCommand(registry, { cwd, config, home, pool }));
		expect(runtime.pool).toBe(pool);

		expect(pool.health().files).toBeUndefined();
		await pool.callTool("files", "read_file");
		expect(transitions).toContain("files:connected");
		await pool.disconnect("files");
		expect(transitions).toEqual(["files:connected", "files:disconnected"]);
		expect(runtime.pool.isConnected("files")).toBe(false);

		// A server that cannot start is `error`, and the message is on the row /mcp renders.
		await expect(pool.callTool("broken", "ping")).rejects.toThrow(/ENOENT|spawn/);
		expect(pool.health().broken?.health).toBe("error");
		expect(pool.health().broken?.lastError).toBeTruthy();
		const listing = await registry.dispatch("/mcp", { cwd });
		expect(listing.text).toContain("- broken (transport: stdio, scope: user, enabled: true, health: error");
		expect(listing.text).toContain("last error:");
	});
});

describe("PRD-050 Phase 1 (G4) — MCP failure branches", () => {
	it("a refresh of an unstartable server reports zero tools with an error and stays disconnected", async () => {
		const home = tempHome();
		const cwd = tempDir("leanpi-mcp-refresh-fail-");
		const env = mcpEnv(home);
		writeUserMcpConfig(home, { broken: { transport: "stdio", command: "/nonexistent/leanpi-mcp-fixture", args: [] } });
		writeConfig(cwd, { backends: { local: nativeBackend("http://127.0.0.1:1/v1") }, models: { balanced: { backend: "local", model: "stub" } } });

		const registry = createCommandRegistry();
		const runtime = track(registerMcpCommand(registry, { cwd, config: loadConfig(cwd, {}, env), home }));
		const results = await runtime.pool.refresh("broken");
		expect(results).toHaveLength(1);
		expect(results[0]!.tools).toBe(0);
		expect(results[0]!.error).toBeTruthy();
		expect(runtime.pool.isConnected("broken")).toBe(false);

		const listing = await registry.dispatch("/mcp refresh broken", { cwd });
		expect(listing.text).toContain("refresh failed");
	});

	it("a tool response with isError:true surfaces on the call result", async () => {
		const home = tempHome();
		const cwd = tempDir("leanpi-mcp-iserror-");
		const env = mcpEnv(home);
		const fixture = stdioFixtures(join(cwd, "fixtures"), [
			{ name: "files", tools: toolsFor("files", ["ping", "boom"]), hints: ["ping", "boom"], errorTools: ["boom"] },
		]);
		writeUserMcpConfig(home, fixture.entries);
		seedSchemaCache(cwd, { files: toolsFor("files", ["ping", "boom"]) });
		writeConfig(cwd, { backends: { local: nativeBackend("http://127.0.0.1:1/v1") }, models: { balanced: { backend: "local", model: "stub" } } });

		const registry = createCommandRegistry();
		const runtime = track(registerMcpCommand(registry, { cwd, config: loadConfig(cwd, {}, env), home }));
		expect((await runtime.pool.callTool("files", "ping")).isError).toBe(false);
		const failed = await runtime.pool.callTool("files", "boom");
		expect(failed.isError).toBe(true);
		expect(fixture.callsOf("files").map((call) => call.tool)).toEqual(["ping", "boom"]);
	});

	it("dedupes concurrent getClient calls onto one handle and one live subprocess", async () => {
		const home = tempHome();
		const cwd = tempDir("leanpi-mcp-single-flight-");
		const env = mcpEnv(home);
		const fixture = stdioFixtures(join(cwd, "fixtures"), [
			{ name: "files", tools: toolsFor("files", ["read_file"]), hints: ["read_file"] },
		]);
		writeUserMcpConfig(home, fixture.entries);
		seedSchemaCache(cwd, { files: toolsFor("files", ["read_file"]) });
		writeConfig(cwd, { backends: { local: nativeBackend("http://127.0.0.1:1/v1") }, models: { balanced: { backend: "local", model: "stub" } } });

		const registry = createCommandRegistry();
		const runtime = track(registerMcpCommand(registry, { cwd, config: loadConfig(cwd, {}, env), home }));
		const [first, second] = await Promise.all([runtime.pool.getClient("files"), runtime.pool.getClient("files")]);
		expect(first).toBe(second);
		expect(await runtime.pool.getClient("files")).toBe(first);

		// One connection: the fixture is live, its pid is stable, and the handle works.
		const pid = fixture.pidOf("files");
		expect(pid).not.toBeNull();
		expect(fixture.alive("files")).toBe(true);
		expect((await first.listTools()).map((tool) => tool.name)).toEqual(["read_file"]);
		expect(fixture.pidOf("files")).toBe(pid);
	});
});

describe("PRD-006 AC-9 — the cold-start refresh", () => {
	it("shows zero tools and no row, then refresh catalogs them, leaves the server disconnected and selectable", async () => {
		const home = tempHome();
		const cwd = tempDir("leanpi-mcp-cold-");
		const env = mcpEnv(home);
		const fixture = stdioFixtures(join(cwd, "fixtures"), [
			// Neither hints nor cache: invisible until `/mcp refresh` connects it.
			{ name: "hintless", tools: toolsFor("hintless", ["ping", "pong"]) },
			{ name: "files", tools: toolsFor("files", ["read_file"]), hints: ["read_file"] },
		]);
		writeUserMcpConfig(home, fixture.entries);
		seedSchemaCache(cwd, { files: toolsFor("files", ["read_file"]) });
		writeConfig(cwd, { backends: { local: nativeBackend("http://127.0.0.1:1/v1") }, models: { balanced: { backend: "local", model: "stub" } } });

		const registry = createCommandRegistry();
		const runtime = track(registerMcpCommand(registry, { cwd, config: loadConfig(cwd, {}, env), home }));
		const before = await registry.dispatch("/mcp", { cwd });
		expect(before.text).toContain("- hintless (transport: stdio, scope: user, enabled: true, health: disconnected, tool count: 0)");
		expect(runtime.catalog().tools.some((tool) => tool.server === "hintless")).toBe(false);
		expect(fixture.started("hintless")).toBe(false);

		const refreshed = await registry.dispatch("/mcp refresh hintless", { cwd });
		expect(refreshed.ok).toBe(true);
		expect(refreshed.text).toContain("mcp: hintless refreshed (2 tools, disconnected afterwards)");
		expect(runtime.catalog().tools.filter((tool) => tool.server === "hintless").map((tool) => tool.tool)).toEqual(["ping", "pong"]);
		expect(readSchemaCache(cwd).hintless?.map((tool) => tool.name)).toEqual(["ping", "pong"]);
		// Disconnected afterwards: the process is not held open.
		expect(runtime.pool.isConnected("hintless")).toBe(false);
		expect(await waitUntil(() => !fixture.alive("hintless"))).toBe(true);

		// The next compile can select the newly cataloged tools.
		const harness = trackHarness(
			await jevHarness(cwd, [mcpResponder({ any: true, relevance: { hintless: 3 }, tools: ["hintless/ping"] })], { env }),
		);
		registerCapabilityProvider(mcpCapabilityProvider({ cwd, config: harness.config, home, client: harness.client }));
		const contract = await compileTask("ping the fixture server", packet());
		expect((contract.capabilities.mcps as Array<{ server: string; tool: string }>).map((tool) => `${tool.server}/${tool.tool}`)).toEqual(["hintless/ping"]);
		// Selecting is not connecting: the process the refresh left dead stays dead.
		expect(fixture.alive("hintless")).toBe(false);
		const catalog = buildCatalog({ cwd, config: harness.config, home });
		expect(catalog.servers.find((server) => server.name === "hintless")!.toolCount).toBe(2);
	});
});
