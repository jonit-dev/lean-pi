#!/usr/bin/env node
/**
 * The pull request body for a PRD, generated from the PRD.
 *
 * A reviewer opening the PR should learn three things before scrolling: what this is for,
 * what is done, and what is not. Everything here comes from the PRD's own headings and
 * checkboxes, so the PR and the PRD cannot disagree — and regenerating after each push is
 * how they stay that way.
 *
 * Usage: node prd-body.mjs <prd file> [--pr <number> [--yes]]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { findPrdRoot, parseArgs, progressOf, repoRootOf } from "./prd-lib.mjs";

const HEADING = /^(#{2,4})\s+(.*)$/u;
const PHASE_HEADING = /^#{3,4}\s+(?:Phase\b|\d+\.\s)/iu;
const ACCEPTANCE_HEADING = /^#{2,4}\s+Acceptance criteria\b/iu;
const BOX = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/u;
const STATUS_FIELD = /^\s*(?:[-*]\s+)?\*{0,2}status\b/iu;

/** Sections with their boxes, so the body can group "done" and "left" under real headings. */
function sections(markdown) {
  const out = [];
  let current = { boxes: [], kind: "other", title: "" };
  out.push(current);
  for (const line of markdown.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading !== null) {
      current = {
        boxes: [],
        kind: PHASE_HEADING.test(line) ? "phase" : ACCEPTANCE_HEADING.test(line) ? "acceptance" : "other",
        title: heading[2].replace(/[*`]/gu, "").trim(),
      };
      out.push(current);
      continue;
    }
    const box = BOX.exec(line);
    if (box !== null) current.boxes.push({ text: box[2].trim(), ticked: box[1] !== " " });
  }
  return out;
}

/**
 * The first real prose paragraph, used as the TLDR when the PRD has no explicit
 * Outcome or Problem field. Status and metadata lines are not a summary.
 */
function tldr(markdown) {
  const lines = markdown.split("\n");
  const label = /^\*{0,2}(?:Outcome|Goal|Problem|Summary)\b/iu;
  const index = lines.findIndex((line) => label.test(line.trim()));
  if (index !== -1) {
    // PRD prose is hard-wrapped, so the field's sentence continues on the next lines.
    const paragraph = [lines[index]];
    for (let i = index + 1; i < lines.length; i += 1) {
      const text = lines[i].trim();
      if (text === "" || text.startsWith("#") || text.startsWith("**") || text.startsWith("|")) break;
      paragraph.push(text);
    }
    return paragraph.join(" ").replace(/^\*{0,2}\w+:?\*{0,2}:?\s*/u, "").replace(/[*]/gu, "").trim();
  }
  let started = false;
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith("#")) {
      started = true;
      continue;
    }
    if (!started || text === "" || STATUS_FIELD.test(text) || text.startsWith("**") || text.startsWith("|")) continue;
    const paragraph = [text];
    const from = lines.indexOf(line);
    for (let i = from + 1; i < lines.length; i += 1) {
      const next = lines[i].trim();
      if (next === "" || next.startsWith("#") || next.startsWith("**") || next.startsWith("|")) break;
      paragraph.push(next);
    }
    return paragraph.join(" ").replace(/[*]/gu, "");
  }
  return "";
}

function bullet(box) {
  return `- [${box.ticked ? "x" : " "}] ${box.text}`;
}

function build(markdown, { id, file }) {
  const progress = progressOf(markdown);
  const all = sections(markdown);
  const phases = all.filter((section) => section.kind === "phase" && section.boxes.length > 0);
  const acceptance = all.filter((section) => section.kind === "acceptance" && section.boxes.length > 0);
  const summary = tldr(markdown);

  const lines = [];
  lines.push(`**TL;DR** — ${summary === "" ? `${id}. See the PRD for the goal.` : summary}`);
  lines.push("");
  lines.push(
    `${progress.percent}% by the PRD's own boxes: ${progress.phasesComplete}/${progress.phases} phases ` +
      `(${progress.phaseBoxesTicked}/${progress.phaseBoxes} boxes), ` +
      `${progress.acceptanceTicked}/${progress.acceptanceTotal} acceptance criteria. PRD: \`${file}\`.`,
  );
  lines.push("");

  lines.push("## Phases");
  lines.push("");
  for (const phase of phases) {
    const done = phase.boxes.filter((box) => box.ticked).length;
    lines.push(`### ${phase.title}  — ${done}/${phase.boxes.length}`);
    lines.push("");
    for (const box of phase.boxes) lines.push(bullet(box));
    lines.push("");
  }

  if (acceptance.length > 0) {
    lines.push("## Acceptance criteria");
    lines.push("");
    for (const section of acceptance) for (const box of section.boxes) lines.push(bullet(box));
    lines.push("");
  }

  const left = [...phases, ...acceptance].flatMap((section) =>
    section.boxes.filter((box) => !box.ticked).map((box) => `${section.title}: ${box.text}`),
  );
  lines.push("## Still open");
  lines.push("");
  if (left.length === 0) {
    lines.push("Nothing. Every phase and acceptance box is ticked — take this out of draft and archive the PRD to `done/` in this PR.");
  } else {
    for (const item of left.slice(0, 20)) lines.push(`- ${item}`);
    if (left.length > 20) lines.push(`- …and ${left.length - 20} more, in the PRD`);
  }
  lines.push("");
  lines.push("<sub>Generated from the PRD's checkboxes. Regenerate on each push so the PR and the PRD never disagree.</sub>");
  return lines.join("\n");
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const file = positional[0];
  if (file === undefined) {
    process.stderr.write("usage: prd-body.mjs <prd file> [--pr <number> [--yes]]\n");
    process.exit(1);
  }
  const full = resolve(file);
  const markdown = readFileSync(full, "utf8");
  const root = flags.root === undefined ? findPrdRoot(dirname(full)) : resolve(flags.root);
  const repoRoot = repoRootOf(root);
  const id = /^(PRD-[A-Za-z0-9.]*\d[A-Za-z0-9.]*)/u.exec(basename(full))?.[1] ?? basename(full);
  const body = build(markdown, { file: relative(repoRoot, full), id });

  if (flags.pr === undefined) {
    process.stdout.write(`${body}\n`);
    return;
  }
  if (flags.yes !== true) {
    process.stdout.write(`${body}\n\n--- dry run — add --yes to write this to PR #${flags.pr}.\n`);
    return;
  }
  execFileSync("gh", ["pr", "edit", String(flags.pr), "--body", body], { cwd: repoRoot, stdio: "inherit" });
  process.stdout.write(`\nPR #${flags.pr} body updated from ${relative(repoRoot, full)}.\n`);
}

main();
