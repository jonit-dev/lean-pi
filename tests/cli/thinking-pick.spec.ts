/**
 * A thinking level the operator names on the command line (`--thinking max`, or
 * `--model provider/id:max`) is a hand pick, like a `/effort` pick: no compiled
 * effort, route or `setModel` reset lowers it for the session. A model that
 * cannot hold it is clamped by Pi, and that is said once on stderr.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { explicitThinkingLevel, launchEnv, parseLeanPiFlags } from "../../src/cli/launch.js";
import { loadConfig } from "../../src/core/config.js";
import { activate, clearLanes, clearRoutePins } from "../../src/index.js";

afterEach(() => {
	clearRoutePins();
	clearLanes();
	vi.restoreAllMocks();
});

describe("the launcher reads the operator's thinking level the way Pi does", () => {
	it("takes `--thinking`, then a `--model` suffix, and passes it to the session", () => {
		expect(explicitThinkingLevel(["--thinking", "max", "build it"])).toBe("max");
		expect(explicitThinkingLevel(["--model", "opencode-go/deepseek-v4.1-flash:max", "build it"])).toBe("max");
		expect(explicitThinkingLevel(["--model=opencode-go/deepseek-v4.1-flash:high"])).toBe("high");
		expect(explicitThinkingLevel(["--model", "a/b:low", "--thinking", "max"])).toBe("max");
		expect(explicitThinkingLevel(["--model", "a/b", "build it"])).toBeUndefined();
		expect(explicitThinkingLevel(["-p", "use --thinking max"])).toBeUndefined();
		expect(launchEnv(parseLeanPiFlags(["-p", "--thinking", "max", "x"]), false, {}).LEANPI_THINKING).toBe("max");
		expect(launchEnv(parseLeanPiFlags(["-p", "x"]), false, {}).LEANPI_THINKING).toBeUndefined();
	});
});

function session(options: { clampTo?: string } = {}) {
	const root = mkdtempSync(join(tmpdir(), "leanpi-thinking-pick-"));
	const home = join(root, "home");
	const cwd = join(root, "project");
	for (const dir of [home, cwd]) mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(cwd, "leanpi.config.yaml"),
		[
			"backends:",
			"  local: { type: native, baseUrl: https://example.test, apiKey: LOCAL_KEY }",
			"models:",
			"  quick: { backend: local, model: cheap }",
			"  balanced: { backend: local, model: cheap }",
			"  strong: { backend: local, model: cheap }",
			"jev:",
			"  mode: disabled",
			"",
		].join("\n"),
	);
	const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: join(root, "bin"), LEANPI_THINKING: "max" };
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	// Pi applied `--thinking max` before the extension ran.
	const state = { level: "max", modelChanges: 0 };
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
		registerTool: () => {},
		registerCommand: () => {},
		registerProvider: () => {},
		// Pi's `setModel` resets the level to the model's own default.
		setModel: async () => {
			state.modelChanges += 1;
			state.level = "medium";
			return true;
		},
		setThinkingLevel: (next: string) => {
			state.level = next === "max" && options.clampTo ? options.clampTo : next;
		},
		getThinkingLevel: () => state.level,
	};
	clearLanes();
	clearRoutePins();
	activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
	const ctx = {
		model: { provider: "local", id: "cheap" },
		modelRegistry: { find: () => ({ provider: "local", id: "cheap" }) },
		getContextUsage: () => ({ tokens: 10, contextWindow: 100, percent: 10 }),
		ui: { setStatus: () => {}, notify: () => {} },
		hasUI: false,
	};
	const turn = () => handlers.get("before_agent_start")!({ messageType: "user", prompt: "rename the helper", systemPrompt: "you are an assistant" }, ctx);
	return { state, turn };
}

describe("an explicit CLI thinking level holds for the session", () => {
	it("survives the compiled effort and the model reset on every turn", async () => {
		const { state, turn } = session();
		await turn();
		expect(state.modelChanges).toBeGreaterThan(0);
		expect(state.level).toBe("max");
		await turn();
		expect(state.level).toBe("max");
	});

	it("reports Pi's clamp once when the model cannot think at that level", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const { state, turn } = session({ clampTo: "high" });
		await turn();
		await turn();
		expect(state.level).toBe("high");
		const reports = stderr.mock.calls.filter(([text]) => String(text).includes('cannot think at "max"'));
		expect(reports).toHaveLength(1);
	});
});
