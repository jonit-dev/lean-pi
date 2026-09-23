/**
 * PRD-048 Phase 1 — a `/model` pick reaches the turn.
 *
 * AC-1: a CLI pin on a native config hands the turn to the executor lane and the
 * pinned backend/model is what dispatches; Pi's own loop is never the path.
 * AC-6: the same config with no pin leaves the executor lane out, so a native
 * turn behaves exactly as before.
 *
 * Below: docs/systems/model-modes.md's Manual mode (PRD-048 Phase 2). A pin is
 * not just "who dispatches" any more — it is a second mode that skips the
 * compiler, JEV, the proof gate and the goal boundary entirely.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activate, clearLanes, compilerLane, loadConfig, ownsTurn, registerTurnLanesIfOwned, runTurn, setCompilerContext } from "../../src/index.js";
import { runLanes, type TurnContext } from "../../src/commands/session.js";
import { clearRoutePins, routePins, setRoutePins } from "../../src/compiler/pins.js";
import { renderTurnOutcome } from "../../src/cli/outcome.js";
import type { LeanPiConfig } from "../../src/core/types.js";
import { nativeBackend, tempDir } from "../helpers/fixtures.js";
import { execConfig, fakeExec, harness, scriptedJev, VERIFY_COMMANDS } from "../executor/helpers.js";

/** Native executor roles plus one vendor CLI the pin can hand the turn to. */
function pinnedConfig(cwd: string): LeanPiConfig {
	return execConfig(cwd, {
		backends: {
			local: nativeBackend("http://127.0.0.1:1/v1"),
			claude: { type: "external_harness", vendor: "claude", command: "/bin/true" },
		},
		models: {
			quick: { backend: "local", model: "cheap" },
			balanced: { backend: "local", model: "mid" },
			strong: { backend: "local", model: "big" },
		},
	});
}

const review = async () => ({ status: "ok", changedFiles: [], summary: JSON.stringify({ decision: "PASS", findings: [] }) });

afterEach(() => {
	clearRoutePins();
	clearLanes();
	setCompilerContext(undefined);
});

describe("a manual model pin owns the turn (PRD-048)", () => {
	it("AC-1: pins an external model, the executor lane dispatches it, and Pi's loop does not run", async () => {
		const h = await harness({ config: pinnedConfig });
		setCompilerContext({ config: h.config, cwd: h.cwd });
		setRoutePins({ model: { backend: "claude", model: "sonnet", type: "external_harness" } }, "manual-spec");

		// A CLI pin makes LeanPi own the turn even though the roles are native.
		expect(ownsTurn(h.config)).toBe(true);

		const packets: Array<{ model?: string; backend?: string }> = [];
		expect(
			registerTurnLanesIfOwned({
				cwd: h.cwd,
				config: h.config,
				exec: fakeExec({ pass: true }),
				verifyCommands: VERIFY_COMMANDS,
				reviewRunner: review,
				worker: async (packet) => {
					packets.push({ model: packet.model, backend: (packet as { backend?: string }).backend });
					return { status: "completed", backend: "claude", result: { status: "ok", changedFiles: [], summary: "done" }, attempts: [] };
				},
			}),
		).toBe(true);

		const context = await runTurn({ text: "rename the helper" }, { config: h.config, cwd: h.cwd });

		// The pinned model reached the worker, and the pinned backend is the one
		// that ran — the router's own pick was excluded.
		expect(packets).toHaveLength(1);
		expect(packets[0]?.model).toBe("sonnet");
		expect(context.executor?.invocations[0]?.backend).toBe("claude");
	});

	it("AC-6: a native config with no pin leaves the executor lane out of the turn", async () => {
		const h = await harness({ config: pinnedConfig });
		setCompilerContext({ config: h.config, cwd: h.cwd });
		expect(ownsTurn(h.config)).toBe(false);

		let called = false;
		expect(
			registerTurnLanesIfOwned({
				cwd: h.cwd,
				config: h.config,
				exec: fakeExec({ pass: true }),
				verifyCommands: VERIFY_COMMANDS,
				reviewRunner: review,
				worker: async () => {
					called = true;
					return { status: "completed", backend: "claude", result: { status: "ok", changedFiles: [], summary: "done" }, attempts: [] };
				},
			}),
		).toBe(false);

		const context = await runTurn({ text: "rename the helper" }, { config: h.config, cwd: h.cwd });

		expect(called).toBe(false);
		expect(context.executor).toBeUndefined();
	});
});

/** Pi's extension API as `activate()` uses it, with the calls a test asserts on captured. */
function fakePi() {
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const notices: string[] = [];
	const statuses: Array<string | undefined> = [];
	return {
		commands,
		handlers,
		notices,
		statuses,
		pi: {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
			registerTool: () => {},
			registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, options),
			registerProvider: () => {},
			setModel: async () => true,
			setThinkingLevel: () => {},
			setSessionName: () => {},
			getSessionName: () => undefined,
			appendEntry: () => {},
		},
		ctx: {
			hasUI: true,
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "pi-session" },
			getContextUsage: () => ({ tokens: 1234, contextWindow: 200_000, percent: 1 }),
			// The model Pi is running before any pin — `cheap`, `balanced`/`strong`'s
			// native model — so `/model auto` has something real to restore.
			model: { provider: "local", id: "cheap" },
			modelRegistry: { find: (_backend: string, model: string) => ({ id: model }) },
			ui: {
				notify: (message: string) => notices.push(message),
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
				setWidget: () => {},
				input: async () => undefined,
			},
		},
	};
}

/**
 * All three roles native, on one backend the picker can pin without a vendor
 * CLI. `quick` binds a second id (`cheap-alt`) distinct from `balanced`/
 * `strong`'s `cheap`, so a pin can switch Pi's running model to something
 * other than what it already is.
 */
const NATIVE_YAML = ["backends:", "  local: { type: native, baseUrl: https://example.test }", "models:", "  quick: { backend: local, model: cheap-alt }", "  balanced: { backend: local, model: cheap }", "  strong: { backend: local, model: cheap }", "jev:", "  mode: disabled", ""].join("\n");

function nativeProject(extraYaml = ""): { cwd: string; env: NodeJS.ProcessEnv } {
	const cwd = tempDir("leanpi-manual-");
	const home = tempDir("leanpi-manual-home-");
	writeFileSync(join(cwd, "leanpi.config.yaml"), NATIVE_YAML + extraYaml);
	return { cwd, env: { HOME: home, PATH: "", XDG_CONFIG_HOME: join(home, ".config") } };
}

describe("Manual mode: a CLI pin is plain chat, not the full pipeline (docs/systems/model-modes.md)", () => {
	it("turn 'Hi': no contract, no JEV, no proof gate, no progress line, and the reply is the whole outcome", async () => {
		const h = await harness({ config: pinnedConfig });
		const jev = scriptedJev({});
		setCompilerContext({ config: h.config, cwd: h.cwd, client: jev });
		setRoutePins({ model: { backend: "claude", model: "sonnet", type: "external_harness" } }, "manual-behavior-spec");

		const packets: Array<{ objective: string; model?: string }> = [];
		registerTurnLanesIfOwned({
			cwd: h.cwd,
			config: h.config,
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
			reviewRunner: review,
			worker: async (packet) => {
				packets.push({ objective: packet.objective, model: packet.model });
				return { status: "completed", backend: "claude", result: { status: "ok", changedFiles: [], summary: "Hi there!" }, attempts: [] };
			},
		});

		const progress: string[] = [];
		const context: TurnContext = {
			turn: { text: "Hi" },
			role: "balanced",
			cwd: h.cwd,
			config: h.config,
			modelRef: { backend: "claude", model: "sonnet" },
			skills: [],
			prefix: "",
			onProgress: (phase) => progress.push(phase),
		};
		await runLanes({ text: "Hi" }, context);

		// Manual is plain chat: nothing compiled, nothing asked, nothing gated.
		expect(context.contract).toBeUndefined();
		expect(jev.calls).toHaveLength(0);
		expect(context.proof).toBeUndefined();
		expect(progress.some((phase) => phase.startsWith("running "))).toBe(false);
		// The pinned model, and the prompt as-is — not the compiled executor prompt.
		expect(packets).toHaveLength(1);
		expect(packets[0]).toEqual({ objective: "Hi", model: "sonnet" });
		// The whole report is the reply — no verdict glyph, no "verified" line.
		expect(renderTurnOutcome(context)).toBe("Hi there!");
	});
});

describe("Manual mode: a native pin (docs/systems/model-modes.md)", () => {
	it("the compiler lane produces no contract and asks JEV nothing", async () => {
		const h = await harness({ config: pinnedConfig });
		const jev = scriptedJev({});
		setCompilerContext({ config: h.config, cwd: h.cwd, client: jev });
		setRoutePins({ model: { backend: "local", model: "cheap", type: "native" } }, "manual-behavior-spec");

		const context: TurnContext = {
			turn: { text: "Hi" },
			role: "balanced",
			cwd: h.cwd,
			config: h.config,
			modelRef: { backend: "local", model: "cheap" },
			skills: [],
			prefix: "",
		};
		await compilerLane({ cwd: h.cwd, config: h.config }).run({ text: "Hi" }, context);

		expect(context.contract).toBeUndefined();
		expect(jev.calls).toHaveLength(0);
	});
});

describe("Manual mode: a native pin injects nothing extra (docs/systems/model-modes.md)", () => {
	it("before_agent_start returns no injected system prompt or message under a native pin — only the setModel", async () => {
		const { cwd, env } = nativeProject();
		const { pi, commands, handlers, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
		await commands.get("model")?.handler("local:cheap", ctx);

		const prompt = "you are an assistant";
		const result = await handlers.get("before_agent_start")?.({ prompt: "Hi", systemPrompt: prompt }, ctx);

		// No system-prompt rewrite, no PRD-suggest message — a plain harness turn.
		expect(result).toBeUndefined();
	});
});

describe("Manual mode: a native pin switches Pi's own model (docs/systems/model-modes.md)", () => {
	it("`/model <native pick>` calls setModel immediately, and `/model auto` restores the model that was running before the pin", async () => {
		const { cwd, env } = nativeProject();
		const setModelCalls: string[] = [];
		const { pi, commands, ctx } = fakePi();
		const patchedPi = { ...pi, setModel: async (model: { id: string }) => (setModelCalls.push(model.id), true) };
		clearLanes();
		activate(patchedPi as never, { cwd, config: loadConfig(cwd, {}, env), env });

		// Pi is running `cheap` (the fixture's default `ctx.model`); the pin picks
		// `cheap-alt`, a different model — not on the next turn, right now.
		await commands.get("model")?.handler("local:cheap-alt", ctx);
		expect(setModelCalls).toEqual(["cheap-alt"]);

		await commands.get("model")?.handler("auto", ctx);
		expect(setModelCalls).toEqual(["cheap-alt", "cheap"]);
	});
});

describe("Manual mode: the footer (docs/systems/model-modes.md)", () => {
	it("`/model <pick>` shows the pinned model + red 'Manual' immediately; a Manual turn keeps it, with none of Auto's other chips; `/model auto` returns to Auto's (cleared) line", async () => {
		const { cwd, env } = nativeProject();
		const { pi, commands, handlers, statuses, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });

		await commands.get("model")?.handler("local:cheap", ctx);
		expect(statuses.at(-1)).toContain("Manual");
		expect(statuses.at(-1)).toContain("cheap");

		// A turn under the pin: before_agent_start is the native-loop entry point.
		await handlers.get("before_agent_start")?.({ prompt: "Hi", systemPrompt: "you are an assistant" }, ctx);
		expect(statuses.at(-1)).toContain("Manual");
		// None of Auto's task/thinking/complexity chips — nothing compiled them.
		expect(statuses.at(-1)).not.toContain("thinking");

		const before = statuses.length;
		await commands.get("model")?.handler("auto", ctx);
		expect(statuses.length).toBeGreaterThan(before);
		// Cleared, matching what an unpinned session shows before its first turn.
		expect(statuses.at(-1)).toBeUndefined();
	});
});

describe("Manual mode: survives /new and /resume (docs/systems/model-modes.md)", () => {
	it("a pin outlives a session switch; only `/model auto` returns to Auto", async () => {
		const { cwd, env } = nativeProject();
		const { pi, commands, handlers, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });

		await commands.get("model")?.handler("local:cheap", ctx);
		expect(routePins().model).toBeDefined();

		await handlers.get("session_start")?.({ reason: "new" }, ctx);
		expect(routePins().model, "/new must not clear the model pin").toBeDefined();

		await handlers.get("session_start")?.({ reason: "resume" }, ctx);
		expect(routePins().model, "/resume must not clear the model pin").toBeDefined();

		await commands.get("model")?.handler("auto", ctx);
		expect(routePins().model).toBeUndefined();
	});
});

describe("Manual mode: restart and remember_manual_model (docs/systems/model-modes.md)", () => {
	it("default false: a pin writes no file, and a fresh activation starts Auto", async () => {
		const { cwd, env } = nativeProject();
		const { pi, commands, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
		await commands.get("model")?.handler("local:cheap", ctx);

		expect(existsSync(join(env.HOME as string, ".leanpi", "model.json"))).toBe(false);

		clearLanes();
		clearRoutePins();
		const fresh = fakePi();
		activate(fresh.pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
		expect(routePins().model).toBeUndefined();
	});

	it("true: a pin persists to <home>/.leanpi/model.json, a fresh activation restores Manual, and `/model auto` deletes it", async () => {
		const { cwd, env } = nativeProject("remember_manual_model: true\n");
		const { pi, commands, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
		await commands.get("model")?.handler("local:cheap", ctx);

		const pinFile = join(env.HOME as string, ".leanpi", "model.json");
		expect(existsSync(pinFile)).toBe(true);

		clearLanes();
		clearRoutePins();
		const fresh = fakePi();
		activate(fresh.pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
		expect(routePins().model, "startup must restore the remembered pin").toMatchObject({ backend: "local", model: "cheap" });

		await fresh.commands.get("model")?.handler("auto", fresh.ctx);
		expect(existsSync(pinFile), "/model auto must delete the remembered pin").toBe(false);
	});

	it("a corrupt or malformed remembered pin is ignored, not restored", async () => {
		const { cwd, env } = nativeProject("remember_manual_model: true\n");
		const pinFile = join(env.HOME as string, ".leanpi", "model.json");
		mkdirSync(dirname(pinFile), { recursive: true });
		writeFileSync(pinFile, JSON.stringify({ backend: "", model: "cheap", type: "native" }));

		const { pi } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
		expect(routePins().model).toBeUndefined();
	});

	it("restoring a non-native pin registers the backend, so the executor can spawn it", async () => {
		const { cwd, env } = nativeProject("remember_manual_model: true\n");
		const pinFile = join(env.HOME as string, ".leanpi", "model.json");
		mkdirSync(dirname(pinFile), { recursive: true });
		writeFileSync(pinFile, JSON.stringify({ backend: "claude", model: "sonnet", type: "external_harness" }));

		const config = loadConfig(cwd, {}, env);
		const { pi } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config, env });
		expect(config.backends.claude?.type).toBe("external_harness");
	});

	it("shows the red 'Manual' footer at startup when a remembered pin is restored — not only after the first turn", async () => {
		const { cwd, env } = nativeProject("remember_manual_model: true\n");
		const pinFile = join(env.HOME as string, ".leanpi", "model.json");
		mkdirSync(dirname(pinFile), { recursive: true });
		writeFileSync(pinFile, JSON.stringify({ backend: "local", model: "cheap", type: "native" }));

		const { pi, handlers, statuses, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);

		expect(statuses.at(-1)).toContain("Manual");
	});
});

describe("Manual mode: CLI conversation memory (docs/systems/model-modes.md)", () => {
	it("a second Manual turn on the same CLI pin carries the first turn's vendor session id", async () => {
		const h = await harness({ config: pinnedConfig });
		setCompilerContext({ config: h.config, cwd: h.cwd, client: scriptedJev({}) });
		setRoutePins({ model: { backend: "claude", model: "sonnet", type: "external_harness" } }, "manual-memory-spec");

		const packets: Array<{ sessionId?: string }> = [];
		let call = 0;
		registerTurnLanesIfOwned({
			cwd: h.cwd,
			config: h.config,
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
			reviewRunner: review,
			worker: async (packet) => {
				call += 1;
				packets.push({ sessionId: packet.sessionId });
				return { status: "completed", backend: "claude", result: { status: "ok", changedFiles: [], summary: `reply ${call}`, sessionId: `vendor-session-${call}` }, attempts: [] };
			},
		});

		const turnContext = (text: string): TurnContext => ({
			turn: { text },
			role: "balanced",
			cwd: h.cwd,
			config: h.config,
			modelRef: { backend: "claude", model: "sonnet" },
			skills: [],
			prefix: "",
		});
		await runLanes({ text: "Hi" }, turnContext("Hi"));
		await runLanes({ text: "what did I just say?" }, turnContext("what did I just say?"));

		// No memory yet on the first turn; the second continues the vendor's own session.
		expect(packets[0]?.sessionId).toBeUndefined();
		expect(packets[1]?.sessionId).toBe("vendor-session-1");
	});

	it("`/new` and `/resume` clear the remembered vendor session, but not the pin", async () => {
		const { cwd, env } = nativeProject();
		const { pi, handlers, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
		setRoutePins({ model: { backend: "claude", model: "sonnet", type: "external_harness" }, manualSessionId: "vendor-session-1" }, "manual-memory-spec");

		await handlers.get("session_start")?.({ reason: "new" }, ctx);
		expect(routePins().model, "the pin survives /new").toBeDefined();
		expect(routePins().manualSessionId, "/new must not carry the vendor session forward").toBeUndefined();
	});

	it("re-pinning and `/model auto` both clear the remembered vendor session", async () => {
		const { cwd, env } = nativeProject();
		const { pi, commands, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });

		await commands.get("model")?.handler("local:cheap", ctx);
		setRoutePins({ manualSessionId: "vendor-session-1" });
		await commands.get("model")?.handler("local:cheap", ctx);
		expect(routePins().manualSessionId, "re-pinning clears the remembered vendor session").toBeUndefined();

		setRoutePins({ manualSessionId: "vendor-session-1" });
		await commands.get("model")?.handler("auto", ctx);
		expect(routePins().manualSessionId, "/model auto clears the remembered vendor session").toBeUndefined();
	});
});

describe("Manual mode: pin message and previousModel (docs/systems/model-modes.md)", () => {
	it("the pin message names /model auto only — /new and /resume no longer return to Auto", async () => {
		const { cwd, env } = nativeProject();
		const { pi, commands, notices, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });

		await commands.get("model")?.handler("local:cheap", ctx);
		expect(notices.at(-1)).toContain("/model auto returns to Auto");
		expect(notices.at(-1)).not.toContain("/new");
		expect(notices.at(-1)).not.toContain("/resume");
	});

	it("previousModel is captured on the first pin regardless of type, so CLI then native then auto restores the pre-Manual model", async () => {
		const { cwd, env } = nativeProject();
		const setModelCalls: string[] = [];
		const { pi, commands, ctx } = fakePi();
		const patchedPi = { ...pi, setModel: async (model: { id: string }) => (setModelCalls.push(model.id), true) };
		clearLanes();
		activate(patchedPi as never, { cwd, config: loadConfig(cwd, {}, env), env });

		const cliPick = {
			vendor: "claude" as const,
			backend: "claude",
			model: "sonnet",
			source: "test",
			facts: { execution: "external_harness" as const, availability: "ready" as const, evidence: "", coding_score: null, price_blended_per_mtok: null },
		};
		// A CLI pin never calls setModel — there is nothing in Pi's registry to
		// switch to — but Pi was still running `cheap`, and that is what must come
		// back once Manual ends. `custom` lives on `ctx.ui` — the bridge only reads
		// it from there — so the picker path, not the printed-listing fallback, runs.
		await commands.get("model")?.handler("", { ...ctx, ui: { ...ctx.ui, custom: async () => ({ model: cliPick }) } });
		expect(setModelCalls).toEqual([]);
		expect(routePins().model).toMatchObject({ backend: "claude", model: "sonnet" });

		await commands.get("model")?.handler("local:cheap-alt", ctx);
		await commands.get("model")?.handler("auto", ctx);
		expect(setModelCalls).toEqual(["cheap-alt", "cheap"]);
	});
});
