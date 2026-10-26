/**
 * Session-model fallback across Pi's own loop (PRD-052 follow-up).
 *
 * On a native config LeanPi's executor lane never runs, so a 402/429 from the
 * session model ends the turn with nothing to fall back to — the operator types
 * "hi" again and pays the same refusal. `agent_end` must remember which backend
 * refused, and the next `before_agent_start` must resolve the role past it.
 *
 * Drives the real `activate()` hooks, so a registration that only works when
 * called by hand cannot pass. Red on `main`: the next turn installs the same
 * limited backend.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activate, readRuns } from "../../src/index.js";
import { clearLanes, registerLane } from "../../src/commands/session.js";
import { loadConfig } from "../../src/core/config.js";
import { fixtureContract } from "../routing/fixture.js";
import { bootSession, headlessUIContext, nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend } from "../helpers/stub-backend.js";
import { clearRoutePins, setRoutePins } from "../../src/compiler/pins.js";

interface Installed {
	provider: string;
	id: string;
}

/** Pi's extension API as `activate()` uses it, capturing `setModel` and the events. */
function fakePi(): {
	pi: Record<string, unknown>;
	handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
	installed: Installed[];
	notices: string[];
	ctx: Record<string, unknown>;
} {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const installed: Installed[] = [];
	const notices: string[] = [];
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "pi-session", getBranch: () => [] },
		getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
		model: { provider: "metered", id: "leanpi-test-flash" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: () => {},
			setWidget: () => {},
		},
	};
	return {
		handlers,
		installed,
		notices,
		ctx,
		pi: {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
			registerTool: () => {},
			registerCommand: () => {},
			registerProvider: () => {},
			setModel: async (model: { provider: string; id: string }) => {
				installed.push({ provider: model.provider, id: model.id });
				return true;
			},
			setThinkingLevel: () => {},
			getThinkingLevel: () => "medium",
			setSessionName: () => {},
			appendEntry: () => {},
		},
	};
}

/** A native session model plus an external-harness fallback, both unknown to the ranking. */
function project(): { cwd: string; env: NodeJS.ProcessEnv } {
	const cwd = mkdtempSync(join(tmpdir(), "leanpi-fallback-"));
	writeFileSync(
		join(cwd, "leanpi.config.yaml"),
		[
			"backends:",
			"  metered: { type: native, baseUrl: https://example.test, apiKey: sk-stub }",
			"  subscription: { type: external_harness, vendor: claude, command: leanpi-absent-cli }",
			"models:",
			"  quick: { backend: metered, model: leanpi-test-flash }",
			"  balanced: { backend: metered, model: leanpi-test-flash }",
			"  strong: { backend: subscription, model: leanpi-test-opus }",
			"  specialist: { backend: subscription, model: leanpi-test-opus }",
			"lsp: { mode: off }",
			"jev: { mode: disabled }",
			"",
		].join("\n"),
	);
	return { cwd, env: { HOME: cwd, PATH: "", XDG_CONFIG_HOME: join(cwd, ".config") } };
}

describe("session-model fallback after a provider limit", () => {
	it("moves the next turn off a backend that returned 429", async () => {
		const { cwd, env } = project();
		const { pi, handlers, installed, notices, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
		// One lane stands in for compilation so `before_agent_start` has a contract
		// to resolve a role for.
		registerLane({
			name: "test.contract",
			run(_turn, context) {
				context.contract = fixtureContract({ complexity: "MEDIUM", executor_class: "balanced" });
			},
		});

		// Pi 1.2+ also fires the event for extension-triggered runs; those carry no prompt and are not routed.
		await handlers.get("before_agent_start")?.({ messageType: "custom", message: { role: "custom" }, systemPrompt: "sys" }, ctx);
		expect(installed).toEqual([]);

		await handlers.get("before_agent_start")?.({ messageType: "user", prompt: "first", systemPrompt: "sys" }, ctx);
		expect(installed.at(-1)).toEqual({ provider: "metered", id: "leanpi-test-flash" });

		// The turn runs, and Pi's loop reports the 429 the provider sent.
		await handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "error", errorMessage: '429: {"type":"GoUsageLimitError"}' }] }, ctx);

		await handlers.get("agent_settled")?.({ aborted: false }, ctx);
		await handlers.get("before_agent_start")?.({ messageType: "user", prompt: "second", systemPrompt: "sys" }, ctx);
		// `balanced` and `quick` share `metered`, so the ladder reaches `strong`,
		// which Pi registers under its CLI provider name.
		expect(installed.at(-1)).toEqual({ provider: "subscription-cli", id: "leanpi-test-opus" });
		expect(notices.some((notice) => notice.includes("rate-limited"))).toBe(true);
		// The native-loop verdict is recorded: a provider error, not a completed turn.
		expect(readRuns(cwd).at(-1)?.result.loop).toBe("error");
		clearLanes();
	}, 30_000);

	it("does not reroute after an operator interrupt", async () => {
		const { cwd, env } = project();
		const { pi, handlers, installed, notices, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
		registerLane({
			name: "test.contract",
			run(_turn, context) {
				context.contract = fixtureContract({ complexity: "MEDIUM", executor_class: "balanced" });
			},
		});

		await handlers.get("before_agent_start")?.({ messageType: "user", prompt: "first", systemPrompt: "sys" }, ctx);
		// Pi records an aborted run signal as an explicit aborted stopReason.
		await handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "aborted", errorMessage: "This operation was aborted" }] }, ctx);
		await handlers.get("agent_settled")?.({ aborted: false }, ctx);
		await handlers.get("before_agent_start")?.({ messageType: "user", prompt: "second", systemPrompt: "sys" }, ctx);

		expect(installed.at(-1)).toEqual({ provider: "metered", id: "leanpi-test-flash" });
		expect(notices.some((notice) => notice.includes("rate-limited"))).toBe(false);
		// The interrupt is not a crash: the row says aborted, not error.
		expect(readRuns(cwd).at(-1)?.result.loop).toBe("aborted");
		clearLanes();
	}, 30_000);
});

describe("PRD-055 AC-5 — cancellation provenance through the real session", () => {
	it.each([false, true])("records the actual outcome when explicit user cancellation is %s", async (cancel) => {
		const { cwd, env } = project();
		const app = await bootSession({ cwd, config: loadConfig(cwd, {}, env), env });
		let runSignal: AbortSignal | undefined;
		let started!: () => void;
		const providerStarted = new Promise<void>((resolve) => { started = resolve; });
		try {
			registerLane({
				name: "test.abort-contract",
				run(_turn, context) {
					context.contract = fixtureContract({ complexity: "MEDIUM", executor_class: "balanced" });
				},
			});
			// Fail at the provider boundary; AgentSession and LeanPi's reporting hooks are real.
			app.session.agent.streamFunction = async (_model, _context, options) => {
				runSignal = options?.signal;
				started();
				if (cancel) await new Promise<void>((resolve) => runSignal!.addEventListener("abort", () => resolve(), { once: true }));
				throw new DOMException("This operation was aborted", "AbortError");
			};
			const turn = app.session.prompt("first");
			await Promise.race([providerStarted, turn.then(() => { throw new Error("Turn ended before the provider started"); })]);
			if (cancel) await app.session.abort();
			await turn;

			expect(runSignal?.aborted).toBe(cancel);
			const last = app.session.state.messages.at(-1);
			expect(last).toMatchObject({ role: "assistant", stopReason: cancel ? "aborted" : "error", errorMessage: "This operation was aborted" });
			const runs = readRuns(cwd);
			expect(runs).toHaveLength(1);
			expect(runs[0]?.result.loop).toBe(cancel ? "aborted" : "error");
		} finally {
			app.session.dispose();
			clearLanes();
		}
	});
});

describe("PRD-055 AC-6 — same-turn quota fallback", () => {
	async function quotaSession(status: number, options: { repeat?: boolean; exhausted?: boolean; pinned?: boolean; noContract?: boolean } = {}) {
		const primary = await startStubBackend([{ status, body: JSON.stringify({ error: { type: status === 429 ? "GoUsageLimitError" : "InsufficientFunds", message: "quota exceeded" } }) }]);
		const fallback = await startStubBackend(options.repeat ? [{ status: 402, body: JSON.stringify({ error: { message: "insufficient account funds" } }) }] : [{ text: "completed on fallback" }]);
		const third = await startStubBackend([{ text: "must not reach a third model" }]);
		const cwd = tempDir("leanpi-quota-");
		writeConfig(cwd, {
			backends: { first: nativeBackend(primary.baseUrl), second: nativeBackend(fallback.baseUrl), third: nativeBackend(third.baseUrl) },
			models: {
				balanced: { backend: "first", model: "leanpi-first" },
				quick: { backend: options.exhausted ? "first" : "second", model: options.exhausted ? "leanpi-first" : "leanpi-second" },
				strong: { backend: options.exhausted ? "first" : "third", model: options.exhausted ? "leanpi-first" : "leanpi-third" },
			},
			lsp: { mode: "off" }, jev: { mode: "disabled" },
		});
		const app = await bootSession({ cwd });
		const notices: string[] = [];
		await app.session.bindExtensions({ uiContext: { ...headlessUIContext(), notify: (message) => notices.push(message) } });
		registerLane({ name: "test.quota-contract", run(_turn, context) {
			if (options.noContract) delete context.contract;
			else context.contract = fixtureContract({ complexity: "MEDIUM", executor_class: "balanced" });
		} });
		if (options.pinned) setRoutePins({ model: { backend: "first", model: "leanpi-first", type: "native" } });
		return {
			app, cwd, primary, fallback, third, notices,
			async close() {
				app.session.dispose();
				clearLanes();
				clearRoutePins();
				await Promise.all([primary.close(), fallback.close(), third.close()]);
			},
		};
	}

	it.each([{ status: 429, compiled: true }, { status: 402, compiled: true }, { status: 429, compiled: false }])("completes the original request after $status, compiled contract: $compiled", async ({ status, compiled }) => {
		const fixture = await quotaSession(status, { noContract: !compiled });
		const { app, cwd, primary, fallback, third, notices } = fixture;
		try {
			await app.session.prompt("complete the original request");
			expect(primary.requests).toHaveLength(1);
			expect(fallback.requests).toHaveLength(1);
			expect(third.requests).toHaveLength(0);
			expect(app.session.state.messages.filter((message) => message.role === "user")).toHaveLength(1);
			expect(app.session.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "completed on fallback" }] });
			const resentUsers = ((fallback.requests[0]?.body.messages ?? []) as Array<{ role: string }>).filter((message) => message.role === "user");
			expect(resentUsers).toEqual([{ role: "user", content: [{ type: "text", text: "complete the original request" }] }]);
			expect(notices.filter((message) => message.includes("retrying"))).toEqual(["session quota exceeded; retrying this turn on second/leanpi-second"]);
			const raw = app.session.sessionManager.getBranch();
			expect(raw.filter((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error")).toHaveLength(1);
			expect(raw.filter((entry) => entry.type === "context_edit")).toHaveLength(1);
			const runs = readRuns(cwd);
			expect(runs.map((run) => run.result.loop)).toEqual(compiled ? ["completed"] : []);
			if (compiled) expect(runs[0]?.calls.map((call) => call.backend)).toEqual(["first", "second"]);
		} finally {
			await fixture.close();
		}
	});

	it.each([
		{ name: "repeated refusal", options: { repeat: true }, retries: 1 },
		{ name: "exhausted configured chain", options: { exhausted: true }, retries: 0 },
		{ name: "pinned model", options: { pinned: true }, retries: 0 },
	])("bounds fallback for $name", async ({ options, retries }) => {
		const fixture = await quotaSession(429, options);
		const { app, cwd, primary, fallback, third, notices } = fixture;
		try {
			await app.session.prompt("complete the original request");
			expect(primary.requests).toHaveLength(1);
			expect(fallback.requests).toHaveLength(retries);
			expect(third.requests).toHaveLength(0);
			expect(notices.filter((message) => message.includes("retrying"))).toHaveLength(retries);
			expect(app.session.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
			expect(app.session.state.messages.filter((message) => message.role === "user")).toHaveLength(1);
			expect(readRuns(cwd).map((run) => run.result.loop)).toEqual(["error"]);
		} finally {
			await fixture.close();
		}
	});
});
