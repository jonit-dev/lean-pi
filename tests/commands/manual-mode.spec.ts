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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activate, clearLanes, compilerLane, loadConfig, ownsTurn, registerTurnLanesIfOwned, runTurn, setCompilerContext } from "../../src/index.js";
import { type TurnContext } from "../../src/commands/session.js";
import { clearRoutePins, routePins, setRoutePins } from "../../src/compiler/pins.js";
import { detectModels } from "../../src/cli/allocate.js";
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
	it("PRD-051: a CLI pin leaves the turn to Pi's loop — the executor lane never dispatches it", async () => {
		const h = await harness({ config: pinnedConfig });
		setCompilerContext({ config: h.config, cwd: h.cwd });
		setRoutePins({ model: { backend: "claude", model: "sonnet", type: "external_harness" } }, "manual-spec");

		// The pin is a model in Pi's registry now (PRD-051), so Pi's loop runs it.
		expect(ownsTurn(h.config)).toBe(false);

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
		).toBe(false);

		const context = await runTurn({ text: "rename the helper" }, { config: h.config, cwd: h.cwd });

		expect(packets).toHaveLength(0);
		expect(context.executor).toBeUndefined();
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

/** The picker's answer for a Claude CLI model. */
const CLI_PICK = {
	vendor: "claude" as const,
	backend: "claude",
	model: "sonnet",
	source: "test",
	facts: { execution: "external_harness" as const, availability: "ready" as const, evidence: "", coding_score: null, price_blended_per_mtok: null },
};

/** A `claude` stand-in: logs its argv, then answers in `claude -p --output-format json`'s shape. */
function stubClaude(dir: string, reply: string, sessionId: string, sleepSeconds = 0): string {
	const path = join(dir, "claude-stub.sh");
	// `modelUsage` is keyed by the full id the alias resolved to. A helper model a
	// subagent ran can out-write the conversation's model; `usage` sums every API
	// call, and `iterations` holds each one — the last is the live context.
	const envelope = JSON.stringify({
		type: "result",
		result: reply,
		session_id: sessionId,
		usage: {
			input_tokens: 20,
			output_tokens: 40,
			cache_read_input_tokens: 9000,
			cache_creation_input_tokens: 800,
			iterations: [
				{ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 6000, cache_creation_input_tokens: 400 },
				{ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3000, cache_creation_input_tokens: 400 },
			],
		},
		modelUsage: { "claude-haiku-4-5-20251001": { outputTokens: 500, contextWindow: 200000 }, "claude-sonnet-5": { outputTokens: 20, contextWindow: 1000000 } },
	});
	writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/argv.log"\n${sleepSeconds > 0 ? `/usr/bin/sleep ${sleepSeconds}\n` : ""}printf '%s' '${envelope}'\n`, { mode: 0o755 });
	return path;
}

type StreamResult = { stopReason: string; content: Array<{ text?: string }>; usage: { input: number; cacheRead: number } };
type CliProvider = { streamSimple: (model: unknown, context: unknown, options?: { signal?: AbortSignal }) => { result(): Promise<StreamResult> } };

/** A real `activate` on a native config, with the Claude CLI backend pointed at the stub. */
function cliSession(sleepSeconds = 0) {
	const { cwd, env } = nativeProject();
	const fake = fakePi();
	const providers = new Map<string, CliProvider>();
	const installed: Array<{ provider: string; id: string }> = [];
	const pi = {
		...fake.pi,
		registerProvider: (name: string, provider: CliProvider) => providers.set(name, provider),
		setModel: async (model: { provider: string; id: string }) => (installed.push(model), true),
	};
	const ctx = { ...fake.ctx, modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) }, ui: { ...fake.ctx.ui, custom: async () => ({ model: CLI_PICK }) } };
	const config = loadConfig(cwd, {}, env);
	config.backends.claude = { type: "external_harness", vendor: "claude", command: stubClaude(cwd, "Hi there!", "vendor-session-1", sleepSeconds) };
	clearLanes();
	activate(pi as never, { cwd, config, env });
	const stream = (text: string, signal?: AbortSignal) =>
		providers.get("claude-cli")!.streamSimple({ id: "sonnet", api: "leanpi-cli", provider: "claude-cli" }, { messages: [{ role: "user", content: text, timestamp: 0 }] }, signal ? { signal } : {});
	return { cwd, env, installed, providers, ctx, stream, handlers: fake.handlers, commands: fake.commands };
}

describe("PRD-051: a CLI pin is a model in Pi's own loop", () => {
	it("AC-1/AC-2: `/model` makes the CLI model Pi's model; Pi's loop takes the turn, the CLI answers it, and the next turn resumes the vendor session", async () => {
		const session = cliSession();
		await session.commands.get("model")?.handler("", session.ctx);
		// Pi's own model — the footer's model slot — is the pin, under its CLI provider.
		expect(session.installed.at(-1)).toEqual({ provider: "claude-cli", id: "sonnet" });

		// The `input` hook no longer answers: the prompt goes to Pi's loop.
		expect(await session.handlers.get("input")?.({ text: "Hi", source: "interactive" }, session.ctx)).toBeUndefined();

		const first = await session.stream("Hi").result();
		expect(first.stopReason).toBe("stop");
		expect(first.content[0]?.text).toBe("Hi there!");
		await session.stream("what did I just say?").result();
		const argv = readFileSync(join(session.cwd, "argv.log"), "utf8").trim().split("\n");
		expect(argv[0]).toContain("--model sonnet");
		expect(argv[0]).not.toContain("--resume");
		expect(argv[1]).toContain("--resume vendor-session-1");

		// `/model auto` hands Pi back the model it ran before Manual.
		await session.commands.get("model")?.handler("auto", session.ctx);
		expect(session.installed.at(-1)).toEqual({ provider: "local", id: "cheap" });
	});

	it("AC-2: a remembered CLI pin is registered at activation and installed on session_start", async () => {
		const { cwd, env } = nativeProject("remember_manual_model: true\n");
		const pinFile = join(env.HOME as string, ".leanpi", "model.json");
		mkdirSync(dirname(pinFile), { recursive: true });
		writeFileSync(pinFile, JSON.stringify({ backend: "claude", model: "sonnet", type: "external_harness" }));
		const fake = fakePi();
		const providers: string[] = [];
		const installed: Array<{ provider: string; id: string }> = [];
		const pi = { ...fake.pi, registerProvider: (name: string) => providers.push(name), setModel: async (model: { provider: string; id: string }) => (installed.push(model), true) };
		const ctx = { ...fake.ctx, modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) } };
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
		expect(providers).toContain("claude-cli");

		await fake.handlers.get("session_start")?.({ reason: "startup" }, ctx);
		expect(installed.at(-1)).toEqual({ provider: "claude-cli", id: "sonnet" });
		// The model Pi started on is kept, so `/model auto` after a restart restores it.
		expect(routePins().previousModel).toMatchObject({ backend: "local", model: "cheap" });
	});

	it("AC-5: an alias learns the full id it ran as — the footer and the picker name it from then on", async () => {
		const session = cliSession();
		await session.commands.get("model")?.handler("", session.ctx);
		const reply = await session.stream("Hi").result();
		// The last API call's usage reaches Pi — what the context holds now, not the
		// run's sum — which is what the footer's context share and compaction read.
		expect(reply.usage).toMatchObject({ input: 10, cacheRead: 3000 });

		await session.handlers.get("agent_end")?.({ messages: [] }, session.ctx);
		// The id the alias names, not the helper model that wrote more.
		expect(routePins().model).toMatchObject({ backend: "claude", model: "claude-sonnet-5" });
		expect(session.installed.at(-1)).toEqual({ provider: "claude-cli", id: "claude-sonnet-5" });

		const listed = detectModels("claude", { env: session.env, home: session.env.HOME as string }).map((candidate) => candidate.model);
		expect(listed).toContain("claude-sonnet-5");
		expect(listed).not.toContain("sonnet");
	});

	it("AC-3: aborting the stream kills the vendor and ends it aborted", async () => {
		const session = cliSession(30);
		await session.commands.get("model")?.handler("", session.ctx);
		const controller = new AbortController();
		const started = Date.now();
		setTimeout(() => controller.abort(), 300);
		const result = await session.stream("Hi", controller.signal).result();
		expect(result.stopReason).toBe("aborted");
		expect(Date.now() - started).toBeLessThan(10_000);
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
		// A CLI pin switches Pi to its CLI provider (PRD-051), but Pi was running
		// `cheap` before Manual, and that is what must come back once Manual ends.
		// `custom` lives on `ctx.ui` — the bridge only reads it from there — so the
		// picker path, not the printed-listing fallback, runs.
		await commands.get("model")?.handler("", { ...ctx, ui: { ...ctx.ui, custom: async () => ({ model: cliPick }) } });
		expect(setModelCalls).toEqual(["sonnet"]);
		expect(routePins().model).toMatchObject({ backend: "claude", model: "sonnet" });

		await commands.get("model")?.handler("local:cheap-alt", ctx);
		await commands.get("model")?.handler("auto", ctx);
		expect(setModelCalls).toEqual(["sonnet", "cheap-alt", "cheap"]);
	});
});
