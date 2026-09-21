/**
 * PRD-013 Phase 1 / AC-1 — `/goal` and the persisted record.
 *
 * The risk this covers is a lossy or defaulted deserialization: a resumed
 * session that silently resets a budget, or a flagless goal that runs unbounded
 * on one axis because a limit was left null.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../src/commands/registry.js";
import { checkBudget, createGoalStore, goalStatePath, goalTextSource, newGoalState, registerGoalCommands } from "../../src/goal/index.js";
import { fixtureCwd, goalConfig } from "./helpers.js";

describe("PRD-013 Phase 1 — the persisted goal record", () => {
	it("AC-1: /goal sets a goal that a fresh store instance deserializes exactly", async () => {
		const cwd = fixtureCwd();
		const registry = createCommandRegistry();
		registerGoalCommands(registry, { cwd, config: goalConfig(cwd), costSoFar: () => 0 });

		const set = await registry.dispatch("/goal ship the parser fix --max-turns 5 --max-cost 2.00", { cwd });
		expect(set.ok).toBe(true);
		expect(set.text).toContain("ship the parser fix");

		// A second store over the same backing file is the "resumed in a new
		// process" path: nothing is carried in memory between the two.
		const record = createGoalStore(cwd).load();
		expect(record).not.toBeNull();
		expect(Object.keys(record!).sort()).toEqual(["active", "max_cost", "max_turns", "started_at", "text", "turns_used"]);
		expect(record).toEqual({
			text: "ship the parser fix",
			active: true,
			max_turns: 5,
			max_cost: 2,
			started_at: record!.started_at,
			turns_used: 0,
		});
		expect(new Date(record!.started_at).toISOString()).toBe(record!.started_at);
	});

	it("AC-1: a flagless goal takes the configured defaults on both axes, and follows the config", async () => {
		const cwd = fixtureCwd();
		const registry = createCommandRegistry();
		const defaults = { default_max_turns: 7, default_max_cost: 3.5 };
		registerGoalCommands(registry, { cwd, config: goalConfig(cwd, { goal: defaults }), costSoFar: () => 0 });

		await registry.dispatch("/goal ship the parser fix", { cwd });
		const first = createGoalStore(cwd).load();
		expect(first!.max_turns).toBe(7);
		expect(first!.max_cost).toBe(3.5);

		// Changing the config changes the next goal's bounds: the defaults are read,
		// not baked in.
		registerGoalCommands(registry, {
			cwd,
			config: goalConfig(cwd, { goal: { default_max_turns: 10, default_max_cost: 1.25 } }),
			costSoFar: () => 0,
		});
		await registry.dispatch("/goal ship the parser fix", { cwd });
		const second = createGoalStore(cwd).load();
		expect(second!.max_turns).toBe(10);
		expect(second!.max_cost).toBe(1.25);
	});

	it("a flagless goal with no configured defaults is uncapped, and starts its own turn", async () => {
		const cwd = fixtureCwd();
		const registry = createCommandRegistry();
		registerGoalCommands(registry, { cwd, config: goalConfig(cwd), costSoFar: () => 0 });

		const set = await registry.dispatch("/goal execute docs/PRDs/xyz.md", { cwd });
		// The command is the start signal, not just a write: without `start` the
		// session sat idle after the echo until the user typed again.
		expect(set.start).toBe("execute docs/PRDs/xyz.md");

		const record = createGoalStore(cwd).load();
		expect(record!.max_turns).toBe(0);
		expect(record!.max_cost).toBe(0);
		expect(checkBudget({ ...record!, turns_used: 99 }, 1000).exceeded).toBe(false);
	});

	it("AC-1: bare /goal with nothing to derive from refuses instead of creating an inert goal", async () => {
		const cwd = fixtureCwd();
		const registry = createCommandRegistry();
		registerGoalCommands(registry, { cwd, config: goalConfig(cwd), costSoFar: () => 0 });

		const bare = await registry.dispatch("/goal", { cwd });
		expect(bare.ok).toBe(false);
		expect(bare.text).toContain("usage: /goal");
		expect(existsSync(goalStatePath(cwd))).toBe(false);

		// A malformed bound is an error, never a silent default: the goal keeps the
		// bound the user wrote or it is not created at all.
		const bad = await registry.dispatch("/goal ship it --max-turns 0", { cwd });
		expect(bad.ok).toBe(false);
		expect(bad.text).toContain("--max-turns must be a positive number");
		expect(createGoalStore(cwd).load()).toBeNull();
	});

	it("AC-1: bare /goal with a goal running shows it and writes nothing", async () => {
		const cwd = fixtureCwd();
		const registry = createCommandRegistry();
		registerGoalCommands(registry, { cwd, config: goalConfig(cwd), prd: () => null, costSoFar: () => 0 });

		await registry.dispatch("/goal ship the parser fix --max-turns 5", { cwd });
		const before = readFileSync(goalStatePath(cwd), "utf8");

		const shown = await registry.dispatch("/goal", { cwd });
		expect(shown.ok).toBe(true);
		expect(shown.text).toContain("ship the parser fix");
		expect(shown.text).toContain("turns 0/5");
		// Inspecting a goal must not restart it: a re-derived record would reset
		// `started_at`, `turns_used` and the bounds the user chose.
		expect(readFileSync(goalStatePath(cwd), "utf8")).toBe(before);
	});

	it("AC-1: /goal stop deactivates the record and refuses when nothing is running", async () => {
		const cwd = fixtureCwd();
		const registry = createCommandRegistry();
		registerGoalCommands(registry, { cwd, config: goalConfig(cwd), costSoFar: () => 0 });

		const idle = await registry.dispatch("/goal stop", { cwd });
		expect(idle.ok).toBe(false);

		await registry.dispatch("/goal ship the parser fix", { cwd });
		const stopped = await registry.dispatch("/goal stop", { cwd });
		expect(stopped.ok).toBe(true);
		expect(stopped.text).toContain("USER_STOPPED");
		const record = createGoalStore(cwd).load();
		expect(record!.active).toBe(false);
		expect(record!.text).toBe("ship the parser fix");
		expect(record!.turns_used).toBe(0);
	});

	it("a goal set in another session never reaches this session's prompt", async () => {
		const cwd = fixtureCwd();
		const store = createGoalStore(cwd);
		// The reported failure: an `active` record outlives the conversation that
		// set it, so a user opening a fresh session and typing "hi" got a harness
		// pursuing a goal they had forgotten, with nothing on screen saying why.
		store.save(newGoalState("ship the parser fix", { max_turns: 5, max_cost: 2 }, new Date().toISOString(), "session-a"));

		expect(goalTextSource(store, "session-a")()).toBe("ship the parser fix");
		expect(goalTextSource(store, "session-b")()).toBe("");
		// A record written before goals carried a session is stale to every real
		// session, never "everyone's goal".
		store.save({ text: "an old goal", active: true, max_turns: 5, max_cost: 2, started_at: new Date().toISOString(), turns_used: 0 });
		expect(goalTextSource(store, "session-b")()).toBe("");

		// It is reported rather than silently dropped: disappearing would read as data loss.
		const registry = createCommandRegistry();
		registerGoalCommands(registry, { cwd, config: goalConfig(cwd), costSoFar: () => 0, sessionId: "session-b" });
		const shown = await registry.dispatch("/goal", { cwd });
		expect(shown.text).toContain("an old goal");
		expect(shown.text).toContain("earlier session");
	});
});
