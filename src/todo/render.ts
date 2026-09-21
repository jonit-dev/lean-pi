/**
 * The bounded prompt block and the executor-facing tool (PRD-025 Phase 4, ROADMAP §22).
 *
 * The list reaches the prompt as one compact block in PRD-014's VOLATILE layer,
 * hard-capped at `todo.promptBudgetBytes` (default 2048). It is structured state,
 * never a transcript: `done` items collapse to a count, `dropped` items are
 * omitted, and only the active, blocked and pending items are enumerated. On
 * overflow the pending tail collapses to `+N more pending`, so the ceiling is met
 * by dropping the least useful lines rather than by truncating mid-record. The
 * render is a pure function of the list — same list, same bytes — so it does not
 * defeat the prefix caching §22 buys.
 */
import type { AssembledPrompt } from "../context/prompt.js";
import type { TodoItem, TodoList } from "./state.js";

export const TODO_PROMPT_BUDGET_BYTES = 2048;

/** A single item's text never spends the whole budget; longer text is clipped, not dropped. */
const TEXT_LIMIT = 200;

/** Extra config read structurally, so an absent key is a documented default rather than a crash. */
export interface TodoConfigLike {
	todo?: { promptBudgetBytes?: number };
}

export function todoPromptBudgetBytes(config?: unknown): number {
	const configured = (config as TodoConfigLike | undefined)?.todo?.promptBudgetBytes;
	return typeof configured === "number" && Number.isFinite(configured) && configured > 0 ? configured : TODO_PROMPT_BUDGET_BYTES;
}

function clip(text: string): string {
	return text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT - 1)}…`;
}

function line(item: TodoItem, marker: string, suffix = ""): string {
	return `  ${marker} ${clip(item.text)}${item.criterion === undefined ? "" : `  ${item.criterion}`}${suffix}`;
}

/**
 * The block, in fixed order: header, the active item, every blocked item with its
 * reason, then as many pending items as fit. An empty list renders nothing — a
 * quick path pays no bytes at all.
 */
export function renderTodo(list: readonly TodoItem[], budgetBytes: number = TODO_PROMPT_BUDGET_BYTES): string {
	const items = list.filter((item) => item.status !== "dropped");
	if (items.length === 0) return "";

	const done = items.filter((item) => item.status === "done").length;
	const pending = items.filter((item) => item.status === "pending");
	const lines = [`todo (${items.length} items · done ${done})`];

	const active = items.find((item) => item.status === "in_progress");
	if (active) lines.push(line(active, ">", "  [in_progress]"));
	for (const item of items.filter((entry) => entry.status === "blocked")) {
		lines.push(line(item, "!", `  blocked: ${item.blockedReason ?? "unspecified"}`));
	}

	const marker = (count: number) => `  +${count} more pending`;
	let used = Buffer.byteLength(lines.join("\n"), "utf8");
	let kept = 0;
	for (const item of pending) {
		const next = `\n${line(item, "-")}`;
		const omitted = pending.length - kept - 1;
		const tail = omitted > 0 ? Buffer.byteLength(`\n${marker(omitted)}`, "utf8") : 0;
		if (used + Buffer.byteLength(next, "utf8") + tail > budgetBytes) break;
		lines.push(line(item, "-"));
		used += Buffer.byteLength(next, "utf8");
		kept += 1;
	}
	const omitted = pending.length - kept;
	if (omitted > 0) lines.push(marker(omitted));
	return lines.join("\n");
}

/**
 * The block PRD-014's `assemble()` emits in its VOLATILE layer. Composing it here
 * keeps the assembler free of list knowledge and keeps the result byte-identical
 * for an unchanged list.
 */
export function withTodo(prompt: AssembledPrompt, list: readonly TodoItem[], budgetBytes?: number): AssembledPrompt {
	const block = renderTodo(list, budgetBytes);
	if (block.length === 0) return prompt;
	const volatile = [prompt.layers.volatile, block].filter((entry) => entry.length > 0).join("\n\n");
	const text = [prompt.cacheablePrefix, volatile].filter((entry) => entry.length > 0).join("\n\n");
	return { ...prompt, layers: { ...prompt.layers, volatile }, text, bytes: Buffer.byteLength(text, "utf8") };
}

export const TODO_ADD_TOOL_NAME = "todo_add";

export interface TodoAddTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export const TODO_ADD_TOOL: TodoAddTool = {
	name: TODO_ADD_TOOL_NAME,
	description: "Append one step to the session's todo list; it appears in /todo and in the next turn's prompt.",
	parameters: {
		type: "object",
		properties: {
			text: { type: "string", description: "one line describing the step" },
			phase: { type: "string", description: "optional flat grouping label" },
		},
		required: ["text"],
		additionalProperties: false,
	},
};

export interface TodoAddCall {
	list: TodoList;
	text: string;
	phase?: string;
}

/** One appended item. Whether the task warrants a list is the executor's call, not a gate's. */
export function invokeTodoAdd(call: TodoAddCall): { ok: boolean; text: string } {
	const text = call.text.trim();
	if (text.length === 0) return { ok: false, text: "todo_add needs text" };
	const item = call.list.add(text, call.phase === undefined ? {} : { phase: call.phase });
	return { ok: true, text: `added ${item.id}: ${item.text}` };
}
