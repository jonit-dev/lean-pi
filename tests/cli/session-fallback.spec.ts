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
			"  metered: { type: native, baseUrl: https://example.test }",
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

		await handlers.get("before_agent_start")?.({ prompt: "first", systemPrompt: "sys" }, ctx);
		expect(installed.at(-1)).toEqual({ provider: "metered", id: "leanpi-test-flash" });

		// The turn runs, and Pi's loop reports the 429 the provider sent.
		await handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "error", errorMessage: '429: {"type":"GoUsageLimitError"}' }] }, ctx);

		await handlers.get("before_agent_start")?.({ prompt: "second", systemPrompt: "sys" }, ctx);
		// `balanced` and `quick` share `metered`, so the ladder reaches `strong`.
		expect(installed.at(-1)).toEqual({ provider: "subscription", id: "leanpi-test-opus" });
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

		await handlers.get("before_agent_start")?.({ prompt: "first", systemPrompt: "sys" }, ctx);
		// Esc: Pi's stopReason is "error" but the text is the operator's, not a limit.
		await handlers.get("agent_end")?.({ messages: [{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" }] }, ctx);
		await handlers.get("before_agent_start")?.({ prompt: "second", systemPrompt: "sys" }, ctx);

		expect(installed.at(-1)).toEqual({ provider: "metered", id: "leanpi-test-flash" });
		expect(notices.some((notice) => notice.includes("rate-limited"))).toBe(false);
		// The interrupt is not a crash: the row says aborted, not error.
		expect(readRuns(cwd).at(-1)?.result.loop).toBe("aborted");
		clearLanes();
	}, 30_000);
});
