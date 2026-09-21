/**
 * The standing todo widget: one row per item, cleared when there is no list,
 * and never taller than Pi's ten-line widget cap.
 */
import { describe, expect, it } from "vitest";
import { todoWidget } from "../../src/cli/todo-widget.js";
import type { TodoItem, TodoStatus } from "../../src/todo/state.js";

const item = (id: string, status: TodoStatus, text = `step ${id}`): TodoItem => ({ id, text, status });

/** The escapes are the widget's own colouring; assertions read the text through this. */
const plain = (lines: string[]): string[] => lines.map((line) => line.replace(/\[[0-9;]*m/g, ""));

describe("todoWidget", () => {
	it("clears the slot when nothing is on the list", () => {
		expect(todoWidget([])).toBeUndefined();
		expect(todoWidget([item("a", "dropped")])).toBeUndefined();
	});

	it("renders one line per item, marked by status", () => {
		const lines = todoWidget([item("a", "done"), item("b", "in_progress"), item("c", "pending"), { ...item("d", "blocked"), blockedReason: "no key" }]);
		expect(plain(lines as string[])).toEqual(["✔ step a", "▸ step b", "○ step c", "✖ step d (no key)"]);
	});

	it("clips an item to the width rather than wrapping to a second row", () => {
		const [line] = plain(todoWidget([item("a", "pending", "x".repeat(200))], 20) as string[]);
		expect(line).toHaveLength(20);
		expect(line?.endsWith("…")).toBe(true);
	});

	it("drops done items first and collapses the rest when the list exceeds the cap", () => {
		const items = [...Array.from({ length: 5 }, (_, index) => item(`d${index}`, "done")), ...Array.from({ length: 11 }, (_, index) => item(`p${index}`, "pending"))];
		const lines = plain(todoWidget(items) as string[]);
		expect(lines).toHaveLength(10);
		expect(lines.some((line) => line.startsWith("✔"))).toBe(false);
		// 16 items, 9 rendered: the 5 done and the 2 pending that did not fit.
		expect(lines.at(-1)).toBe("  +7 more");
	});
});
