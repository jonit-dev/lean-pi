/**
 * PRD-029 Phase 3: the native first turn is responsive and bounded.
 *
 * These drive the *registered* `before_agent_start` handler through `activate()`
 * — not a reimplementation — against a real deferred JEV transport, so the JEV
 * seam exercised is the one production uses (`JevTransport`), with only the
 * network substituted. A native backend makes Pi's own loop the executor (§23),
 * which is the path the pause was reported on.
 *
 * Timing note: the "within budget" assertions use the transport as the clock. A
 * caller-supplied transport that hangs is not real provider timing; it is the
 * worst case for a bound, and it is labelled as such.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activate, clearLanes } from "../src/index.js";
import { loadConfig } from "../src/core/config.js";
import type { JevTransport, JevTransportRequest, JevTransportResponse } from "../src/jev/client.js";
import { typedAnswers } from "./helpers/stub-jev.js";

interface PiHarness {
	handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
	statuses: Array<string | undefined>;
	ctx: Record<string, unknown>;
}

interface DecisionRow {
	siteId: string;
	modelVersion: string;
	fallbackUsed: boolean;
	reason?: string;
}

function nativeProject(): { cwd: string; env: NodeJS.ProcessEnv } {
	const root = mkdtempSync(join(tmpdir(), "leanpi-firstturn-"));
	const cwd = join(root, "project");
	const home = join(root, "home");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(
		join(cwd, "leanpi.config.yaml"),
		[
			"backends:",
			"  local: { type: native, baseUrl: https://example.test, apiKey: TEST_KEY }",
			"models:",
			"  quick: { backend: local, model: cheap }",
			"  balanced: { backend: local, model: cheap }",
			"  strong: { backend: local, model: cheap }",
			"lsp: { mode: off }",
			"jev:",
			"  mode: enabled",
			"  apiKey: test-key",
			"",
		].join("\n"),
	);
	return { cwd, env: { HOME: home, PATH: "", XDG_CONFIG_HOME: join(home, ".config") } };
}

function harness(statuses: Array<string | undefined>): PiHarness {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const ctx = {
		hasUI: true,
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => "pi-session" },
		model: { provider: "local", id: "cheap" },
		modelRegistry: { find: () => undefined },
		ui: {
			notify: () => {},
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			input: async () => undefined,
		},
	};
	return { handlers, statuses, ctx };
}

function fakePi(handlers: PiHarness["handlers"]): Record<string, unknown> {
	return {
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
		registerTool: () => {},
		registerCommand: () => {},
		registerProvider: () => {},
		setModel: async () => true,
		setThinkingLevel: () => {},
	};
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

function ok(request: JevTransportRequest): JevTransportResponse {
	const body = JSON.parse(request.body) as Record<string, unknown>;
	return { status: 200, text: JSON.stringify({ model: "jev-stub", answers: typedAnswers(body), usage: { input_tokens: 10, output_tokens: 2 } }) };
}

/** The compiler site a JEV request belongs to, identified by its question ids. */
function siteOf(ids: readonly string[]): "gate" | "complexity" | "capability" | "risk" | "skill" | "other" {
	if (ids.includes("architecture") && ids.includes("localized")) return "gate";
	if (ids.includes("mechanical") && ids.includes("several_modules")) return "complexity";
	if (ids.includes("specialization") && ids.includes("index")) return "capability";
	if (ids.includes("deterministic_sufficient") && ids.includes("wide_blast")) return "risk";
	if (ids.some((id) => id === "any_skill" || id.startsWith("relevance:") || id.startsWith("fit:"))) return "skill";
	return "other";
}

function decisionRows(cwd: string): DecisionRow[] {
	try {
		return readFileSync(join(cwd, ".leanpi", "decisions.jsonl"), "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as DecisionRow);
	} catch {
		return [];
	}
}

const projects: string[] = [];

afterEach(() => {
	clearLanes();
	vi.useRealTimers();
	for (const cwd of projects.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

function trackedProject(): { cwd: string; env: NodeJS.ProcessEnv } {
	const project = nativeProject();
	projects.push(project.cwd);
	return project;
}

describe("native before_agent_start is responsive and bounded (PRD-029)", () => {
	it("sets a status while a compiler site is genuinely blocked, then replaces it on success (AC-5)", async () => {
		const { cwd, env } = trackedProject();
		const statuses: Array<string | undefined> = [];
		const { handlers, ctx } = harness(statuses);

		const release = deferred();
		let gateBlocked = false;
		const transport: JevTransport = async (request: JevTransportRequest): Promise<JevTransportResponse> => {
			if (siteOf(Object.keys((JSON.parse(request.body) as { questions?: Record<string, unknown> }).questions ?? {})) === "gate" && !gateBlocked) {
				gateBlocked = true;
				await release.promise;
			}
			return ok(request);
		};

		clearLanes();
		activate(fakePi(handlers) as never, { cwd, config: loadConfig(cwd, {}, env), env, jevTransport: transport });
		const handler = handlers.get("before_agent_start");
		expect(handler).toBeDefined();

		let settled = false;
		const turn = handler!({ prompt: "rename the helper in src/target.ts", systemPrompt: "you are an assistant" }, ctx).then((value) => {
			settled = true;
			return value;
		});
		// Wait until the gate request is in flight, without releasing it.
		for (let i = 0; i < 100 && !gateBlocked; i += 1) await new Promise((r) => setTimeout(r, 1));

		// The status exists while the blocked site is still pending, and the turn is
		// genuinely pending — this is what the old test never proved.
		expect(statuses.some((text) => text?.startsWith("LeanPi: "))).toBe(true);
		expect(settled).toBe(false);

		release.resolve();
		await turn;

		// The final status replaces the progress text, so the pause is not left up.
		expect(statuses.filter((text) => text?.startsWith("LeanPi: ")).length).toBeGreaterThan(0);
		expect(statuses[statuses.length - 1]).toMatch(/^Auto: /);
	});

	it("returns within the budget when the transport never answers, with fallback decisions (AC-7)", async () => {
		const { cwd, env } = trackedProject();
		const statuses: Array<string | undefined> = [];
		const { handlers, ctx } = harness(statuses);

		// The worst case: a transport that ignores its abort signal and never
		// resolves. `ask` must still bound the turn. This is a synthetic hang, not
		// provider timing; the 5 s budget is the property under test.
		const transport: JevTransport = () => new Promise<JevTransportResponse>(() => {});
		clearLanes();
		activate(fakePi(handlers) as never, { cwd, config: loadConfig(cwd, {}, env), env, jevTransport: transport });

		vi.useFakeTimers();
		const turn = handlers.get("before_agent_start")!({ prompt: "rename the helper", systemPrompt: "" }, ctx);
		await vi.advanceTimersByTimeAsync(5_000);
		await turn;

		expect(statuses[statuses.length - 1]).toMatch(/^Auto: /);
		const rows = decisionRows(cwd);
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every((row) => row.fallbackUsed)).toBe(true);
		expect(rows.some((row) => String(row.reason ?? "").includes("budget"))).toBe(true);
	}, 20_000);

	it("recovers the next turn on a healthy control plane after a timed-out compile (AC-8)", async () => {
		const { cwd, env } = trackedProject();
		const statuses: Array<string | undefined> = [];
		const { handlers, ctx } = harness(statuses);

		let healthy = false;
		const transport: JevTransport = (request: JevTransportRequest): Promise<JevTransportResponse> =>
			healthy ? Promise.resolve(ok(request)) : new Promise<JevTransportResponse>(() => {});

		clearLanes();
		activate(fakePi(handlers) as never, { cwd, config: loadConfig(cwd, {}, env), env, jevTransport: transport });

		vi.useFakeTimers();
		const first = handlers.get("before_agent_start")!({ prompt: "first turn", systemPrompt: "" }, ctx);
		await vi.advanceTimersByTimeAsync(5_000);
		await first;

		const afterFirst = decisionRows(cwd);
		expect(afterFirst.length).toBeGreaterThan(0);
		expect(afterFirst.every((row) => row.fallbackUsed)).toBe(true);

		// Turn 2: a healthy control plane on the same session must compile for real —
		// the timed-out budget was not reused.
		healthy = true;
		const second = handlers.get("before_agent_start")!({ prompt: "second turn", systemPrompt: "" }, ctx);
		await vi.advanceTimersByTimeAsync(0);
		await second;

		const afterSecond = decisionRows(cwd).slice(afterFirst.length);
		expect(afterSecond.length).toBeGreaterThan(0);
		expect(afterSecond.some((row) => !row.fallbackUsed)).toBe(true);
		expect(statuses[statuses.length - 1]).toMatch(/^Auto: /);
	}, 20_000);

	it("drops a transport that resolves after the budget, leaving no late decision (AC-7)", async () => {
		const { cwd, env } = trackedProject();
		const statuses: Array<string | undefined> = [];
		const { handlers, ctx } = harness(statuses);

		const release = deferred();
		const transport: JevTransport = async (request: JevTransportRequest): Promise<JevTransportResponse> => {
			// Ignores the abort signal entirely, then resolves after the budget.
			await release.promise;
			return ok(request);
		};

		const rejections: unknown[] = [];
		const onRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		clearLanes();
		activate(fakePi(handlers) as never, { cwd, config: loadConfig(cwd, {}, env), env, jevTransport: transport });

		vi.useFakeTimers();
		try {
			const turn = handlers.get("before_agent_start")!({ prompt: "rename the helper", systemPrompt: "" }, ctx);
			await vi.advanceTimersByTimeAsync(5_000);
			await turn;
			const afterBudget = decisionRows(cwd);
			expect(afterBudget.every((row) => row.fallbackUsed)).toBe(true);

			// Release the late responses and let every continuation run.
			release.resolve();
			await vi.runAllTimersAsync();
			for (let i = 0; i < 5; i += 1) await Promise.resolve();

			const afterLate = decisionRows(cwd);
			expect(afterLate.length).toBe(afterBudget.length);
			expect(afterLate.every((row) => row.fallbackUsed)).toBe(true);
			expect(afterLate.some((row) => row.modelVersion === "jev-stub")).toBe(false);
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	}, 20_000);

	it("clears the progress status when a registered lane throws (AC-5)", async () => {
		const { cwd, env } = trackedProject();
		const statuses: Array<string | undefined> = [];
		const { handlers, ctx } = harness(statuses);

		clearLanes();
		const session = activate(fakePi(handlers) as never, {
			cwd,
			config: loadConfig(cwd, {}, env),
			env,
			jevTransport: (request) => Promise.resolve(ok(request)),
		});
		// A real lane on the real registry, failing after the compiler.
		session.registerLane({ name: "boom", run: () => { throw new Error("compile exploded"); } });

		await expect(handlers.get("before_agent_start")!({ prompt: "rename the helper", systemPrompt: "" }, ctx)).rejects.toThrow("compile exploded");
		expect(statuses[statuses.length - 1]).toBeUndefined();
	});
});
