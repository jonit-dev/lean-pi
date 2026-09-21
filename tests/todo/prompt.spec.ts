/**
 * Phase 4 / AC-4, AC-6 — the bounded prompt block and the executor tool.
 *
 * The prompt comes from PRD-014's real `assemble()`; the block is composed into
 * its VOLATILE layer by `withTodo()`, which is the one line the assembler needs
 * to emit it. The tool cases drive the registered `todo_add` definition, which
 * is the surface the executor actually calls.
 */
import { describe, expect, it } from "vitest";
import { createCommandRegistry, type CommandContext } from "../../src/commands/registry.js";
import { assemble, type AssembledPrompt } from "../../src/context/prompt.js";
import type { WorkingState } from "../../src/context/working-state.js";
import type { LeanPiConfig } from "../../src/core/types.js";
import { registerTodoCommands } from "../../src/todo/commands.js";
import { invokeTodoAdd, renderTodo, TODO_ADD_TOOL, todoPromptBudgetBytes, withTodo } from "../../src/todo/render.js";
import { createTodoList, type TodoCarrier, type TodoItem, type TodoStatus } from "../../src/todo/state.js";
import { todoToolDefinition } from "../../src/todo/tool.js";
import { tempDir } from "../helpers/fixtures.js";

const PROMPT_CONFIG: Pick<LeanPiConfig, "instructions"> = { instructions: { ponytail: false } };

const DONE_REASON = "PENDING-TAIL-MARKER";

/** AC-4's fixture: 7 done, 1 in_progress, 12 pending, 2 blocked. */
function oversizeList(): TodoItem[] {
	const items: TodoItem[] = [];
	const add = (status: TodoStatus, id: string, text: string, blockedReason?: string) => {
		items.push({ id, text, status, ...(blockedReason === undefined ? {} : { blockedReason }) });
	};
	for (let index = 0; index < 7; index += 1) add("done", `d${index}`, `clipped-done-${index} ${"shipped surface ".repeat(4)}`);
	add("in_progress", "active", "implement syncFromPrd over PRD-012 units");
	for (let index = 0; index < 12; index += 1) add("pending", `p${index}`, `pending ${index} ${DONE_REASON} ${"collapse completed items into a count ".repeat(6)}`);
	add("blocked", "b1", "wire boundary predicate", "PRD-013 boundary hook not landed");
	add("blocked", "b2", "record the decision log row", "JEV endpoint unreachable");
	return items;
}

function workingStateWith(todo: TodoItem[]): WorkingState & TodoCarrier {
	return { goal: "drain the list", acceptance: [], files_touched: [], current_failure: null, verification: {}, attempts: 0, unresolved: [], todo };
}

function assembled(todo: TodoItem[], budget?: number): AssembledPrompt {
	const workingState = workingStateWith(todo);
	return withTodo(assemble({ config: PROMPT_CONFIG, workingState }), todo, budget);
}

describe("the bounded prompt block (AC-4)", () => {
	it("stays within the budget while keeping what the next turn needs", () => {
		const items = oversizeList();
		const block = renderTodo(items, todoPromptBudgetBytes(undefined));
		expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(2048);

		expect(block).toContain("done 7");
		expect(block).not.toContain("clipped-done-0");
		expect(block).toContain("implement syncFromPrd over PRD-012 units");
		expect(block).toContain("[in_progress]");
		expect(block).toContain("blocked: PRD-013 boundary hook not landed");
		expect(block).toContain("blocked: JEV endpoint unreachable");
		expect(block).toMatch(/\+\d+ more pending/);
		expect(block).not.toContain("dropped");
	});

	it("reaches the assembled prompt and is byte-identical across assemblies", () => {
		const items = oversizeList();
		const first = assembled(items);
		const second = assembled(items);
		expect(first.text).toContain(renderTodo(items));
		expect(first.layers.volatile).toContain("todo (22 items · done 7)");
		expect(first.text).not.toContain("clipped-done-3");
		expect(first.bytes).toBe(Buffer.byteLength(first.text, "utf8"));
		expect(second.text).toBe(first.text);
	});

	it("contributes no bytes at all to a prompt with no list", () => {
		const bare = assemble({ config: PROMPT_CONFIG, workingState: workingStateWith([]) });
		expect(bare.text).not.toContain("todo (");
		expect(withTodo(bare, [])).toBe(bare);
	});
});

describe("the executor's todo_add tool (AC-6)", () => {
	it("appends whatever the executor calls it with, and the item reaches /todo and the prompt", async () => {
		expect(TODO_ADD_TOOL.parameters).toMatchObject({ required: ["text"] });

		const cwd = tempDir("leanpi-todo-tool-");
		const state: TodoCarrier = {};
		const registry = createCommandRegistry();
		registerTodoCommands(registry, { cwd, state });

		// The tool the executor calls, with no per-turn decision to consult: a
		// HIGH-complexity turn and a LOW one are admitted identically.
		const tool = todoToolDefinition({ state });
		const added = await tool.execute("call-1", { text: "port the cache lane", phase: "cache" }, undefined, undefined, undefined as never);
		expect(added.isError).toBeFalsy();

		const context: CommandContext = { cwd };
		expect((await registry.dispatch("/todo", context)).text).toContain("port the cache lane");
		expect(assembled(state.todo!).text).toContain("port the cache lane");
		expect(state.todo).toHaveLength(1);
	});

	it("refuses an empty step instead of appending a blank item", () => {
		const state: TodoCarrier = {};
		const refused = invokeTodoAdd({ list: createTodoList(state), text: "   " });
		expect(refused.ok).toBe(false);
		expect(state.todo).toEqual([]);
	});
});
