/**
 * Phase 4 / AC-4, AC-5, AC-6 — the bounded prompt block, the executor tool and
 * the `todo.needed` site.
 *
 * The prompt comes from PRD-014's real `assemble()`; the block is composed into
 * its VOLATILE layer by `withTodo()`, which is the one line the assembler needs
 * to emit it. The JEV-off cases run a real client against a disabled config, so
 * the decision-log row this spec asserts is the one the client actually wrote.
 */
import { describe, expect, it } from "vitest";
import { createCommandRegistry, type CommandContext } from "../../src/commands/registry.js";
import { assemble, type AssembledPrompt } from "../../src/context/prompt.js";
import type { WorkingState } from "../../src/context/working-state.js";
import { loadConfig } from "../../src/core/config.js";
import type { LeanPiConfig } from "../../src/core/types.js";
import { createJevClient } from "../../src/jev/client.js";
import { readDecisions } from "../../src/jev/log.js";
import { registerTodoCommands } from "../../src/todo/commands.js";
import { decideTodoNeeded, TODO_NEEDED_SITE_ID } from "../../src/todo/goal.js";
import { admitTodoAdd, invokeTodoAdd, renderTodo, TODO_ADD_TOOL, todoPromptBudgetBytes, withTodo } from "../../src/todo/render.js";
import { createTodoList, type TodoCarrier, type TodoItem, type TodoStatus } from "../../src/todo/state.js";
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

function jevDisabledConfig(cwd: string): LeanPiConfig {
	return loadConfig(cwd, { models: {}, jev: { apiKey: null, endpoint: "", model: "jev-latest", mode: "disabled" } });
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

describe("the todo.needed site and JEV-off operation (AC-5)", () => {
	it("forms a list for a MEDIUM task through the fallback and logs fallback_used", async () => {
		const cwd = tempDir("leanpi-todo-jev-");
		const client = createJevClient({ config: jevDisabledConfig(cwd), cwd });

		const decision = await decideTodoNeeded({ request: "refactor the cache lane", complexity: "MEDIUM", prdActive: false }, client);
		expect(decision.needed).toBe(true);
		expect(decision.fallbackUsed).toBe(true);
		expect(readDecisions(cwd).find((row) => row.siteId === TODO_NEEDED_SITE_ID)?.fallbackUsed).toBe(true);
		expect(admitTodoAdd({ request: "refactor the cache lane", complexity: "MEDIUM", prdActive: false }).admitted).toBe(true);

		// The list that formed still drives the boundary to AC-3's outcomes.
		const state: TodoCarrier = {};
		const list = createTodoList(state);
		list.add("first step");
		list.add("second step");
		expect(list.remainingWork().actionable.map((item) => item.id)).toEqual(["a", "b"]);
		await list.complete("a");
		await list.complete("b");
		expect(list.remainingWork()).toEqual({ actionable: [], blocked: [] });
		const blockedState: TodoCarrier = {};
		const blockedList = createTodoList(blockedState);
		blockedList.add("third step");
		blockedList.block("a", "waiting on review");
		expect(blockedList.remainingWork().blocked.map((item) => item.blockedReason)).toEqual(["waiting on review"]);
	});

	it("forms no list for a LOW task with no PRD, and admits no tool", async () => {
		const cwd = tempDir("leanpi-todo-jev-low-");
		const client = createJevClient({ config: jevDisabledConfig(cwd), cwd });

		const decision = await decideTodoNeeded({ request: "fix the header typo", complexity: "LOW", prdActive: false }, client);
		expect(decision.needed).toBe(false);
		expect(decision.fallbackUsed).toBe(true);

		const admission = admitTodoAdd({ request: "fix the header typo", complexity: "LOW", prdActive: false });
		expect(admission.admitted).toBe(false);
		expect(admission.tools).toEqual([]);
		expect(admission.refusal?.message).toContain("todo_add");

		const state: TodoCarrier = {};
		const list = createTodoList(state);
		const call = invokeTodoAdd({ admission, list, text: "a step the user never asked for" });
		expect(call.ok).toBe(false);
		expect(state.todo).toEqual([]);

		const prompt = assembled([]);
		expect(prompt.text).not.toContain("todo (");
	});
});

describe("the executor's todo_add tool (AC-6)", () => {
	it("appends through an admitted call and the item reaches /todo and the prompt", async () => {
		const admission = admitTodoAdd({ request: "port the cache lane in three steps", complexity: "HIGH", prdActive: false });
		expect(admission.admitted).toBe(true);
		expect(admission.tools.map((tool) => tool.name)).toEqual(["todo_add"]);
		expect(TODO_ADD_TOOL.parameters).toMatchObject({ required: ["text"] });

		const cwd = tempDir("leanpi-todo-tool-");
		const state: TodoCarrier = {};
		const registry = createCommandRegistry();
		registerTodoCommands(registry, { cwd, state });

		const added = invokeTodoAdd({ admission, list: createTodoList(state), text: "port the cache lane" });
		expect(added.ok).toBe(true);
		const context: CommandContext = { cwd };
		expect((await registry.dispatch("/todo", context)).text).toContain("port the cache lane");
		expect(assembled(state.todo!).text).toContain("port the cache lane");
	});

	it("refuses an unadmitted call instead of inventing a list", () => {
		const admission = admitTodoAdd({ request: "rename one symbol", complexity: "LOW", prdActive: false });
		const state: TodoCarrier = {};
		const list = createTodoList(state);

		const refused = invokeTodoAdd({ admission, list, text: "rename the symbol" });
		expect(refused.ok).toBe(false);
		expect(refused.text).toContain("not admitted");
		expect(admission.tools).toEqual([]);
		expect(state.todo).toEqual([]);
		expect(admission.refusal?.code).toBe("not_warranted");
	});
});
