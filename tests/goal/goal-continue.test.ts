/**
 * `/goal` continuation: a settled turn with an active goal starts the next turn.
 *
 * Before this, nothing re-prompted the agent: a goal session stopped whenever
 * the model chose to, with the goal still `active` and `turns_used: 0`.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activate } from "../../src/index.js";
import { clearLanes } from "../../src/commands/session.js";
import { loadConfig } from "../../src/core/config.js";
import { createGoalStore, GOAL_CONTINUE_PREFIX, GOAL_VERIFY_PREFIX, goalContinuation, newGoalState, type SettledTurn } from "../../src/goal/index.js";
import { fixtureCwd } from "./helpers.js";

const SESSION = "s1";

function setup(limits = { max_turns: 0, max_cost: 0 }) {
	const store = createGoalStore(fixtureCwd());
	store.save(newGoalState("finish PRD-828 to 100%", limits, "2026-11-06T00:00:00.000Z", SESSION));
	return store;
}

const turn = (over: Partial<SettledTurn> = {}): SettledTurn => ({ completed: true, usedTools: true, ask: "do it", answer: "Phase 1 done.", ...over });

describe("goal continuation on a settled turn", () => {
	it("continues an active goal after a completed turn and counts the turn", () => {
		const store = setup();
		const next = goalContinuation(store, SESSION, turn(), () => 0);
		expect(next && "continue" in next && next.continue.startsWith(GOAL_CONTINUE_PREFIX)).toBe(true);
		expect(store.load()).toMatchObject({ active: true, turns_used: 1 });
	});

	it("does nothing for an aborted turn, another session's goal, or a stopped goal", () => {
		const store = setup();
		expect(goalContinuation(store, SESSION, turn({ completed: false }), () => 0)).toBeUndefined();
		expect(goalContinuation(store, "other", turn(), () => 0)).toBeUndefined();
		store.save({ ...store.load()!, active: false });
		expect(goalContinuation(store, SESSION, turn(), () => 0)).toBeUndefined();
	});

	it("challenges a first GOAL_MET and stops only when the verification turn repeats it", () => {
		const met = setup();
		const claim = goalContinuation(met, SESSION, turn({ answer: "Remaining items are your laptop runs and your deploy.\n\nGOAL_MET" }), () => 0);
		expect(claim && "continue" in claim && claim.continue.startsWith(GOAL_VERIFY_PREFIX)).toBe(true);
		expect(met.load()?.active).toBe(true);
		const reopened = goalContinuation(met, SESSION, turn({ ask: (claim as { continue: string }).continue, answer: "PRD 06 is still open. Starting it." }), () => 0);
		expect(reopened && "continue" in reopened).toBe(true);
		expect(met.load()?.active).toBe(true);
		const verify = goalContinuation(met, SESSION, turn({ answer: "done\nGOAL_MET" }), () => 0) as { continue: string };
		expect(goalContinuation(met, SESSION, turn({ ask: verify.continue, usedTools: false, answer: "Every part checked.\n\n**GOAL_MET**" }), () => 0)).toMatchObject({ stopped: expect.stringMatching(/^GOAL_MET/) });
		expect(met.load()?.active).toBe(false);
	});

	it("stops on a BLOCKED last line", () => {
		const blocked = setup();
		expect(goalContinuation(blocked, SESSION, turn({ answer: "x\nBLOCKED: needs the npm token" }), () => 0)).toEqual({ stopped: "BLOCKED: needs the npm token" });
		expect(blocked.load()?.active).toBe(false);
	});

	it("does not stop on a marker that is not the last line", () => {
		const store = setup();
		const next = goalContinuation(store, SESSION, turn({ answer: "GOAL_MET is what I will say later.\nStill on phase 2." }), () => 0);
		expect(next && "continue" in next).toBe(true);
	});

	it("stops when a continuation turn makes no tool call, so it cannot spin", () => {
		const store = setup();
		const next = goalContinuation(store, SESSION, turn({ ask: `${GOAL_CONTINUE_PREFIX} "x"`, usedTools: false }), () => 0);
		expect(next).toMatchObject({ stopped: expect.stringMatching(/^BLOCKED/) });
		expect(store.load()?.active).toBe(false);
	});

	it("stops at the turn and cost caps", () => {
		const turns = setup({ max_turns: 1, max_cost: 0 });
		expect(goalContinuation(turns, SESSION, turn(), () => 0)).toMatchObject({ stopped: "BUDGET_EXCEEDED: turns 1/1" });
		const cost = setup({ max_turns: 0, max_cost: 2 });
		expect(goalContinuation(cost, SESSION, turn(), () => 2.5)).toMatchObject({ stopped: "BUDGET_EXCEEDED: cost $2.50/$2.00" });
	});
});

describe("goal continuation through activate()", () => {
	it("a settled turn with a running goal sends the next turn; Escape does not", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "leanpi-goal-wire-"));
		const env = { HOME: cwd, PATH: "", XDG_CONFIG_HOME: join(cwd, ".config") };
		writeFileSync(join(cwd, "leanpi.config.yaml"), "backends:\n  local: { type: native, baseUrl: https://example.test }\nmodels:\n  quick: { backend: local, model: cheap }\nlsp: { mode: off }\njev: { mode: disabled }\n");
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const sent: string[] = [];
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
			registerTool: () => {},
			registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, definition),
			registerProvider: () => {},
			setModel: async () => true,
			setThinkingLevel: () => {},
			setSessionName: () => {},
			getSessionName: () => undefined,
			appendEntry: () => {},
			sendUserMessage: (text: string) => sent.push(text),
		};
		const ctx = {
			hasUI: true,
			cwd,
			isIdle: () => true,
			sessionManager: { getSessionId: () => "pi-session", getEntries: () => [], getBranch: () => [] },
			getContextUsage: () => ({ tokens: 1, contextWindow: 200_000, percent: 1 }),
			modelRegistry: { find: () => undefined },
			ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, input: async () => undefined },
		};
		const say = (role: "user" | "assistant", text: string) => ({ role, content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() });
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });

		await commands.get("goal")!.handler("finish PRD-828", ctx);
		expect(sent).toEqual(["finish PRD-828"]);

		await handlers.get("agent_end")?.({ messages: [say("user", "finish PRD-828"), say("assistant", "Phase 1 done.")] }, ctx);
		await handlers.get("agent_settled")?.({ aborted: false }, ctx);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain(GOAL_CONTINUE_PREFIX);

		await handlers.get("agent_end")?.({ messages: [say("user", "x"), say("assistant", "half")] }, ctx);
		await handlers.get("agent_settled")?.({ aborted: true }, ctx);
		expect(sent).toHaveLength(2);
		clearLanes();
	});
});
