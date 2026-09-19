/**
 * PRD-006 Phase 3 — AC-3, AC-8: JEV selection into the executor tool set.
 *
 * The fixture catalog is 54 tools across 6 servers. The assertion that matters
 * is the negative one: not a single byte of an unselected server's schema may
 * appear anywhere in the assembled context, and the JEV-off run must expose a
 * different set than the JEV-on run over the same catalog.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	assemble,
	clearCapabilityProviders,
	clearLanes,
	compileTask,
	readDecisions,
	registerCapabilityProvider,
	registerLane,
} from "../../src/index.js";
import { mcpCapabilityProvider, registerMcpDisclosure, selectMcpTools, type SelectedMcpTool } from "../../src/mcp/index.js";
import { bootSession, nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { packet } from "../compiler/helpers.js";
import { buildCatalog } from "../../src/mcp/index.js";
import { catalogFixture, jevHarness, mcpEnv, mcpResponder, seedSchemaCache, tempHome, writeUserMcpConfig, type CatalogFixture, type JevHarness } from "./helpers.js";

const MAX_TOOLS = 6;
const harnesses: JevHarness[] = [];
const backends: StubBackend[] = [];

afterEach(async () => {
	clearCapabilityProviders();
	clearLanes();
	for (const harness of harnesses.splice(0)) await harness.close();
	for (const backend of backends.splice(0)) await backend.close();
});

/** A 54-tool, 6-server catalog in `<home>`, with schemas already cached. */
function fixture(): { home: string; cwd: string; env: { HOME: string; XDG_CONFIG_HOME: string }; fixture: CatalogFixture } {
	const home = tempHome();
	const cwd = tempDir("leanpi-mcp-select-");
	const env = mcpEnv(home);
	const built = catalogFixture(cwd, { servers: 6, pinned: ["s5"], defaults: ["s6"] });
	writeUserMcpConfig(home, built.entries);
	seedSchemaCache(cwd, built.tools);
	writeConfig(cwd, {
		backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
		models: { balanced: { backend: "local", model: "stub" } },
		mcp: { maxTools: MAX_TOOLS },
	});
	return { home, cwd, env, fixture: built };
}

function track(harness: JevHarness): JevHarness {
	harnesses.push(harness);
	return harness;
}

function ids(tools: SelectedMcpTool[]): string[] {
	return tools.map((tool) => `${tool.server}/${tool.tool}`);
}

describe("PRD-006 AC-3 — only the JEV-selected schemas reach the executor", () => {
	it("exposes ≤ maxTools selected tools and zero bytes from unselected servers; 'no capability' exposes none", async () => {
		const { home, cwd, env, fixture: built } = fixture();
		expect(built.rows.length).toBeGreaterThanOrEqual(50);
		expect(Object.keys(built.tools).length).toBeGreaterThanOrEqual(6);

		const harness = track(
			await jevHarness(cwd, [mcpResponder({ any: true, relevance: { s1: 3, s2: 2 }, tools: ["s1/alpha", "s1/beta", "s2/gamma"] })], { env }),
		);
		// The registration point `activate()` uses: PRD-004's provider list.
		registerMcpDisclosure({ cwd, config: harness.config, home, client: harness.client });
		const contract = await compileTask("read the s1 fixture and query s2", packet());

		const selected = contract.capabilities.mcps as SelectedMcpTool[];
		expect(ids(selected)).toEqual(["s1/alpha", "s1/beta", "s2/gamma"]);
		expect(selected.length).toBeLessThanOrEqual(MAX_TOOLS);
		expect(harness.client.fallbackCount()).toBe(0);

		// The executor tool set is assembled strictly from the contract slot.
		const assembled = assemble({ config: harness.config, contract, mcps: contract.capabilities.mcps });
		const selectedSentinels = ["sentinel_s1_alpha", "sentinel_s1_beta", "sentinel_s2_gamma"];
		for (const sentinel of selectedSentinels) expect(assembled.text, sentinel).toContain(sentinel);
		// Zero bytes from every other server: no unselected schema text leaks in.
		expect(built.sentinels.filter((sentinel) => !selectedSentinels.includes(sentinel) && assembled.text.includes(sentinel))).toEqual([]);
		expect(assembled.text).not.toContain("sentinel_s5_");
		expect(assembled.text).not.toContain("sentinel_s6_");

		// The selection runs the same pipeline the provider does, and reports it.
		const direct = await selectMcpTools({ catalog: buildCatalog({ cwd, config: harness.config, home }), request: "read the s1 fixture and query s2", config: harness.config, cwd, client: harness.client });
		expect(ids(direct.tools)).toEqual(["s1/alpha", "s1/beta", "s2/gamma"]);
		expect(direct.decision.fallbackUsed).toBe(false);
		expect(direct.decision.servers).toEqual(["s1", "s2"]);

		// "No external capability needed" is the normal, cheapest outcome.
		const none = track(await jevHarness(cwd, [mcpResponder({ any: false })], { env }));
		registerCapabilityProvider(mcpCapabilityProvider({ cwd, config: none.config, home, client: none.client }));
		const bare = await compileTask("rename a local variable", packet());
		expect(bare.capabilities.mcps).toEqual([]);
		const barePrompt = assemble({ config: none.config, contract: bare, mcps: bare.capabilities.mcps });
		expect(barePrompt.text).not.toContain("mcp schemas:");
		expect(built.sentinels.some((sentinel) => barePrompt.text.includes(sentinel))).toBe(false);
	});
});

describe("PRD-006 AC-8 — JEV off falls back to pinned/project-default only", () => {
	it("exposes a different, pinned-only set with fallback_used recorded, and the session completes", async () => {
		const { home, cwd, env, fixture: built } = fixture();
		const backend = await startStubBackend([{ text: "done" }]);
		backends.push(backend);
		writeConfig(cwd, {
			backends: { local: nativeBackend(backend.baseUrl) },
			models: { balanced: { backend: "local", model: "stub" } },
			mcp: { maxTools: MAX_TOOLS },
			// §49: the project runs with JEV off.
			jev: { enabled: false },
		});

		const on = track(await jevHarness(cwd, [mcpResponder({ any: true, relevance: { s1: 3, s2: 2 }, tools: ["s1/alpha", "s1/beta", "s2/gamma"] })], { env }));
		registerCapabilityProvider(mcpCapabilityProvider({ cwd, config: on.config, home, client: on.client }));
		const withJev = await compileTask("read the s1 fixture and query s2", packet());
		expect(ids(withJev.capabilities.mcps as SelectedMcpTool[])).toEqual(["s1/alpha", "s1/beta", "s2/gamma"]);

		// The whole turn runs through a real session, whose own (disabled) JEV client
		// and MCP provider produce the exposed set Pi receives.
		const session = await bootSession({ cwd, agentDir: tempDir("leanpi-mcp-agent-"), env });
		registerCapabilityProvider(mcpCapabilityProvider({ cwd, config: session.activation.config, home, client: session.jev }));
		const exposed: string[] = [];
		registerLane({
			name: "mcp-lane",
			async run(turn, context) {
				const contract = await compileTask(turn.text, packet());
				context.contract = contract;
				const tools = contract.capabilities.mcps as SelectedMcpTool[];
				exposed.push(...ids(tools));
				// A lane that built the prompt itself owns the prefix (§22 layering).
				context.prefix = assemble({ config: context.config, contract, mcps: contract.capabilities.mcps }).text;
			},
		});
		await session.runTurn("read the s1 fixture and query s2");
		const sent = JSON.stringify(backend.requests[0]!.body);

		// Pinned (s5) and project-default (s6) only — never the full catalog, and
		// never a server JEV would have had to select.
		expect(exposed.length).toBeGreaterThan(0);
		expect(exposed.length).toBeLessThanOrEqual(MAX_TOOLS);
		expect([...new Set(exposed.map((id) => id.split("/")[0]))].sort()).toEqual(["s5"]);
		expect(exposed).not.toEqual(ids(withJev.capabilities.mcps as SelectedMcpTool[]));
		const exposedSentinels = exposed.map((id) => `sentinel_${id.replace("/", "_")}`);
		expect(built.sentinels.filter((sentinel) => !exposedSentinels.includes(sentinel) && sent.includes(sentinel))).toEqual([]);
		expect(sent).toContain("sentinel_s5_alpha");
		expect(sent).not.toContain("sentinel_s1_");
		expect(sent).not.toContain("sentinel_s6_");

		// The disabled run says so in its decision, and the telemetry row for the site
		// records `fallback_used: true`. With JEV on the same site resolved without it.
		const offSelection = await selectMcpTools({ catalog: buildCatalog({ cwd, config: session.activation.config, home }), request: "read the s1 fixture and query s2", config: session.activation.config, cwd, client: session.jev });
		expect(offSelection.decision.fallbackUsed).toBe(true);
		expect(offSelection.tools.every((tool) => ["s5", "s6"].includes(tool.server))).toBe(true);
		expect(ids(offSelection.tools)).toEqual(exposed);
		expect(ids(offSelection.tools)).not.toEqual(ids(withJev.capabilities.mcps as SelectedMcpTool[]));

		const rows = readDecisions(cwd);
		const disclosure = rows.filter((row) => row.siteId === "mcp.disclosure");
		expect(disclosure.some((row) => row.fallbackUsed)).toBe(true);
		session.session.dispose();
	});
});
