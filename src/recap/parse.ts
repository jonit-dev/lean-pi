/**
 * The model's two-line recap answer, read positionally (PRD-036 Phase 1).
 *
 * A missing or malformed line is dropped, never retried: a recap that cannot be
 * parsed is not worth a second call, and the previous one stays on screen. The
 * parser is total — garbage in, `undefined` out, never a throw — because it runs
 * on whatever a small model happened to emit.
 */

/** The recap sentence's ceiling, in characters. */
export const RECAP_MAX_CHARS = 240;

/** The session title's ceiling, in characters. */
export const TITLE_MAX_CHARS = 60;

export interface RecapResponse {
	recap: string;
	/** Absent when no usable `TITLE:` line was emitted, or when none was requested. */
	title?: string;
}

/** The value after a `LABEL:` at the start of a line, or `undefined` when empty. */
function lineValue(text: string, label: string): string | undefined {
	const match = new RegExp(`^\\s*${label}:\\s*(.*)$`, "im").exec(text);
	const value = match?.[1]?.trim() ?? "";
	return value.length === 0 ? undefined : value;
}

/** ANSI escapes and control characters out, markdown markers out, whitespace flattened. */
function sanitize(text: string): string {
	return text
		// The escape byte is the point: a small model emits terminal colours, and
		// they must not reach the widget's own ANSI-styled line.
		// oxlint-disable-next-line no-control-regex
		.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
		// oxlint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/[*_`#>~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** The parsed answer, or `undefined` when there is no usable `RECAP:` line. */
export function parseRecapResponse(text: string): RecapResponse | undefined {
	const recapLine = lineValue(text, "RECAP");
	if (recapLine === undefined) return undefined;
	const recap = sanitize(recapLine).slice(0, RECAP_MAX_CHARS);
	if (recap.length === 0) return undefined;
	const titleLine = lineValue(text, "TITLE");
	const title = titleLine === undefined ? "" : sanitize(titleLine).slice(0, TITLE_MAX_CHARS);
	return { recap, ...(title.length > 0 ? { title } : {}) };
}
