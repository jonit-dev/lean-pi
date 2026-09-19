#!/usr/bin/env node
/**
 * One table of every PRD, so an agent can see the state of the work without reading
 * the PRDs. A few hundred PRDs are a million-plus tokens to read; this is one screen.
 *
 * Usage: node prd-board.mjs [--filter inflight|stalled|noboxes|ready|blocked|done|all]
 *                           [--batch <substring>] [--older <days>] [--limit <n>]
 *                           [--pr] [--json] [--root <dir>]
 */
import { execFileSync } from "node:child_process";
import { findPrdRoot, loadPrds, parseArgs, savingsLine, truncate } from "./prd-lib.mjs";

const FILTERS = {
  all: () => true,
  blocked: (p) => p.blocked,
  done: (p) => p.done,
  inflight: (p) => !p.done && !p.blocked && p.percent > 0 && p.percent < 100,
  noboxes: (p) => !p.done && p.phases === 0,
  ready: (p) => !p.done && p.percent === 100,
  stalled: (p) => !p.done && !p.blocked && p.percent === 0,
};

/** One `gh pr list` call, matched to PRDs by id in the title, branch or body. */
function pullRequests(cwd) {
  try {
    const raw = execFileSync(
      "gh",
      ["pr", "list", "--state", "open", "--limit", "300", "--json", "number,title,headRefName,labels"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function matchPr(prs, id) {
  if (prs === undefined) return "";
  const needle = id.toLowerCase();
  const hit = prs.find(
    (pr) =>
      pr.title.toLowerCase().includes(needle) || pr.headRefName.toLowerCase().includes(needle),
  );
  return hit === undefined ? "" : `#${hit.number}`;
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const root = flags.root === undefined ? findPrdRoot() : flags.root;
  const all = loadPrds(root);

  const filterName = typeof flags.filter === "string" ? flags.filter : "open";
  const filter =
    filterName === "open" ? (p) => !p.done : FILTERS[filterName];
  if (filter === undefined) {
    process.stderr.write(`unknown --filter ${filterName}. One of: open, ${Object.keys(FILTERS).join(", ")}\n`);
    process.exit(1);
  }

  let rows = all.filter(filter);
  if (typeof flags.batch === "string") rows = rows.filter((p) => p.batch.includes(flags.batch));
  if (flags.older !== undefined) {
    const days = Number(flags.older);
    rows = rows.filter((p) => p.ageDays !== undefined && p.ageDays >= days);
  }
  rows.sort((a, b) => b.percent - a.percent || (a.ageDays ?? 0) - (b.ageDays ?? 0));
  const limit = flags.limit === undefined ? rows.length : Number(flags.limit);

  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(rows.slice(0, limit), null, 2)}\n`);
    return;
  }

  const prs = flags.pr === true ? pullRequests(all[0]?.repoRoot ?? root) : undefined;
  const shown = rows.slice(0, limit);

  const header = ["PRD", "%", "boxes", "acc", "age", flags.pr === true ? "PR" : "", "where", "status"];
  const lines = shown.map((p) => [
    truncate(p.id, 12),
    p.phases === 0 ? "—" : `${p.percent}%`,
    p.phases === 0 ? "no phases" : `${p.phaseBoxesTicked}/${p.phaseBoxes}`,
    p.acceptanceTotal === 0 ? "—" : `${p.acceptanceTicked}/${p.acceptanceTotal}`,
    p.ageDays === undefined ? "—" : `${p.ageDays}d`,
    flags.pr === true ? matchPr(prs, p.id) : "",
    truncate(p.batch === "" ? "." : p.batch, 26),
    truncate(p.status, 52),
  ]);

  const widths = header.map((_, column) =>
    Math.max(header[column].length, ...lines.map((line) => line[column].length)),
  );
  const render = (cells) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]))
      .join("  ")
      .trimEnd();

  let out = `${render(header)}\n${render(widths.map((w) => "-".repeat(w)))}\n`;
  for (const line of lines) out += `${render(line)}\n`;
  process.stdout.write(out);

  const counts = Object.fromEntries(
    Object.entries(FILTERS).map(([name, test]) => [name, all.filter(test).length]),
  );
  if (rows.length > shown.length) {
    process.stdout.write(`\n… ${rows.length - shown.length} more (drop --limit to see them)\n`);
  }
  const summary =
    `\n${all.length} PRDs: ${counts.done} done, ${counts.ready} ready to file, ` +
    `${counts.inflight} in flight, ${counts.stalled} at 0%, ${counts.noboxes} with no phase boxes, ` +
    `${counts.blocked} blocked\n`;
  process.stdout.write(summary);
  process.stdout.write(savingsLine(shown, out + summary));
}

main();
