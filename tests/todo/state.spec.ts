/**
 * Phase 1 / AC-1 — the list, its transitions and `/todo`.
 *
 * One real registry drives the AC-1 command sequence over one session record;
 * the assertions cover the three distinct risks the PRD names: promotion that
 * picks a blocked item, two items active at once, and a list that exists only in
 * memory.
 */
import { describe, expect, it } from "vitest";
import { createCommandRegistry, type CommandContext, type CommandRegistry, type CommandResult } from "../../src/commands/registry.js";
import { registerTodoCommands } from "../../src/todo/commands.js";
import { createTodoList, type TodoCarrier, type TodoItem } from "../../src/todo/state.js";

const context: CommandContext = { cwd: "/tmp/leanpi-todo-state" };

interface Session {
	state: TodoCarrier;
	registry: CommandRegistry;
	run(line: string): Promise<CommandResult>;
	items(): readonly TodoItem[];
}

function session(cwd = "/tmp/leanpi-todo-state"): Session {
	const state: TodoCarrier = {};
	const registry = createCommandRegistry();
	registerTodoCommands(registry, { cwd, state });
	return {
		state,
		registry,
		run: (line) => registry.dispatch(line, { ...context, cwd }),
		items: () => state.todo ?? [],
	};
}

describe("todo state and /todo (AC-1)", () => {
	it("promotes exactly the next pending item, skipping the blocked one", async () => {
		const live = session();
		expect((await live.run("/todo add a")).ok).toBe(true);
		expect((await live.run("/todo add b")).ok).toBe(true);
		expect((await live.run("/todo add c")).ok).toBe(true);
		expect((await live.run("/todo start a")).ok).toBe(true);
		expect((await live.run("/todo block b waiting on review")).ok).toBe(true);
		expect((await live.run("/todo done a")).ok).toBe(true);

		const listing = (await live.run("/todo")).text;
		expect(listing).toContain("a: done");
		expect(listing).toContain("b: blocked (waiting on review)");
		expect(listing).toContain("c: in_progress");
		expect(live.items().filter((item) => item.status === "in_progress").map((item) => item.id)).toEqual(["c"]);
	});

	it("refuses a second active item, naming the one that is running", async () => {
		const live = session();
		await live.run("/todo add a");
		await live.run("/todo add b");
		await live.run("/todo start a");

		const second = await live.run("/todo start b");
		expect(second.ok).toBe(false);
		expect(second.text).toContain("a");
		expect(live.items().filter((item) => item.status === "in_progress").map((item) => item.id)).toEqual(["a"]);
	});

	it("returns an unblocked item to pending without displacing the active one", async () => {
		const live = session();
		await live.run("/todo add a");
		await live.run("/todo add b");
		await live.run("/todo add c");
		await live.run("/todo start a");
		await live.run("/todo block b waiting on review");
		await live.run("/todo done a");

		const unblocked = await live.run("/todo unblock b");
		expect(unblocked.ok).toBe(true);
		const items = live.items();
		expect(items.find((item) => item.id === "b")).toMatchObject({ status: "pending" });
		expect(items.find((item) => item.id === "b")?.blockedReason).toBeUndefined();
		expect(items.filter((item) => item.status === "in_progress").map((item) => item.id)).toEqual(["c"]);
	});

	it("round-trips the list through the session record", async () => {
		const live = session();
		await live.run("/todo add a");
		await live.run("/todo add b");
		await live.run("/todo start a");
		await live.run("/todo block b waiting on review");

		// Whatever PRD-014 does with the record (write, resume, fork), the list is
		// on it: a session that reloads the record sees the same list.
		const reloaded: TodoCarrier = { todo: JSON.parse(JSON.stringify(live.state.todo)) as TodoItem[] };
		const registry = createCommandRegistry();
		registerTodoCommands(registry, { cwd: context.cwd, state: reloaded });
		const listing = (await registry.dispatch("/todo", context)).text;
		expect(listing).toContain("a: in_progress");
		expect(listing).toContain("b: blocked (waiting on review)");
		expect(reloaded.todo).toEqual(live.state.todo);
	});

	it("promotes nothing when the tail is blocked, and a drop leaves the order alone", async () => {
		const state: TodoCarrier = {};
		const list = createTodoList(state);
		list.add("a");
		list.add("b");
		list.add("c");
		list.start("a");
		list.block("b", "waiting on review");
		list.drop("c");

		expect(await list.complete("a")).toMatchObject({ ok: true });
		const items = state.todo!;
		expect(items.map((item) => `${item.id}:${item.status}`)).toEqual(["a:done", "b:blocked", "c:dropped"]);
		expect(items.some((item) => item.status === "in_progress")).toBe(false);
	});

	it("clears manual items and keeps derived ones", async () => {
		const state: TodoCarrier = {};
		const list = createTodoList(state);
		list.add("manual");
		list.add("derived text", { criterion: "AC-2" });

		expect(list.clear().ok).toBe(true);
		expect(state.todo?.map((item) => item.criterion)).toEqual(["AC-2"]);
	});
});
