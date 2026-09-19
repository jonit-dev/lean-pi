/**
 * PRD-006 Phase 4 — AC-5, AC-7: the mid-task capability router, and the single
 * permission chokepoint.
 *
 * AC-7 drives a real Pi session with PRD-017's guard installed and asserts on
 * the HTTP fixture's inbound log: a denied call must leave the server having
 * received nothing, an `ask` must prompt exactly once *before* the request, and
 * with the guard absent the same call must reach the server.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearCapabilityProviders, createCommandRegistry, loadConfig, writeUserRule } from "../../src/index.js";
import { buildCatalog, mcpToolDefinition, registerMcpCommand, requestCapability, selectMcpTools, writeMcpToken, type McpPool, type McpRuntime } from "../../src/mcp/index.js";
import { nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { bootGuardedSession, call, drive, toolMessages, STUB_MODEL } from "../permissions/harness.js";
import { seedUserPermissions } from "../permissions/fixtures.js";
import {
	catalogFixture,
	jevHarness,
	mcpEnv,
	mcpResponder,
	seedSchemaCache,
	startHttpFixture,
	tempHome,
	toolsFor,
	writeUserMcpConfig,
	type HttpFixture,
	type JevHarness,
} from "./helpers.js";

const harnesses: JevHarness[] = [];
const runtimes: McpRuntime[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
	clearCapabilityProviders();
	for (const harness of harnesses.splice(0)) await harness.close();
	for (const runtime of runtimes.splice(0)) await runtime.pool.disconnectAll();
	for (const close of closers.splice(0)) await close();
});

function ids(tools: Array<{ server: string; tool: string }>): string[] {
	return tools.map((tool) => `${tool.server}/${tool.tool}`);
}

function catalogAt(cwd: string, home: string, config: ReturnType<typeof loadConfig>) {
	return buildCatalog({ cwd, config, home });
}

describe("PRD-006 AC-5 — mid-task admission adds exactly one schema", () => {
	it("admits the one matched tool and nothing else; a non-match refuses and leaves the set unchanged", async () => {
		const home = tempHome();
		const cwd = tempDir("leanpi-mcp-router-");
		const env = mcpEnv(home);
		const built = catalogFixture(cwd, { servers: 6, pinned: ["s5"], defaults: ["s6"] });
		writeUserMcpConfig(home, built.entries);
		seedSchemaCache(cwd, built.tools);
		writeConfig(cwd, {
			backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
			models: { balanced: { backend: "local", model: "stub" } },
			mcp: { maxTools: 6 },
		});

		const harness = await jevHarness(
			cwd,
			[
				// The disclosure pipeline asks twice (relevance, then tool confirmation).
				mcpResponder({ any: true, relevance: { s1: 3 }, tools: ["s1/alpha"] }),
				mcpResponder({ any: true, relevance: { s1: 3 }, tools: ["s1/alpha"] }),
				mcpResponder({ capability: "tool:s2/gamma" }),
				mcpResponder({ capability: "none" }),
				mcpResponder({ capability: "tool:s2/gamma" }),
			],
			{ env },
		);
		harnesses.push(harness);
		const catalog = catalogAt(cwd, home, harness.config);
		const config = harness.config;

		const first = await selectMcpTools({ catalog, request: "read the s1 fixture", config, cwd, client: harness.client });
		expect(ids(first.tools)).toEqual(["s1/alpha"]);

		const admission = await requestCapability({ query: "query the gamma fixture", catalog, config, cwd, live: first.tools, client: harness.client });
		expect(admission.ok).toBe(true);
		expect(ids(admission.tools)).toEqual(["s1/alpha", "s2/gamma"]);
		expect(admission.admitted).toMatchObject({ server: "s2", tool: "gamma" });
		expect(admission.evicted).toBeNull();
		expect(admission.fallbackUsed).toBe(false);
		// Exactly one addition: the live set is unchanged apart from the new tool.
		expect(admission.tools.slice(0, first.tools.length)).toEqual(first.tools);
		expect(first.tools).toHaveLength(1);

		const refused = await requestCapability({ query: "do something unrelated", catalog, config, cwd, live: first.tools, client: harness.client });
		expect(refused.ok).toBe(false);
		expect(refused.refusal).toMatchObject({ code: "no_match" });
		expect(refused.admitted).toBeNull();
		expect(refused.tools).toBe(first.tools);

		// The cap still applies: a full live set evicts its lowest-scored admission.
		const capped = await requestCapability({ query: "query the gamma fixture", catalog, config, cwd, live: first.tools, client: harness.client, maxTools: 1 });
		expect(ids(capped.tools)).toEqual(["s2/gamma"]);
		expect(capped.evicted).toMatchObject({ server: "s1", tool: "alpha" });
	});

	it("falls back to a lexical match within pinned servers when JEV is off, and refuses when nothing matches", async () => {
		const home = tempHome();
		const cwd = tempDir("leanpi-mcp-router-off-");
		const env = mcpEnv(home);
		const built = catalogFixture(cwd, { servers: 6, pinned: ["s5"], defaults: ["s6"] });
		writeUserMcpConfig(home, built.entries);
		seedSchemaCache(cwd, built.tools);
		writeConfig(cwd, { backends: { local: nativeBackend("http://127.0.0.1:1/v1") }, models: { balanced: { backend: "local", model: "stub" } } });

		const off = await jevHarness(cwd, [mcpResponder({})], { env, jevMode: "disabled" });
		harnesses.push(off);
		const catalog = catalogAt(cwd, home, off.config);

		const lexical = await requestCapability({ query: "alpha", catalog, config: off.config, cwd, live: [], client: off.client });
		expect(lexical.ok).toBe(true);
		expect(lexical.fallbackUsed).toBe(true);
		expect(lexical.admitted).toMatchObject({ server: "s5", tool: "alpha" });
		expect(ids(lexical.tools)).toEqual(["s5/alpha"]);

		const unmatched = await requestCapability({ query: "zzz nowhere", catalog, config: off.config, cwd, live: [], client: off.client });
		expect(unmatched.ok).toBe(false);
		expect(unmatched.refusal).toMatchObject({ code: "no_match" });
		expect(unmatched.tools).toEqual([]);
	});
});

describe("PRD-006 AC-7 — MCP calls obey PRD-017's single dispatch guard", () => {
	it("refuses a denied call with nothing sent, prompts once for an asked one, and sends it when no guard is installed", async () => {
		const home = tempHome();
		const cwd = tempDir("leanpi-mcp-perm-");
		const env = { XDG_CONFIG_HOME: join(home, "xdg") };
		const http: HttpFixture = await startHttpFixture(toolsFor("remote", ["query"]));
		closers.push(http.close);
		http.requireToken("fixture-token");
		writeUserMcpConfig(home, { remote: { transport: "http", url: http.url, tools: ["query"] } });
		seedSchemaCache(cwd, { remote: toolsFor("remote", ["query"]) });
		writeMcpToken(cwd, "remote", "fixture-token");
		writeConfig(cwd, { backends: { stub: nativeBackend("http://127.0.0.1:1/v1") }, models: { balanced: { backend: "stub", model: STUB_MODEL } } });
		const runtime = registerMcpCommand(createCommandRegistry(), {
			cwd,
			config: loadConfig(cwd, {}, { HOME: home, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME }),
			home,
		});
		runtimes.push(runtime);

		const events: string[] = [];
		// The production definition, with only the pool wrapped so the test can see
		// that the request is sent *after* the prompt.
		const pool: McpPool = {
			...runtime.pool,
			callTool: async (server, tool, args) => {
				events.push("called");
				return runtime.pool.callTool(server, tool, args);
			},
		};
		const tool = mcpToolDefinition(
			{ server: "remote", tool: "query", transport: "http", description: "fixture", inputSchema: { type: "object" }, score: 1 },
			pool,
		);
		const step = drive([call("mcp__remote__query", { server: "remote", tool: "query", q: "x" })]);

		// `deny`: the guard refuses and the fixture server never sees the request.
		seedUserPermissions(env, { rules: [["mcp:remote/query", "deny"]] });
		const deniedBackend: StubBackend = await startStubBackend(step);
		closers.push(deniedBackend.close);
		const denied = await bootGuardedSession({ cwd, baseUrl: deniedBackend.baseUrl, env, extraTools: [tool] });
		await denied.session.prompt("query the remote fixture");
		const deniedMessages = toolMessages(deniedBackend);
		expect(deniedMessages).toContain("mcp:remote/query");
		expect(deniedMessages).toContain("did not run");
		expect(http.calls).toHaveLength(0);
		expect(events).toEqual([]);
		denied.dispose();

		// `ask`: exactly one prompt, and it happens before the request is sent.
		writeUserRule("mcp:remote/query", "ask", env);
		const askedBackend: StubBackend = await startStubBackend(step);
		closers.push(askedBackend.close);
		const ui = {
			prompts: [] as Array<{ title: string; message: string }>,
			confirm: () => {
				events.push("prompt");
				return true;
			},
		};
		const asked = await bootGuardedSession({ cwd, baseUrl: askedBackend.baseUrl, env, extraTools: [tool], ui });
		await asked.session.prompt("query the remote fixture");
		expect(ui.prompts).toHaveLength(1);
		expect(ui.prompts[0]!.message).toContain("mcp:remote/query");
		expect(http.calls).toEqual([{ tool: "query", args: { server: "remote", tool: "query", q: "x" } }]);
		expect(events.slice(0, 2)).toEqual(["prompt", "called"]);
		asked.dispose();

		// Bypass control: without the guard the same denied rule lets the call through.
		const bypassBackend: StubBackend = await startStubBackend(step);
		closers.push(bypassBackend.close);
		writeUserRule("mcp:remote/query", "deny", env);
		const bypassed = await bootGuardedSession({ cwd, baseUrl: bypassBackend.baseUrl, env, extraTools: [tool], installGuard: false });
		await bypassed.session.prompt("query the remote fixture");
		expect(http.calls).toHaveLength(2);
		bypassed.dispose();
	});
});
