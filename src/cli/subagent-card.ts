/**
 * The subagent card under the compact UI (PRD-052).
 *
 * `pi-claude-code-ui` renders every tool it has no row for through one generic
 * path: the humanized tool name is the label, and the summary falls back to the
 * same humanized name, so the `subagent` row read `Subagent Subagent` and never
 * named the child. Upstream's own `renderCall` on the tool is not consulted for
 * it, so the row is taken over here instead of forking the package.
 *
 * A `renderCall` override on the prototype is the seam the package itself already
 * patches (`getCallRenderer`, at load), so this sits above that patch and takes
 * `subagent` alone. Every other tool, and any card whose call was never recorded
 * (a resumed transcript, a workflow call), renders exactly as before.
 *
 * The prototype arrives as an argument, from `extensions/subagent-card/index.ts`: Pi
 * loads that entry as TypeScript, so its `@earendil-works/*` imports resolve to the
 * very classes the compact UI patched, while this module and the card's facts stay
 * the one compiled copy the rest of LeanPi uses. See `cli/spinner.ts` for the same
 * trap.
 */
import { subagentCardDetail } from "../subagents/card.js";

/** The compact UI's own flag on the prototype: the row being taken over. */
const COMPACT_UI_ROW = Symbol.for("pi-claude-style-tools:patched-tool-execution");

/** Ours, so a second `session_start` does not wrap the wrapper. */
const INSTALLED = Symbol.for("leanpi:subagent-card");

/** What the package's generic row labels this tool with, and summarises it with. */
const DUPLICATE_TITLE = "Subagent";

type Row = (args: unknown, theme: Theme, context: { toolCallId: string }) => unknown;

interface Theme {
	fg(key: string, text: string): string;
	bold(text: string): string;
}

/**
 * The card the package drew. It keeps the line it was set private to it, so this
 * reads that one field and hands the line back through the public setter; a card
 * that does not answer is left exactly as the package drew it.
 */
interface Card {
	value?: unknown;
	setText(line: string): void;
}

/**
 * Name the child on the card: `Subagent Bravo: Opus 5.5 (High)`, the child's own
 * name when the call gave one, and the harness's when the child is an external
 * runner with no Pi model to name.
 */
export function installSubagentCard(prototype: object): boolean {
	const proto = prototype as Record<string | symbol, unknown>;
	// Nothing to take over without the compact UI: under `--ui plain` the tool's own
	// `renderCall` draws the card, and that one already names the agent.
	if (proto[COMPACT_UI_ROW] !== true || proto[INSTALLED] === true) return false;
	const inner = proto.getCallRenderer;
	if (typeof inner !== "function") return false;
	proto.getCallRenderer = function patchedGetCallRenderer(this: { toolName?: unknown }, ...rest: unknown[]): unknown {
		const row = (inner as (...args: unknown[]) => unknown).apply(this, rest);
		if (this.toolName !== "subagent" || typeof row !== "function") return row;
		return (args: unknown, theme: Theme, context: { toolCallId: string }): unknown => {
			// The package draws the row — the live status dot, the pending breathe and
			// the live line count are all its state, and re-drawing the line here is
			// what dropped the dot. Only the summary is ours: it falls back to the tool
			// name, which is the label one line above it.
			const card = (row as Row)(args, theme, context) as Card | null;
			const detail = subagentCardDetail(context.toolCallId);
			if (detail === undefined || card === null || typeof card.value !== "string") return card;
			const duplicate = theme.fg("accent", DUPLICATE_TITLE);
			const at = card.value.lastIndexOf(duplicate);
			if (at === -1) return card;
			card.setText(card.value.slice(0, at) + theme.fg("accent", detail) + card.value.slice(at + duplicate.length));
			return card;
		};
	};
	proto[INSTALLED] = true;
	return true;
}
