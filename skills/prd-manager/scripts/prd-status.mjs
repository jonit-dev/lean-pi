/**
 * Every status field a PRD carries, rewritten in one place.
 *
 * A PRD records its state in more than one spot — the header `**Status:**`, a header
 * `**Progress:**`, a `**Status:**` inside each phase — and a close that updates only the
 * first leaves a file that reads DONE at the top and NOT STARTED three phases down.
 * These helpers rewrite all of them, insert the header field when a PRD has none
 * (prd-creator's template does not emit one), and report exactly what they changed.
 */
const HEADING = /^#{1,6}\s/u;
const PHASE_HEADING = /^#{3,4}\s+(?:Phase\b|\d+\.\s)/iu;
const FIELD = (name) => new RegExp(`^\\s*(?:[-*]\\s+)?\\*{0,2}${name}\\b[^\\n]*$`, "iu");
const STATUS_FIELD = FIELD("status:?");
const PROGRESS_FIELD = FIELD("progress:?");
const CLOSED_FIELD = FIELD("closed:?");
const OPEN_WORDS = /\b(?:PARTIAL|NOT STARTED|PROPOSED|OPEN|SCOPING|IN PROGRESS|TODO|PENDING|DRAFT|READY FOR EXECUTION)\b/iu;

/** Header fields live above the first `##` section; a `**Status:**` below that belongs to a phase. */
function headerEnd(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0 && /^#{2,6}\s/u.test(lines[i])) return i;
  }
  return lines.length;
}

/** Rewrites a header field in place, or inserts it after the title when absent. */
function setHeaderField(lines, pattern, text, changes, label) {
  const end = headerEnd(lines);
  for (let i = 0; i < end; i += 1) {
    if (!pattern.test(lines[i])) continue;
    if (lines[i] === text) return;
    changes.push(`${label}: rewritten at L${i + 1}`);
    lines[i] = text;
    return;
  }
  // No such field: place it under the title, ahead of the other header fields.
  let insert = 0;
  while (insert < lines.length && !HEADING.test(lines[insert])) insert += 1;
  insert = insert < lines.length ? insert + 1 : 0;
  while (insert < lines.length && lines[insert].trim() === "") insert += 1;
  lines.splice(insert, 0, text, "");
  changes.push(`${label}: inserted at L${insert + 1}`);
}

/** Per-phase `**Status:**` markers still reading as open, under phases that are finished. */
function setPhaseStatuses(lines, replacement, changes) {
  const start = headerEnd(lines);
  let inPhase = false;
  for (let i = start; i < lines.length; i += 1) {
    if (HEADING.test(lines[i])) inPhase = PHASE_HEADING.test(lines[i]);
    if (!inPhase || !STATUS_FIELD.test(lines[i]) || !OPEN_WORDS.test(lines[i])) continue;
    lines[i] = replacement;
    changes.push(`phase status: rewritten at L${i + 1}`);
  }
}

/**
 * Stamps a PRD as done. `openBoxes > 0` only happens under `--force`, and the status
 * says so rather than claiming a verification that did not happen.
 */
export function stampDone(markdown, { date, openBoxes = 0, sha, pr }) {
  const lines = markdown.split("\n");
  const changes = [];
  const verdict =
    openBoxes === 0
      ? `DONE — ${date}. Every phase and acceptance box verified.`
      : `DONE — ${date}, closed with ${openBoxes} item${openBoxes === 1 ? "" : "s"} deliberately left open.`;

  if (lines.slice(0, headerEnd(lines)).some((line) => PROGRESS_FIELD.test(line))) {
    setHeaderField(
      lines,
      PROGRESS_FIELD,
      `**Progress:** ${openBoxes === 0 ? "100% — all phases and acceptance criteria verified." : `closed with ${openBoxes} open.`}`,
      changes,
      "progress",
    );
  }
  const provenance = [sha === undefined ? undefined : `at \`${sha}\``, pr === undefined ? undefined : `PR ${pr}`]
    .filter((part) => part !== undefined)
    .join(", ");
  setHeaderField(
    lines,
    CLOSED_FIELD,
    `**Closed:** ${date}${provenance === "" ? "" : ` ${provenance}`}, archived to \`done/\`.`,
    changes,
    "closed",
  );
  setHeaderField(lines, STATUS_FIELD, `**Status:** ${verdict}`, changes, "status");
  setPhaseStatuses(lines, `**Status:** DONE — ${date}.`, changes);

  return { changes, markdown: lines.join("\n") };
}

/** The regression path: the header says what reopened it, and the Closed stamp goes. */
export function stampReopened(markdown, { date, reason }) {
  const lines = markdown.split("\n");
  const changes = [];
  setHeaderField(lines, STATUS_FIELD, `**Status:** REOPENED — ${date}. ${reason}`, changes, "status");
  const end = headerEnd(lines);
  for (let i = end - 1; i >= 0; i -= 1) {
    if (!CLOSED_FIELD.test(lines[i])) continue;
    lines.splice(lines[i + 1]?.trim() === "" ? i : i, lines[i + 1]?.trim() === "" ? 2 : 1);
    changes.push(`closed: removed at L${i + 1}`);
  }
  return { changes, markdown: lines.join("\n") };
}
