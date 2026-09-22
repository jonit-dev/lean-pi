/**
 * The recap line as a one-line widget above the editor (PRD-036 Phase 2).
 *
 * Deliberately collapsed: the expanded form the original sketch asked for is
 * already on screen as `renderTurnOutcome`'s notify, printed directly above
 * with changed files, evidence and commands. Duplicating it into a second
 * expandable block would be the same facts twice.
 *
 * Mirrors `todo-widget.ts`: one line, clipped to the terminal width so it is one
 * row and not two, dim so it never competes with the turn's own report.
 */

/**
 * What the refresh needs from a Pi context: the widget slot, nothing else. It is
 * optional because not every UI context implements it — a print-mode or stubbed
 * context has no editor to sit above, and a recap is not worth a crash there.
 */
export interface RecapWidgetHost {
	ui: { setWidget?: (key: string, content: string[] | undefined) => void };
}

/** The widget slot LeanPi owns; replaced on every recap, cleared on the next turn. */
export const LEANPI_RECAP_WIDGET_KEY = "leanpi-recap";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

/** The one line for a recap, or `undefined` — which is what clears the slot. */
export function recapWidget(recap: string | undefined, width = 80): string[] | undefined {
	const text = `※ recap: ${(recap ?? "").trim()}`;
	if (text.length === "※ recap: ".length) return undefined;
	const room = Math.max(1, width - 1);
	return [`${DIM} ${text.length <= room ? text : `${text.slice(0, room - 1)}…`}${RESET}`];
}
