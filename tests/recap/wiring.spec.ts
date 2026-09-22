/**
 * E2 (PRD-036 Phase 2): the recap fires on both turn paths, survives a bad
 * answer, persists, and costs nothing when it is off.
 *
 * The handlers are the real ones `activate()` registers; the only seam is the
 * recap call itself, replaced with a scripted stub. Every assertion on a widget
 * is filtered by the recap key, because `agent_end` also refreshes the todo
 * widget on the same context.
 *
 * Negative control throughout: each "the recap did something" case also asserts
 * the stub runner's call count, so a recap that silently never runs fails the
 * test rather than passing it.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activate } from "../../src/index.js";
import { clearLanes } from "../../src/commands/session.js";
import { loadConfig } from "../../src/core/config.js";
import { LEANPI_RECAP_WIDGET_KEY } from "../../src/cli/recap-widget.js";
import { createRecap, RECAP_ENTRY_TYPE, type RecapRequest, type RecapRunner } from "../../src/recap/index.js";
import { readRuns } from "../../src/telemetry/index.js";
import { fixtureRepo, nativeBackend, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend } from "../helpers/stub-backend.js";

interface WidgetCall {
	key: string;
	content: string[] | undefined;
}

/** Pi's extension API as `activate()` uses it, with the recap surface captured. */
function fakePi(): {
	pi: Record<string, unknown>;
	handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
	notices: string[];
	widgets: WidgetCall[];
	/** Notify and widget calls in the order they happened, for the ordering assertion. */
	events: Array<{ kind: "notify" | "widget"; text: string }>;
	entries: Array<{ customType: string; data: unknown }>;
	sessionNames: string[];
	ctx: Record<string, unknown>;
} {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const notices: string[] = [];
	const widgets: WidgetCall[] = [];
	const events: Array<{ kind: "notify" | "widget"; text: string }> = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const sessionNames: string[] = [];
	let name: string | undefined;
	return {
		handlers,
		notices,
		widgets,
		events,
		entries,
		sessionNames,
		pi: {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
			registerTool: () => {},
			registerCommand: () => {},
			registerProvider: () => {},
			setModel: async () => true,
			setThinkingLevel: () => {},
			setSessionName: (value: string) => {
				sessionNames.push(value);
				name = value;
			},
			getSessionName: () => name,
			appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
		},
		ctx: {
			hasUI: true,
			cwd: process.cwd(),
			sessionManager: {
				getSessionId: () => "pi-session",
				getEntries: () => [],
			},
			getContextUsage: () => ({ tokens: 1234, contextWindow: 200_000, percent: 1 }),
			modelRegistry: { find: () => undefined },
			ui: {
				notify: (message: string) => {
					notices.push(message);
					events.push({ kind: "notify", text: message });
				},
				setStatus: () => {},
				setWidget: (key: string, content: string[] | undefined) => {
					widgets.push({ key, content });
					events.push({ kind: "widget", text: (content ?? []).join(" ") });
				},
				input: async () => undefined,
			},
		},
	};
}

function project(config: string): { cwd: string; env: NodeJS.ProcessEnv } {
	const cwd = mkdtempSync(join(tmpdir(), "leanpi-recap-"));
	writeFileSync(join(cwd, "leanpi.config.yaml"), config);
	return { cwd, env: { HOME: cwd, PATH: "", XDG_CONFIG_HOME: join(cwd, ".config") } };
}

const EXTERNAL = [
	"backends:",
	"  claude: { type: external_harness, vendor: claude, command: leanpi-absent-cli }",
	"models:",
	"  quick: { backend: claude, model: haiku }",
	"  balanced: { backend: claude, model: sonnet }",
	"  strong: { backend: claude, model: opus }",
	"lsp: { mode: off }",
	"jev: { mode: disabled }",
	"",
].join("\n");

const NATIVE = [
	"backends:",
	"  local: { type: native, baseUrl: https://example.test }",
	"models:",
	"  quick: { backend: local, model: cheap }",
	"  balanced: { backend: local, model: cheap }",
	"  strong: { backend: local, model: cheap }",
	"lsp: { mode: off }",
	"jev: { mode: disabled }",
	"",
].join("\n");

/** A mutable scripted runner: the answer can change between drives. */
function stubRunner(): { run: RecapRunner; calls: RecapRequest[]; script: { text?: string; throws?: boolean } } {
	const calls: RecapRequest[] = [];
	const script: { text?: string; throws?: boolean } = {};
	return {
		calls,
		script,
		run: async (request) => {
			calls.push(request);
			if (script.throws) throw new Error("no backend answered");
			return script.text;
		},
	};
}

/** The recap-key widget writes only, in order. */
function recapWidgets(widgets: readonly WidgetCall[]): Array<string[] | undefined> {
	return widgets.filter((call) => call.key === LEANPI_RECAP_WIDGET_KEY).map((call) => call.content);
}

function message(role: "user" | "assistant", text: string): unknown {
	return { role, content: [{ type: "text", text }], timestamp: Date.now() };
}

/** A project whose only backend is a stub OpenAI-compatible server. */
function recapProject(baseUrl: string): string {
	const { cwd } = fixtureRepo();
	writeConfig(cwd, {
		backends: { local: nativeBackend(baseUrl, { model: "cheap" }) },
		models: {
			quick: { backend: "local", model: "cheap" },
			balanced: { backend: "local", model: "cheap" },
			strong: { backend: "local", model: "cheap" },
		},
		lsp: { mode: "off" },
		jev: { mode: "disabled" },
	});
	return cwd;
}

/** The controller with no runner seam: the real `runWorkerTurn` call and its telemetry. */
function controllerHarness(cwd: string, sessionId: string) {
	const widgets: Array<string[] | undefined> = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const names: string[] = [];
	let name: string | undefined;
	const pi = {
		setSessionName: (value: string) => {
			names.push(value);
			name = value;
		},
		getSessionName: () => name,
		appendEntry: (customType: string, data?: unknown) => entries.push({ customType, data }),
	};
	const ctx = { hasUI: true, ui: { setWidget: (_key: string, content: string[] | undefined) => widgets.push(content) } };
	const recap = createRecap({ config: loadConfig(cwd), cwd, sessionId, pi });
	return { recap, ctx, widgets, entries, names };
}

describe("recap wiring (PRD-036 Phase 2)", () => {
	it("writes the widget on the LeanPi-owned path, after the outcome notify (AC-2)", async () => {
		const { cwd, env } = project(EXTERNAL);
		const { pi, handlers, widgets, notices, events, ctx } = fakePi();
		const stub = stubRunner();
		stub.script.text = "RECAP: Wiring the recap into the turn; the widget lands, the title next.";
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		await handlers.get("input")?.({ text: "wire the recap", source: "interactive" }, ctx);

		// The stub actually ran — the negative control.
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.brief).toContain("THIS TURN: wire the recap");
		// The `did` slot is the outcome report verbatim, not a re-derivation of it:
		// the recap owns the sentence, never the turn's own account of itself.
		const reported = notices.find((notice) => /^(✅|⚠️|❌) /.test(notice));
		expect(reported).toBeDefined();
		expect(stub.calls[0]?.brief).toContain(reported?.split("\n")[0]);
		const lines = recapWidgets(widgets);
		expect(lines.some((content) => content?.[0]?.includes("Wiring the recap into the turn"))).toBe(true);
		// The turn's own report is still the thing the user reads first.
		expect(notices.some((notice) => /^(✅|⚠️|❌) /.test(notice))).toBe(true);
		// ...and the recap is written after it, not before: the widget is the second
		// line of the turn, the report is the first.
		const recapEvent = events.findIndex((entry) => entry.kind === "widget" && entry.text.includes("Wiring the recap into the turn"));
		const notifyEvent = events.findIndex((entry) => entry.kind === "notify" && /^(✅|⚠️|❌) /.test(entry.text));
		expect(notifyEvent).toBeGreaterThanOrEqual(0);
		expect(recapEvent).toBeGreaterThan(notifyEvent);
		clearLanes();
	}, 30_000);

	it("writes the same widget on the Pi-owned path, from the agent_end text (AC-3)", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, widgets, ctx } = fakePi();
		const stub = stubRunner();
		stub.script.text = "RECAP: Renaming the helper; the rename landed, the tests are next.";
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		await handlers.get("agent_end")?.({ messages: [message("user", "rename the helper"), message("assistant", "Renamed it in two files.")] }, ctx);
		await handlers.get("agent_settled")?.({}, ctx);

		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.brief).toContain("THIS TURN: rename the helper");
		expect(stub.calls[0]?.brief).toContain("WHAT THE TURN DID: Renamed it in two files.");
		expect(recapWidgets(widgets).some((content) => content?.[0]?.includes("Renaming the helper"))).toBe(true);
		clearLanes();
	});

	it("keeps the previous widget and stays silent on a garbage response (AC-4)", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, widgets, notices, ctx } = fakePi();
		const stub = stubRunner();
		stub.script.text = "RECAP: First recap stands.";
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		const messages = [message("user", "do the thing"), message("assistant", "did it")];
		await handlers.get("agent_end")?.({ messages }, ctx);
		await handlers.get("agent_settled")?.({}, ctx);
		expect(recapWidgets(widgets).at(-1)?.[0]).toContain("First recap stands.");

		const before = recapWidgets(widgets).length;
		const noticesBefore = notices.length;
		stub.script.text = "I could not produce a recap.";
		await handlers.get("agent_end")?.({ messages }, ctx);
		await handlers.get("agent_settled")?.({}, ctx);

		expect(stub.calls).toHaveLength(2);
		// Nothing repainted, nothing said: the previous line is still the last one.
		expect(recapWidgets(widgets)).toHaveLength(before);
		expect(notices).toHaveLength(noticesBefore);
		clearLanes();
	});

	it("keeps the previous widget when the call itself throws (AC-4)", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, widgets, notices, ctx } = fakePi();
		const stub = stubRunner();
		stub.script.text = "RECAP: Still standing.";
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		const messages = [message("user", "ask"), message("assistant", "answer")];
		await handlers.get("agent_end")?.({ messages }, ctx);
		await handlers.get("agent_settled")?.({}, ctx);
		const before = recapWidgets(widgets).length;
		const noticesBefore = notices.length;

		// A backend that throws rather than answering is a different failure from a
		// malformed answer, and it must land the same way: nothing changes.
		stub.script.throws = true;
		await handlers.get("agent_end")?.({ messages }, ctx);
		await handlers.get("agent_settled")?.({}, ctx);

		expect(stub.calls).toHaveLength(2);
		expect(recapWidgets(widgets)).toHaveLength(before);
		expect(notices).toHaveLength(noticesBefore);
		clearLanes();
	});

	it("discards a superseded in-flight call when the next turn starts", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, widgets, ctx } = fakePi();
		let release: (text: string) => void = () => {};
		const gate = new Promise<string>((resolve) => {
			release = resolve;
		});
		const calls: RecapRequest[] = [];
		const run: RecapRunner = async (request) => {
			calls.push(request);
			return gate;
		};
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: run });

		const messages = [message("user", "ask"), message("assistant", "answer")];
		await handlers.get("agent_end")?.({ messages }, ctx);
		const inFlight = handlers.get("agent_settled")?.({}, ctx);
		// The next turn starts before the answer arrives, which invalidates it.
		await handlers.get("agent_start")?.({}, ctx);
		release("RECAP: Stale answer that must not appear.");
		await inFlight;

		expect(calls).toHaveLength(1);
		expect(recapWidgets(widgets).some((content) => content?.[0]?.includes("Stale answer"))).toBe(false);
		clearLanes();
	});

	it("persists with appendEntry and restores on session_start with no model call (AC-5)", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, entries, ctx } = fakePi();
		const stub = stubRunner();
		stub.script.text = "RECAP: Persisted for the resume.";
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		await handlers.get("agent_end")?.({ messages: [message("user", "ask"), message("assistant", "answer")] }, ctx);
		await handlers.get("agent_settled")?.({}, ctx);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.customType).toBe(RECAP_ENTRY_TYPE);
		expect((entries[0]?.data as { recap?: string } | undefined)?.recap).toBe("Persisted for the resume.");

		// A second activation reads the persisted entry back with no model call.
		const second = fakePi();
		const secondStub = stubRunner();
		const seed = { type: "custom", customType: RECAP_ENTRY_TYPE, data: { version: 1, recap: "Persisted for the resume." } };
		(second.ctx.sessionManager as { getEntries: () => unknown[] }).getEntries = () => [seed];
		clearLanes();
		activate(second.pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: secondStub.run });

		await second.handlers.get("session_start")?.({ reason: "resume" }, second.ctx);
		expect(secondStub.calls).toHaveLength(0);
		expect(recapWidgets(second.widgets).some((content) => content?.[0]?.includes("Persisted for the resume."))).toBe(true);
		clearLanes();
	});

	it("runs the real worker call end to end and records the spend", async () => {
		// The one seam the wiring tests replace is exercised here for real: a stub
		// OpenAI-compatible backend, so `runWorkerTurn`, the parse and the telemetry
		// record are the production ones.
		const stub = await startStubBackend([{ text: "RECAP: Real call, real parse.\nTITLE: End To End" }]);
		const cwd = recapProject(stub.baseUrl);
		const harness = controllerHarness(cwd, "e2e");

		const text = await harness.recap.recapTurn(harness.ctx, { ask: "wire the recap", did: "added src/recap" });
		await stub.close();

		expect(text).toBe("Real call, real parse.");
		expect(harness.widgets.at(-1)?.[0]).toContain("Real call, real parse.");
		expect(harness.entries).toHaveLength(1);
		expect(harness.names).toEqual(["End To End"]);

		// The spend is visible in the store `/status` sums, not bypassed through a
		// provider completion that records nothing.
		const runs = readRuns(cwd, { sessionId: "e2e" });
		expect(runs).toHaveLength(1);
		expect(runs[0]?.task_id).toBe("recap:e2e");
		expect(runs[0]?.executor_backend).toBe("local");
		expect(runs[0]?.result.success).toBe(true);
	});

	it("records the spend even when the call fails, and shows nothing", async () => {
		// A failed attempt still spent money, so the record must exist; the user must
		// see nothing at all.
		const stub = await startStubBackend([{ status: 404, body: JSON.stringify({ error: { message: "boom" } }) }]);
		const cwd = recapProject(stub.baseUrl);
		const harness = controllerHarness(cwd, "blocked");

		const text = await harness.recap.recapTurn(harness.ctx, { ask: "ask", did: "did" });
		await stub.close();

		expect(text).toBeUndefined();
		expect(harness.widgets).toHaveLength(0);
		const runs = readRuns(cwd, { sessionId: "blocked" });
		expect(runs).toHaveLength(1);
		expect(runs[0]?.result.success).toBe(false);
	});


	it("makes no model call on either path when recap.enabled is false (AC-8)", async () => {
		const disabled = { external: `${EXTERNAL}recap:\n  enabled: false\n`, native: `${NATIVE}recap:\n  enabled: false\n` };

		const external = project(disabled.external);
		const first = fakePi();
		const firstStub = stubRunner();
		clearLanes();
		activate(first.pi as never, { cwd: external.cwd, config: loadConfig(external.cwd, {}, external.env), env: external.env, recapRunner: firstStub.run });
		await first.handlers.get("input")?.({ text: "wire the recap", source: "interactive" }, first.ctx);
		expect(firstStub.calls).toHaveLength(0);
		clearLanes();

		const native = project(disabled.native);
		const second = fakePi();
		const secondStub = stubRunner();
		clearLanes();
		activate(second.pi as never, { cwd: native.cwd, config: loadConfig(native.cwd, {}, native.env), env: native.env, recapRunner: secondStub.run });
		await second.handlers.get("agent_end")?.({ messages: [message("user", "ask"), message("assistant", "answer")] }, second.ctx);
		await second.handlers.get("agent_settled")?.({}, second.ctx);
		expect(secondStub.calls).toHaveLength(0);
		clearLanes();
	}, 30_000);
});
