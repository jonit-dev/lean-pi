/**
 * The fixed-shape brief a recap is generated from (PRD-036 Phase 1).
 *
 * Not the transcript. Four slots, each hard-capped, assembled from state the
 * session already holds: the goal the user set, what this turn asked, what the
 * turn did, and what the todo list still has open. A long session and a short
 * one cost the same, which is the whole point — upstream's recap serializes the
 * entire active context on every trigger, the most expensive thing in the room.
 *
 * The format instruction heads the brief rather than the slots, so a slot's
 * ceiling is the slot's alone and nothing appended after it can be mistaken for
 * its content.
 */

/** The ceiling on each slot, in characters. */
export const RECAP_CAPS = {
	goal: 400,
	ask: 400,
	did: 1_200,
	openWork: 300,
} as const;

/** The headings the slots are joined under; a slot with nothing to say is omitted. */
export const RECAP_HEADINGS = {
	goal: "SESSION GOAL:",
	ask: "THIS TURN:",
	did: "WHAT THE TURN DID:",
	openWork: "OPEN WORK:",
} as const;

export interface RecapInput {
	/** The session's goal: its first user message. */
	goal?: string;
	/** This turn's ask: the user message that started it. */
	ask?: string;
	/** What the turn did: `renderTurnOutcome` output, or the last assistant text. */
	did?: string;
	/** Titles of the todo items still open. */
	openWork?: readonly string[];
	/** Whether to ask the model for a session title too. */
	wantTitle?: boolean;
}

/** One line: whitespace flattened, then clipped to the cap with an ellipsis. */
function clip(text: string | undefined, cap: number): string {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	if (flat.length === 0) return "";
	return flat.length <= cap ? flat : `${flat.slice(0, cap - 1)}…`;
}

/** The two-line answer the recap call must produce. */
export function recapInstruction(wantTitle: boolean): string {
	return [
		"Reply with exactly the lines below and nothing else:",
		"RECAP: <one sentence covering the goal, the current state and the next action; under 240 characters>",
		...(wantTitle ? ["TITLE: <3-6 words naming the whole session>"] : []),
	].join("\n");
}

/** The brief: the format instruction, then each present slot under its heading. */
export function buildRecapBrief(input: RecapInput): string {
	const sections = [recapInstruction(input.wantTitle !== false)];
	const slot = (heading: string, value: string | undefined, cap: number): void => {
		const text = clip(value, cap);
		if (text.length > 0) sections.push(`${heading} ${text}`);
	};
	slot(RECAP_HEADINGS.goal, input.goal, RECAP_CAPS.goal);
	slot(RECAP_HEADINGS.ask, input.ask, RECAP_CAPS.ask);
	slot(RECAP_HEADINGS.did, input.did, RECAP_CAPS.did);
	slot(RECAP_HEADINGS.openWork, input.openWork?.filter((title) => title.trim().length > 0).join("; "), RECAP_CAPS.openWork);
	return sections.join("\n");
}
