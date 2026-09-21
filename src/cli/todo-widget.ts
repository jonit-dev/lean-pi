/**
 * The todo list as a standing widget above the editor.
 *
 * `/todo` printed the list once and it scrolled away; the block the prompt
 * carries is for the model, not the user. Pi's `setWidget` is the one surface
 * that stays on screen between turns, so a session with a list always shows it:
 * one line per item, in list order, clipped to the terminal width rather than
 * allowed to take two rows.
 *
 * Pi caps a widget at ten lines, so a longer list drops its `done` items first
 * (finished work is the least useful thing on screen) and collapses whatever
 * still does not fit into a `+N more` tail.
 */
import type { TodoItem, TodoStatus } from "../todo/state.js";

/**
 * What the refresh needs from a Pi context: the widget slot, nothing else. It is
 * optional because not every UI context implements it — a print-mode or stubbed
 * context has no editor to sit above, and the list is not worth a crash there.
 */
export interface TodoWidgetHost {
	ui: { setWidget?: (key: string, content: string[] | undefined) => void };
}

/** The widget slot LeanPi owns; replaced on every change, cleared when the list empties. */
export const LEANPI_TODO_WIDGET_KEY = "leanpi-todo";

/** Pi's `InteractiveMode.MAX_WIDGET_LINES`; exceeding it gets a "widget truncated" row instead. */
const MAX_LINES = 10;

const RESET = "[0m";
const BOLD = "[1m";
const DIM = "[2m";
const MUTED = "[38;5;244m";
const BLOCKED = "[38;5;203m";

const MARK: Record<TodoStatus, string> = { pending: "○", in_progress: "▸", done: "✔", blocked: "✖", dropped: "" };

function paint(item: TodoItem, text: string): string {
	if (item.status === "in_progress") return `${BOLD}${text}${RESET}`;
	if (item.status === "done") return `${DIM}${text}${RESET}`;
	if (item.status === "blocked") return `${BLOCKED}${text}${RESET}`;
	return text;
}

function line(item: TodoItem, width: number): string {
	const reason = item.status === "blocked" ? ` (${item.blockedReason ?? "unspecified"})` : "";
	const text = `${MARK[item.status]} ${item.text}${reason}`;
	return paint(item, text.length <= width ? text : `${text.slice(0, width - 1)}…`);
}

/**
 * The lines for the current list, or `undefined` when there is nothing to show —
 * which is what clears the slot, so a session without a list pays no rows.
 */
export function todoWidget(items: readonly TodoItem[], width = 80): string[] | undefined {
	const visible = items.filter((item) => item.status !== "dropped");
	if (visible.length === 0) return undefined;
	// Only when the whole list does not fit: `done` items leave, so the open work stays.
	const kept = visible.length <= MAX_LINES ? visible : visible.filter((item) => item.status !== "done");
	const room = kept.length <= MAX_LINES ? MAX_LINES : MAX_LINES - 1;
	const lines = kept.slice(0, room).map((item) => line(item, width));
	const hidden = visible.length - lines.length;
	if (hidden > 0) lines.push(`${MUTED}  +${hidden} more${RESET}`);
	return lines;
}
