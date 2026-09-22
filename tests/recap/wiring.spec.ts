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
	/** Pi commands `activate()`'s bridge registered, so the real handler is drivable. */
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	notices: string[];
	widgets: WidgetCall[];
	/** Notify and widget calls in the order they happened, for the ordering assertion. */
	events: Array<{ kind: "notify" | "widget"; text: string }>;
	entries: Array<{ customType: string; data: unknown }>;
	sessionNames: string[];
	ctx: Record<string, unknown>;
} {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notices: string[] = [];
	const widgets: WidgetCall[] = [];
	const events: Array<{ kind: "notify" | "widget"; text: string }> = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const sessionNames: string[] = [];
	let name: string | undefined;
	return {
		handlers,
		commands,
		notices,
		widgets,
		events,
		entries,
		sessionNames,
		pi: {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
			registerTool: () => {},
			registerCommand: (commandName: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(commandName, definition),
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
				// `getEntries()` is every branch; `getBranch()` is the active
				// ancestry. Restore must read the latter, so the fake carries both.
				getEntries: () => [],
				getBranch: () => [],
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

// The recap's role resolves nowhere while the config is otherwise valid: the
// single bound backend is disabled, so the role chain has nothing to fall to.
// This is the state a manual `/recap` must report truthfully.
const NO_ROLE = [
	"backends:",
	"  local: { type: native, baseUrl: https://example.test, enabled: false }",
	"models:",
	"  quick: { backend: local, model: cheap }",
	"lsp: { mode: off }",
	"jev: { mode: disabled }",
	"recap: { role: quick }",
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

/** Seed a recap entry on the session, on both the all-branches and active-branch reads. */
function seedBranch(ctx: Record<string, unknown>, entries: unknown[]): void {
	const manager = ctx.sessionManager as { getEntries: () => unknown[]; getBranch: () => unknown[] };
	manager.getEntries = () => entries;
	manager.getBranch = () => entries;
}

/** A message entry as `getBranch()` returns it (root-to-leaf). */
function branchMessage(role: "user" | "assistant", text: string): unknown {
	return { type: "message", message: message(role, text) };
}

/** An assistant entry that only asked for a tool: not a completed answer. */
function toolCallEntry(): unknown {
	return { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", id: "c1" }], timestamp: Date.now() } };
}

/** A custom entry exactly as `appendEntry` persists it. */
function customEntry(data: unknown): unknown {
	return { type: "custom", customType: RECAP_ENTRY_TYPE, data };
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
		// Two entries per successful turn: the durable input written before the
		// call, then the sentence it produced.
		expect(entries).toHaveLength(2);
		expect(entries[0]?.customType).toBe(RECAP_ENTRY_TYPE);
		expect((entries[0]?.data as { ask?: string } | undefined)?.ask).toBe("ask");
		expect((entries[1]?.data as { recap?: string } | undefined)?.recap).toBe("Persisted for the resume.");

		// A second activation reads the persisted entry back with no model call.
		const second = fakePi();
		const secondStub = stubRunner();
		const seed = { type: "custom", customType: RECAP_ENTRY_TYPE, data: { version: 1, recap: "Persisted for the resume." } };
		seedBranch(second.ctx, [seed]);
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
		expect(harness.entries).toHaveLength(2);
		expect((harness.entries[0]?.data as { ask?: string } | undefined)?.ask).toBe("wire the recap");
		expect((harness.entries[1]?.data as { recap?: string } | undefined)?.recap).toBe("Real call, real parse.");
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

	// PRD-040 Phase 4 (recap lifecycle): the controller distinguishes a turn-start
	// hide from a session reset. A resumed session replays its own persisted recap
	// from cache, and an in-flight generation from the session that went away can
	// neither repaint nor be replayed after the switch.
	it("shows the persisted recap on resume and '/recap' repeats it without a model call", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, commands, notices, widgets, ctx } = fakePi();
		const stub = stubRunner();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });
		const seed = { type: "custom", customType: RECAP_ENTRY_TYPE, data: { version: 1, recap: "Persisted for the resume." } };
		seedBranch(ctx, [seed]);

		await handlers.get("session_start")?.({ reason: "resume" }, ctx);
		await commands.get("recap")?.handler("", ctx);

		// Replayed from cache: no model call, and certainly not a false no-turn.
		expect(stub.calls).toHaveLength(0);
		expect(notices.join("\n")).not.toContain("nothing to recap yet");
		expect(notices.join("\n")).toContain("Persisted for the resume.");
		expect(recapWidgets(widgets).some((content) => content?.[0]?.includes("Persisted for the resume."))).toBe(true);
		clearLanes();
	});

	it("does not leak session A's recap into an empty session B after a switch", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, commands, notices, ctx } = fakePi();
		const stub = stubRunner();
		stub.script.text = "RECAP: Session A work.";
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		const messages = [message("user", "session A ask"), message("assistant", "session A answer")];
		await handlers.get("agent_end")?.({ messages }, ctx);
		await handlers.get("agent_settled")?.({}, ctx);
		expect(stub.calls).toHaveLength(1);

		// A fresh session with no persisted entry replaces the one that went away.
		seedBranch(ctx, []);
		await handlers.get("session_start")?.({ reason: "resume" }, ctx);
		const callsBefore = stub.calls.length;
		await commands.get("recap")?.handler("", ctx);

		expect(stub.calls).toHaveLength(callsBefore);
		expect(notices.join("\n")).not.toContain("Session A work.");
		expect(notices.join("\n")).toContain("nothing to recap yet");
		clearLanes();
	});

	it("discards a pending recap from the previous session after a switch", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, widgets, ctx } = fakePi();
		let release: (text: string) => void = () => {};
		const gate = new Promise<string>((resolve) => {
			release = resolve;
		});
		const run: RecapRunner = async () => gate;
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: run });

		await handlers.get("agent_end")?.({ messages: [message("user", "session A ask"), message("assistant", "session A answer")] }, ctx);
		const inFlight = handlers.get("agent_settled")?.({}, ctx);
		seedBranch(ctx, [
			{ type: "custom", customType: RECAP_ENTRY_TYPE, data: { version: 1, recap: "Session B persisted." } },
		]);
		await handlers.get("session_start")?.({ reason: "resume" }, ctx);
		release("RECAP: Stale Session A answer that must not appear.");
		await inFlight;

		const painted = recapWidgets(widgets).map((content) => content?.[0] ?? "").join("\n");
		expect(painted).toContain("Session B persisted.");
		expect(painted).not.toContain("Stale Session A answer");
		clearLanes();
	});

	it("reports a generation failure after a real turn instead of a false no-turn", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, commands, notices, ctx } = fakePi();
		const stub = stubRunner();
		stub.script.throws = true;
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		await handlers.get("agent_end")?.({ messages: [message("user", "real ask"), message("assistant", "real answer")] }, ctx);
		await handlers.get("agent_settled")?.({}, ctx);
		await commands.get("recap")?.handler("", ctx);

		expect(stub.calls).toHaveLength(2);
		expect(notices.join("\n")).not.toContain("nothing to recap yet");
		expect(notices.join("\n")).toMatch(/generation failed/i);
		clearLanes();
	});

	it("still reports a true no-turn when there is no input and no cached recap", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, commands, notices, ctx } = fakePi();
		const stub = stubRunner();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		await commands.get("recap")?.handler("", ctx);

		expect(stub.calls).toHaveLength(0);
		expect(notices.join("\n")).toContain("nothing to recap yet");
		clearLanes();
	});

	// PRD-040 P4-R (branch ancestry): restore reads the *active* branch, not every
	// branch in the session. A newer recap written on a sibling branch must not
	// answer for the branch the user is actually on.
	it("restores the active branch's recap, not a newer sibling's", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, widgets, ctx } = fakePi();
		const stub = stubRunner();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		const branchA = { type: "custom", customType: RECAP_ENTRY_TYPE, data: { version: 1, recap: "Branch A recap." } };
		const siblingB = { type: "custom", customType: RECAP_ENTRY_TYPE, data: { version: 1, recap: "Branch B recap." } };
		const manager = ctx.sessionManager as { getEntries: () => unknown[]; getBranch: () => unknown[] };
		// B is newer in the append-only log, but A is the active ancestry.
		manager.getEntries = () => [branchA, siblingB];
		manager.getBranch = () => [branchA];

		await handlers.get("session_start")?.({ reason: "resume" }, ctx);

		expect(stub.calls).toHaveLength(0);
		expect(recapWidgets(widgets).some((content) => content?.[0]?.includes("Branch A recap."))).toBe(true);
		expect(recapWidgets(widgets).some((content) => content?.[0]?.includes("Branch B recap."))).toBe(false);
		clearLanes();
	});

	// Navigating the session tree moves the active leaf. The recap cached for the
	// branch that was active must not be replayed for the branch just navigated to.
	it("refreshes the cached recap from the branch a session_tree navigation lands on", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, commands, notices, ctx } = fakePi();
		const stub = stubRunner();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		const branchA = { type: "custom", customType: RECAP_ENTRY_TYPE, data: { version: 1, recap: "Branch A recap." } };
		const siblingB = { type: "custom", customType: RECAP_ENTRY_TYPE, data: { version: 1, recap: "Branch B recap." } };
		const manager = ctx.sessionManager as { getEntries: () => unknown[]; getBranch: () => unknown[] };
		manager.getEntries = () => [branchA, siblingB];
		manager.getBranch = () => [siblingB];
		await handlers.get("session_start")?.({ reason: "resume" }, ctx);

		// Pi's navigateTree moves the leaf to the older sibling: the active branch is A.
		manager.getBranch = () => [branchA];
		await handlers.get("session_tree")?.({ type: "session_tree", newLeafId: "a", oldLeafId: "b" }, ctx);
		await commands.get("recap")?.handler("", ctx);

		// No model call: the cache was refreshed from the new branch, so `/recap`
		// replays A rather than the stale B from the branch that went away.
		expect(stub.calls).toHaveLength(0);
		expect(notices.join("\n")).toContain("Branch A recap.");
		expect(notices.join("\n")).not.toContain("Branch B recap.");
		clearLanes();
	});

	// A recap call that was in flight on the previous branch must not append or
	// repaint after the user navigates away from it.
	it("does not let a pending prior-branch recap repaint or persist after navigation", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, widgets, entries, ctx } = fakePi();
		let release: (text: string) => void = () => {};
		const gate = new Promise<string>((resolve) => {
			release = resolve;
		});
		const run: RecapRunner = async () => gate;
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: run });

		// A recap for the branch active now (A) is in flight.
		await handlers.get("agent_end")?.({ messages: [message("user", "branch A ask"), message("assistant", "branch A answer")] }, ctx);
		const inFlight = handlers.get("agent_settled")?.({}, ctx);

		// The user navigates to sibling B, which carries its own persisted recap.
		const branchB = { type: "custom", customType: RECAP_ENTRY_TYPE, data: { version: 1, recap: "Branch B recap." } };
		(ctx.sessionManager as { getBranch: () => unknown[] }).getBranch = () => [branchB];
		await handlers.get("session_tree")?.({ type: "session_tree", newLeafId: "b", oldLeafId: "a" }, ctx);
		release("RECAP: Stale branch A answer.");
		await inFlight;

		const painted = recapWidgets(widgets).map((content) => content?.[0] ?? "").join("\n");
		expect(painted).toContain("Branch B recap.");
		expect(painted).not.toContain("Stale branch A answer");
		expect(entries.some((entry) => (entry.data as { recap?: string } | undefined)?.recap === "Stale branch A answer.")).toBe(false);
		clearLanes();
	});

	// A completed turn whose recap role resolves nowhere must still be remembered,
	// so a manual `/recap` names the real reason (unavailable) rather than claiming
	// there was no first turn.
	it("reports an unavailable recap role after a completed turn, never a false no-turn", async () => {
		const { cwd, env } = project(NO_ROLE);
		const { pi, handlers, commands, notices, ctx } = fakePi();
		const stub = stubRunner();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		await handlers.get("agent_end")?.({ messages: [message("user", "real ask"), message("assistant", "real answer")] }, ctx);
		await handlers.get("agent_settled")?.({}, ctx);
		await commands.get("recap")?.handler("", ctx);

		// The role resolves nowhere, so no model call ever happens...
		expect(stub.calls).toHaveLength(0);
		// ...but the turn is remembered and the reason is the truthful one.
		expect(notices.join("\n")).not.toContain("nothing to recap yet");
		// The reason names the role, not the off switch or the drawing surface.
		expect(notices.join("\n")).toContain("role is unavailable");
		clearLanes();
	});

	// PRD-040 (durable recap input): a resumed branch whose turns never persisted
	// a recap still has a turn. The native path writes user/assistant messages to
	// Pi's transcript, so restore reads the active branch's newest completed pair
	// without a model call; `/recap` then buys the one sentence.
	it("restores a completed native turn from the active branch when no recap was persisted", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, commands, notices, ctx } = fakePi();
		const stub = stubRunner();
		stub.script.text = "RECAP: Generated from the resumed transcript.";
		seedBranch(ctx, [branchMessage("user", "native ask"), branchMessage("assistant", "native answer")]);
		const manager = ctx.sessionManager as { getEntries: () => unknown[]; getBranch: () => unknown[] };
		manager.getEntries = () => [branchMessage("user", "unrelated sibling goal"), ...manager.getBranch()];
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		await handlers.get("session_start")?.({ reason: "resume" }, ctx);
		// Restore itself never spends: the sentence is only bought on demand.
		expect(stub.calls).toHaveLength(0);
		await commands.get("recap")?.handler("", ctx);

		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.brief).toContain("THIS TURN: native ask");
		expect(stub.calls[0]?.brief).toContain("native answer");
		expect(stub.calls[0]?.brief).not.toContain("unrelated sibling goal");
		expect(notices.join("\n")).toContain("Generated from the resumed transcript.");
		clearLanes();
	});

	it.each([
		{ version: 1, recap: "Older cached recap." },
		{ version: 1, ask: "older ask", did: "older answer" },
	])("restores completed native work newer than a saved recap/input entry (%j)", async (older) => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, commands, notices, ctx } = fakePi();
		const stub = stubRunner();
		stub.script.text = "RECAP: Latest completed native work.";
		seedBranch(ctx, [customEntry(older), branchMessage("user", "newest ask"), branchMessage("assistant", "newest answer")]);
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		await handlers.get("session_start")?.({ reason: "resume" }, ctx);
		expect(stub.calls).toHaveLength(0);
		await commands.get("recap")?.handler("", ctx);

		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.brief).toContain("THIS TURN: newest ask");
		expect(stub.calls[0]?.brief).toContain("newest answer");
		expect(notices.join("\n")).toContain("Latest completed native work.");
		clearLanes();
	});

	it("falls back to the prior completed pair when the branch ends on an unanswered user", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, commands, ctx } = fakePi();
		const stub = stubRunner();
		stub.script.text = "RECAP: Prior pair.";
		seedBranch(ctx, [
			branchMessage("user", "first ask"),
			branchMessage("assistant", "first answer"),
			branchMessage("user", "trailing unanswered"),
		]);
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		await handlers.get("session_start")?.({ reason: "resume" }, ctx);
		await commands.get("recap")?.handler("", ctx);

		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.brief).toContain("THIS TURN: first ask");
		expect(stub.calls[0]?.brief).toContain("first answer");
		expect(stub.calls[0]?.brief).not.toContain("trailing unanswered");
		clearLanes();
	});

	it("does not invent a turn from an empty, user-only or tool-call-only branch", async () => {
		const branches: unknown[][] = [
			[],
			[branchMessage("user", "only a question")],
			[branchMessage("user", "ask"), toolCallEntry()],
		];
		for (const branch of branches) {
			const { cwd, env } = project(NATIVE);
			const { pi, handlers, commands, notices, ctx } = fakePi();
			const stub = stubRunner();
			seedBranch(ctx, branch);
			clearLanes();
			activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

			await handlers.get("session_start")?.({ reason: "resume" }, ctx);
			await commands.get("recap")?.handler("", ctx);

			expect(stub.calls).toHaveLength(0);
			expect(notices.join("\n")).toContain("nothing to recap yet");
			clearLanes();
		}
	});

	it("does not borrow a completed turn from a sibling branch", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, commands, notices, ctx } = fakePi();
		const stub = stubRunner();
		const manager = ctx.sessionManager as { getEntries: () => unknown[]; getBranch: () => unknown[] };
		// The append-only log has a completed pair; the active ancestry does not.
		manager.getEntries = () => [branchMessage("user", "sibling ask"), branchMessage("assistant", "sibling answer")];
		manager.getBranch = () => [];
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		await handlers.get("session_start")?.({ reason: "resume" }, ctx);
		await commands.get("recap")?.handler("", ctx);

		expect(stub.calls).toHaveLength(0);
		expect(notices.join("\n")).toContain("nothing to recap yet");
		clearLanes();
	});

	it("replays a new-format persisted recap on resume with no model call", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, commands, notices, ctx } = fakePi();
		const stub = stubRunner();
		seedBranch(ctx, [customEntry({ version: 1, ask: "a", did: "b", recap: "New format persisted." })]);
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });

		await handlers.get("session_start")?.({ reason: "resume" }, ctx);
		await commands.get("recap")?.handler("", ctx);

		expect(stub.calls).toHaveLength(0);
		expect(notices.join("\n")).toContain("New format persisted.");
		clearLanes();
	});

	// An external-harness turn is `action: "handled"` before Pi writes any
	// user/assistant message, so the transcript cannot recover it. The custom
	// input entry is the durable record; a failed recap still leaves it for a
	// later manual `/recap` on the resumed session.
	it("recovers an external turn whose recap failed, from the real appended input on resume", async () => {
		const { cwd, env } = project(EXTERNAL);
		const first = fakePi();
		const failing = stubRunner();
		failing.script.throws = true;
		clearLanes();
		activate(first.pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: failing.run });
		await first.handlers.get("input")?.({ text: "external ask", source: "interactive" }, first.ctx);

		expect(failing.calls).toHaveLength(1);
		expect(first.entries).toHaveLength(1);
		expect((first.entries[0]?.data as { ask?: string } | undefined)?.ask).toBe("external ask");

		const second = fakePi();
		const working = stubRunner();
		working.script.text = "RECAP: Generated for the external turn.";
		// The old cached recap is older than the real input entry appended above.
		seedBranch(second.ctx, [customEntry({ version: 1, recap: "Old cached recap." }), ...first.entries.map((entry) => customEntry(entry.data))]);
		clearLanes();
		activate(second.pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: working.run });
		await second.handlers.get("session_start")?.({ reason: "resume" }, second.ctx);

		// The newest entry is input-only: nothing is replayed yet.
		expect(working.calls).toHaveLength(0);
		expect(recapWidgets(second.widgets).some((content) => content?.[0]?.includes("Old cached recap."))).toBe(false);
		await second.commands.get("recap")?.handler("", second.ctx);

		// The manual command generates for the latest turn, not the old cache.
		expect(working.calls).toHaveLength(1);
		expect(working.calls[0]?.brief).toContain("THIS TURN: external ask");
		expect(second.notices.join("\n")).toContain("Generated for the external turn.");
		expect(second.notices.join("\n")).not.toContain("Old cached recap.");
		clearLanes();
	}, 30_000);

	it("retains a completed external turn across /recap off then on", async () => {
		const { cwd, env } = project(`${EXTERNAL}recap:\n  enabled: false\n`);
		const { pi, handlers, commands, notices, ctx } = fakePi();
		const stub = stubRunner();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env, recapRunner: stub.run });
		await handlers.get("input")?.({ text: "off then on ask", source: "interactive" }, ctx);
		expect(stub.calls).toHaveLength(0);

		await commands.get("recap")?.handler("on", ctx);
		stub.script.text = "RECAP: Retained across the switch.";
		await commands.get("recap")?.handler("", ctx);

		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.brief).toContain("THIS TURN: off then on ask");
		expect(notices.join("\n")).toContain("Retained across the switch.");
		clearLanes();
	}, 30_000);
});
