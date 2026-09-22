/**
 * The todo list as a standing widget above the editor.
 *
 * `/todo` printed the list once and it scrolled away; the block the prompt
 * carries is for the model, not the user. Pi's `setWidget` is the one surface
 * that stays on screen between turns, so a session with a list always shows it:
 * a progress header, then one line per item clipped to the terminal width
 * rather than allowed to take two rows.
 *
 * Rows are ordered by status — active, blocked, pending, done — not by
 * insertion, so the work in flight is the first thing read and finished work
 * sinks. Pi caps a widget at ten lines, so the same order decides what goes
 * when the list is longer: `done` falls off the end first, and whatever still
 * does not fit collapses into a `+N more` tail.
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

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const MUTED = "\x1b[38;5;244m";
const ACTIVE = "\x1b[38;5;179m";
const BLOCKED = "\x1b[38;5;203m";

/** One space between the widget frame and the marker column, on every row including the tail. */
const GUTTER = " ";

const MARK: Record<TodoStatus, string> = { pending: "○", in_progress: "▸", done: "✔", blocked: "✖", dropped: "" };

/** Read order, and — since the tail is sliced off — the drop order when the list is too long. */
const RANK: Record<TodoStatus, number> = { in_progress: 0, blocked: 1, pending: 2, done: 3, dropped: 4 };

function paint(item: TodoItem, text: string): string {
	if (item.status === "in_progress") return `${BOLD}${ACTIVE}${text}${RESET}`;
	if (item.status === "done") return `${DIM}${text}${RESET}`;
	if (item.status === "blocked") return `${BLOCKED}${text}${RESET}`;
	return `${MUTED}${text}${RESET}`;
}

/** The gutter plus as much of the row as fits; a clipped row is still one row. */
function fit(text: string, width: number): string {
	const room = width - GUTTER.length;
	return GUTTER + (text.length <= room ? text : `${text.slice(0, room - 1)}…`);
}

function line(item: TodoItem, width: number): string {
	const reason = item.status === "blocked" ? ` (${item.blockedReason ?? "unspecified"})` : "";
	return paint(item, fit(`${MARK[item.status]} ${item.text}${reason}`, width));
}

/** Eight cells of done-versus-total: the one line that says whether the session is moving. */
function header(items: readonly TodoItem[], width: number): string {
	const done = items.filter((item) => item.status === "done").length;
	const filled = Math.round((done / items.length) * 8);
	const blocked = items.filter((item) => item.status === "blocked").length;
	const suffix = blocked > 0 ? ` · ${blocked} blocked` : "";
	return `${MUTED}${fit(`todo ${"█".repeat(filled)}${"░".repeat(8 - filled)} ${done}/${items.length}${suffix}`, width)}${RESET}`;
}

/**
 * The lines for the current list, or `undefined` when there is nothing to show —
 * which is what clears the slot, so a session without a list pays no rows.
 */
export function todoWidget(items: readonly TodoItem[], width = 80): string[] | undefined {
	const visible = items.filter((item) => item.status !== "dropped");
	if (visible.length === 0) return undefined;
	const ordered = [...visible].sort((left, right) => RANK[left.status] - RANK[right.status]);
	const room = MAX_LINES - 1;
	const rows = ordered.slice(0, ordered.length <= room ? room : room - 1);
	const lines = [header(visible, width), ...rows.map((item) => line(item, width))];
	const hidden = visible.length - rows.length;
	if (hidden > 0) lines.push(`${MUTED}${GUTTER}… +${hidden} more${RESET}`);
	return lines;
}
