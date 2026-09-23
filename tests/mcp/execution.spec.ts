/**
 * PRD-045 Phase 1 and 2 — E1/E2: the per-turn MCP/LSP tool surface, driven
 * through the real entry points.
 *
 * A booted native session (`createLeanPiSession`) with a stub stdio MCP server
 * whose schema is cached and a stub JEV that selects `stub/echo`. Nothing here
 * mocks a transport or the guard: the server process is the PRD-006 fixture, and
 * the assertions are made on the marker file it writes at startup and the call
 * log it appends to.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearLanes, grantTrust, type LeanPiSession } from "../../src/index.js";
import { nativeBackend, bootSession, tempDir, toolNamesOf, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend, type StubStep } from "../helpers/stub-backend.js";
import { startStubJev, type StubJev, type StubJevResponder } from "../helpers/stub-jev.js";
import { seedUserPermissions } from "../permissions/fixtures.js";
import { call, drive } from "../permissions/harness.js";
import { mcpEnv, mcpResponder, seedSchemaCache, stdioFixtures, tempHome, toolsFor, writeProjectMcpConfig, type StdioFixture } from "./helpers.js";

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	clearLanes();
});

interface Fixture {
	cwd: string;
	home: string;
	env: { HOME: string; XDG_CONFIG_HOME: string };
	server: StdioFixture;
	backend: StubBackend;
	jev: StubJev;
	/** Seed the permission store *before* booting: the guard reads it at activation. */
	allow(rules: { defaults?: { mcp: "allow" | "ask" | "deny" }; capabilities?: string[] }): void;
	boot(steps?: StubStep[]): Promise<LeanPiSession>;
}

interface FixtureOptions {
	steps?: StubStep[];
	jevResponders?: StubJevResponder[];
	pinned?: string[];
	extraConfig?: Record<string, unknown>;
}

/**
 * A native session whose catalog carries `stub` (echo, other) and `other` (ping),
 * with the schemas already cached and the project trusted.
 */
async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
	const cwd = tempDir("leanpi-mcp-exec-");
	const home = tempHome();
	const env = mcpEnv(home);
	const server = stdioFixtures(join(cwd, ".leanpi", "servers"), [
		{ name: "stub", tools: toolsFor("stub", ["echo", "other"]), ...(options.pinned?.includes("stub") ? { pinned: true } : {}) },
		{ name: "other", tools: toolsFor("other", ["ping"]), ...(options.pinned?.includes("other") ? { pinned: true } : {}) },
	]);
	writeProjectMcpConfig(cwd, server.entries);
	seedSchemaCache(cwd, { stub: toolsFor("stub", ["echo", "other"]), other: toolsFor("other", ["ping"]) });
	const backend = await startStubBackend(options.steps ?? drive([call("mcp__stub__echo", { sentinel_stub_echo: "hi" })]));
	const jev = await startStubJev(options.jevResponders ?? [mcpResponder({ any: true, relevance: { stub: 3 }, tools: ["stub/echo"] })]);
	closers.push(() => backend.close(), () => jev.close());
	writeConfig(cwd, {
		backends: { local: nativeBackend(backend.baseUrl) },
		models: { balanced: { backend: "local", model: "cheap-fast" } },
		jev: { endpoint: jev.url, apiKey: "test-key" },
		...(options.extraConfig),
	});
	// Trust is granted last: the config file and `mcp.json` are the hashed surface.
	grantTrust(cwd, env);
	return {
		cwd,
		home,
		env,
		server,
		backend,
		jev,
		allow: ({ defaults, capabilities }) =>
			seedUserPermissions(env, {
				...(defaults ? { defaults } : {}),
				...(capabilities ? { rules: capabilities.map((capability) => [capability, "allow"] as [string, "allow"]) } : {}),
			}),
		boot: (steps) => {
			if (steps) backend.steps.splice(0, backend.steps.length, ...steps);
			return bootSession({ cwd, agentDir: tempDir("leanpi-agent-"), env });
		},
	};
}

/** The `tools` array the last request carried, i.e. the model's actual surface. */
function activeTools(backend: StubBackend): string[] {
	return toolNamesOf(backend.requests[backend.requests.length - 1]!.body);
}

/** Every message the session sent back to the model, as text. */
function conversation(backend: StubBackend): string {
	return JSON.stringify(backend.requests.flatMap((request) => (request.body.messages ?? []) as unknown[]));
}

describe("PRD-045 Phase 1 — JEV-selected MCP tools are callable (AC-1 to AC-4)", () => {
	it("AC-1: the model's mcp__stub__echo call reaches the server, spawned only at that call", async () => {
		const f = await fixture();
		f.allow({ capabilities: ["mcp:stub/echo"] });
		const session = await f.boot();
		closers.push(() => session.session.dispose());

		// Lazy end to end: nothing has spawned the server yet.
		expect(f.server.started("stub")).toBe(false);

		await session.session.prompt("echo the stub fixture");

		// The spawn counter goes 0 → 1 only because the call happened, and the
		// server's own log proves the result came from it.
		expect(f.server.started("stub")).toBe(true);
		expect(f.server.callsOf("stub")).toEqual([{ server: "stub", tool: "echo", arguments: { sentinel_stub_echo: "hi" } }]);
		expect(conversation(f.backend)).toContain("stub/echo ok");
	});

	it("AC-2: a turn whose JEV selects nothing exposes no mcp__ tool, and no LSP tool either", async () => {
		const f = await fixture({ jevResponders: [mcpResponder({ any: false })] });
		const session = await f.boot();
		closers.push(() => session.session.dispose());

		await session.session.prompt("just read the file");
		const tools = activeTools(f.backend);
		expect(tools.some((name) => name.startsWith("mcp__"))).toBe(false);
		expect(tools.some((name) => name.startsWith("lsp_"))).toBe(false);
		// The baseline surface is untouched.
		expect(tools).toEqual(expect.arrayContaining(["read", "search", "edit", "write", "execute"]));
	});

	it("AC-3: a denied mcp scope blocks the call and never spawns the server", async () => {
		const f = await fixture();
		f.allow({ defaults: { mcp: "deny" } });
		const session = await f.boot();
		closers.push(() => session.session.dispose());

		await session.session.prompt("echo the stub fixture");

		expect(f.server.started("stub")).toBe(false);
		expect(f.server.callsOf("stub")).toEqual([]);
		expect(conversation(f.backend)).toContain("did not run");
	});

	it("AC-4: with JEV disabled only pinned or project-default servers become active", async () => {
		const f = await fixture({ pinned: ["stub"], extraConfig: { jev: { endpoint: "http://127.0.0.1:1/v1", apiKey: null, mode: "disabled" } } });
		// The config changed after the fixture wrote it, so trust is re-granted.
		grantTrust(f.cwd, f.env);
		const session = await f.boot(drive([{ text: "done" }]));
		closers.push(() => session.session.dispose());

		await session.session.prompt("do the thing");
		const tools = activeTools(f.backend);
		expect(tools).toContain("mcp__stub__echo");
		expect(tools.some((name) => name.startsWith("mcp__other__"))).toBe(false);
		// Nothing connected: availability is not use.
		expect(f.server.started("stub")).toBe(false);
	});

	it("a machine with no MCP config gains no mcp_request tool", async () => {
		const cwd = tempDir("leanpi-no-mcp-");
		const env = mcpEnv(tempHome());
		const backend = await startStubBackend(drive([{ text: "done" }]));
		const jev = await startStubJev([mcpResponder({ any: false })]);
		closers.push(() => backend.close(), () => jev.close());
		writeConfig(cwd, {
			backends: { local: nativeBackend(backend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			jev: { endpoint: jev.url, apiKey: "test-key" },
		});
		grantTrust(cwd, env);
		const session = await bootSession({ cwd, agentDir: tempDir("leanpi-agent-"), env });
		closers.push(() => session.session.dispose());

		await session.session.prompt("do the thing");
		expect(activeTools(backend)).not.toContain("mcp_request");
	});
});

describe("PRD-045 Phase 1 — the LSP mode follows the same step (AC-5)", () => {
	async function lspSession(mode: "off" | "diagnostics"): Promise<{ session: LeanPiSession; backend: StubBackend }> {
		const cwd = tempDir("leanpi-lsp-exec-");
		const home = tempHome();
		const env = mcpEnv(home);
		const backend = await startStubBackend(drive([{ text: "done" }]));
		const jev = await startStubJev([mcpResponder({ any: false })]);
		closers.push(() => backend.close(), () => jev.close());
		writeConfig(cwd, {
			backends: { local: nativeBackend(backend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			jev: { endpoint: jev.url, apiKey: "test-key" },
			lsp: { mode },
		});
		grantTrust(cwd, env);
		const session = await bootSession({ cwd, agentDir: tempDir("leanpi-agent-"), env });
		closers.push(() => session.session.dispose());
		return { session, backend };
	}

	it("leaves no LSP tool active under LSP_OFF and exactly the diagnostics group under the diagnostics mode", async () => {
		const off = await lspSession("off");
		await off.session.session.prompt("do the thing");
		const offTools = activeTools(off.backend);
		expect(offTools.some((name) => name.startsWith("lsp_"))).toBe(false);
		expect(offTools).toEqual(expect.arrayContaining(["read", "search", "edit", "write", "execute"]));

		const diagnostics = await lspSession("diagnostics");
		await diagnostics.session.session.prompt("do the thing");
		const diagTools = activeTools(diagnostics.backend);
		expect(diagTools).toContain("lsp_diagnostics");
		expect(diagTools).not.toContain("lsp_definition");
	});

	it("the programmatic runTurn path applies the same surface (no second applyLspTools call)", async () => {
		const diagnostics = await lspSession("diagnostics");
		await diagnostics.session.runTurn("do the thing");
		expect(activeTools(diagnostics.backend)).toContain("lsp_diagnostics");
	});
});

describe("PRD-045 Phase 2 — the mid-turn mcp_request router (AC-6)", () => {
	it("admits a tool the model asks for in the same turn, evicting at the cap", async () => {
		const f = await fixture({
			// The live set is capped at one, so the admission evicts the compiled tool.
			extraConfig: { mcp: { maxTools: 1 } },
			jevResponders: [mcpResponder({ any: true, relevance: { stub: 3 }, tools: ["stub/echo"], capability: "tool:stub/other" })],
			steps: drive([call("mcp_request", { query: "another stub capability" }), call("mcp__stub__other", { sentinel_stub_other: "x" })]),
		});
		f.allow({ defaults: { mcp: "allow" } });
		const session = await f.boot();
		closers.push(() => session.session.dispose());

		await session.session.prompt("echo, then ask for more");

		// The admitted tool is callable in the same turn, and the evicted one is gone.
		expect(f.server.callsOf("stub").map((entry) => entry.tool)).toEqual(["other"]);
		expect(conversation(f.backend)).toContain("mcp__stub__other is now callable");
		expect(activeTools(f.backend)).not.toContain("mcp__stub__echo");
	});

	it("refuses an unmatched request with a message and leaves the set unchanged", async () => {
		const f = await fixture({
			jevResponders: [mcpResponder({ any: true, relevance: { stub: 3 }, tools: ["stub/echo"], capability: "none" })],
			steps: drive([call("mcp_request", { query: "something unrelated" })]),
		});
		f.allow({ defaults: { mcp: "allow" } });
		const session = await f.boot();
		closers.push(() => session.session.dispose());

		await session.session.prompt("ask for something unrelated");
		expect(conversation(f.backend)).toContain("mcp_request refused");
		expect(activeTools(f.backend)).toContain("mcp__stub__echo");
	});
});
