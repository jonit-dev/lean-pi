/**
 * PRD-049: JEV routes each subagent's model and effort through the `tool_call`
 * hook. The JEV client here throws, so `classifyExecution` takes its real
 * heuristic fallback — the same path a session with JEV off runs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { activate, loadConfig } from "../../src/index.js";
import { clearRoutePins, setRoutePins } from "../../src/compiler/pins.js";
import { registerSubagentRouting } from "../../src/subagents/route.js";
import { tempDir } from "../helpers/fixtures.js";

const config = loadConfig(tempDir("leanpi-subroute-cfg-"), {
	configPath: null,
	backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
	models: {
		quick: { backend: "local", model: "m-quick" },
		balanced: { backend: "local", model: "m-balanced" },
		strong: { backend: "local", model: "m-strong" },
	},
});

const client = { ask: async () => Promise.reject(new Error("jev off")), fallbackCount: () => 0 };

type Handler = (event: unknown, ctx: unknown) => Promise<void>;

function setup(registered: (provider: string, id: string) => boolean = () => true) {
	const handlers = new Map<string, Handler>();
	registerSubagentRouting({ on: (event: string, handler: Handler) => void handlers.set(event, handler) } as never, { config, cwd: tempDir("leanpi-subroute-"), client });
	const notify = vi.fn();
	const ctx = {
		hasUI: true,
		ui: { notify },
		modelRegistry: { find: (provider: string, id: string) => (registered(provider, id) ? { provider, id } : undefined) },
	};
	const fire = async (input: Record<string, unknown>) => {
		await handlers.get("tool_call")?.({ toolName: "subagent", input }, ctx);
		return input;
	};
	return { fire, notify };
}

afterEach(() => clearRoutePins());

describe("subagent model routing (PRD-049)", () => {
	it("routes a plain call by the task's complexity and names the pick (AC-1, AC-3)", async () => {
		const { fire, notify } = setup();
		const low = await fire({ agent: "worker", task: "fix the typo in the README label" });
		const high = await fire({ agent: "worker", task: "fix the race condition in the runtime lock" });
		expect(low.model).toBe("local/m-quick:low");
		expect(high.model).toBe("local/m-strong:high");
		expect(notify).toHaveBeenCalledWith("subagent worker → m-quick · low (LOW)", "info");
		expect(notify).toHaveBeenCalledTimes(2);
	});

	it("leaves explicit, async, manually pinned and workflow calls alone (AC-2)", async () => {
		const { fire, notify } = setup();
		expect((await fire({ agent: "worker", task: "rename x", model: "other/m:high" })).model).toBe("other/m:high");
		expect("model" in (await fire({ agent: "worker", task: "rename x", async: true }))).toBe(false);
		expect("model" in (await fire({ workflowScript: "return 1" }))).toBe(false);
		setRoutePins({ model: { backend: "local", model: "m-balanced", type: "native" } });
		expect("model" in (await fire({ agent: "worker", task: "rename x" }))).toBe(false);
		expect(notify).not.toHaveBeenCalled();
	});

	it("inherits when the routed model is not in Pi's registry (AC-2, AC-3)", async () => {
		const { fire, notify } = setup((_, id) => id !== "m-quick");
		expect("model" in (await fire({ agent: "worker", task: "fix the typo in the README label" }))).toBe(false);
		expect(notify).toHaveBeenCalledWith("subagent worker → inherit (quick role has no native model)", "info");
	});

	it("activate() registers the route: a real session's tool_call routes the child (AC-1)", async () => {
		const cwd = tempDir("leanpi-subroute-live-");
		const env = { ...process.env, LEANPI_NO_JEV: "1" };
		const handlers: Handler[] = [];
		// Every other Pi method `activate()` touches is a no-op here.
		const pi = new Proxy({ on: (event: string, handler: Handler) => void (event === "tool_call" && handlers.push(handler)) } as Record<string, unknown>, {
			get: (target, key: string) => target[key] ?? (() => undefined),
		});
		activate(pi as never, { cwd, env, config: loadConfig(cwd, { backends: config.backends, models: config.models }, env) });
		const input: Record<string, unknown> = { agent: "worker", task: "fix the typo in the README label" };
		const ctx = { hasUI: false, ui: { notify: () => {} }, modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) } };
		for (const handler of handlers) await handler({ toolName: "subagent", input }, ctx);
		expect(input.model).toBe("local/m-quick:low");
	});
});
