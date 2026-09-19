#!/usr/bin/env node
/**
 * Drift and bloat report. Everything here is a fact about the files, never a judgement:
 * the audit says what is inconsistent, a human or an agent decides what to do about it.
 *
 * Usage: node prd-audit.mjs [--older <days>] [--evidence <dir>] [--all] [--json]
 *                           [--strict] [--root <dir>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { findPrdRoot, loadPrds, parseArgs, savingsLine, truncate } from "./prd-lib.mjs";

const DONE_WORDS = /\b(?:DONE|COMPLETE|COMPLETED|SHIPPED|LANDED|CLOSED)\b/u;
const OPEN_WORDS = /\b(?:PARTIAL|NOT STARTED|PROPOSED|OPEN|SCOPING|IN PROGRESS|BLOCKED|DRAFT)\b/u;
/** Two or more independent clauses in one criterion — a box that can never be ticked. */
const COMPOUND = /\[ \][^\n]*\band\b[^\n]*\band\b/gu;

const EVIDENCE_DIRS = ["docs/verification", "docs/evidence", "verification", "evidence"];

function findEvidenceDir(repoRoot, flag) {
  if (typeof flag === "string") return resolve(flag);
  for (const candidate of EVIDENCE_DIRS) {
    const full = join(repoRoot, candidate);
    if (existsSync(full) && statSync(full).isDirectory()) return full;
  }
  return undefined;
}

function listMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listMarkdown(full, out);
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * Every `*.md` filename mentioned anywhere in the repo except the evidence directory
 * itself — one `git grep` rather than one per candidate file.
 */
function referencedNames(repoRoot, evidenceDir) {
  const exclude = `:(exclude)${relative(repoRoot, evidenceDir)}`;
  try {
    const raw = execFileSync(
      "git",
      ["grep", "-hoIE", "[A-Za-z0-9._/-]+\\.md", "--", ".", exclude],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    return new Set(raw.split("\n").map((line) => basename(line.trim())));
  } catch {
    return undefined;
  }
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const root = flags.root === undefined ? findPrdRoot() : flags.root;
  const prds = loadPrds(root);
  const repoRoot = prds[0]?.repoRoot ?? root;
  const olderThan = flags.older === undefined ? 30 : Number(flags.older);
  const cap = flags.all === true ? Number.POSITIVE_INFINITY : 10;

  const findings = [];
  const add = (key, title, fix, items) => {
    if (items.length > 0) findings.push({ fix, items, key, title });
  };

  add(
    "ready-not-filed",
    "Finished but still open — every phase and acceptance box ticked",
    "prd-close.mjs <file> --yes",
    prds.filter((p) => !p.done && p.percent === 100).map((p) => p.rel),
  );

  add(
    "misfiled-done",
    "Filed under done/ with boxes still open",
    "reopen it, or tick and evidence the remaining boxes",
    prds.filter((p) => p.done && p.openBoxes > 0).map((p) => `${p.rel}  (${p.openBoxes} open)`),
  );

  add(
    "status-says-done",
    "Status line claims done, file is not in done/",
    "verify the boxes, then prd-close.mjs",
    prds
      .filter((p) => !p.done && DONE_WORDS.test(p.status) && !OPEN_WORDS.test(p.status))
      .map((p) => `${p.rel}  — ${truncate(p.status, 60)}`),
  );

  add(
    "status-says-open",
    "Filed under done/ but the status line says otherwise",
    "the one clean un-filing: move it back and say so",
    prds
      .filter((p) => p.done && OPEN_WORDS.test(p.status) && !DONE_WORDS.test(p.status))
      .map((p) => `${p.rel}  — ${truncate(p.status, 60)}`),
  );

  add(
    "no-phase-boxes",
    "No phase checkboxes — progress cannot be reported, so nobody works it",
    "add the boxes from the phase prose before starting",
    prds.filter((p) => !p.done && p.phases === 0).map((p) => p.rel),
  );

  add(
    "compound-criteria",
    "Acceptance boxes conjoining independent claims — unreachable by construction",
    "one box per platform, per artifact, per property",
    prds
      .filter((p) => !p.done)
      .map((p) => {
        const hits = readFileSync(p.file, "utf8").match(COMPOUND);
        return hits === null ? undefined : `${p.rel}  (${hits.length})`;
      })
      .filter((entry) => entry !== undefined),
  );

  const ids = new Map();
  for (const prd of prds) ids.set(prd.id, [...(ids.get(prd.id) ?? []), prd.rel]);
  add(
    "duplicate-ids",
    "Same PRD id in more than one file",
    "one id, one file — merge or renumber",
    [...ids.entries()].filter(([, files]) => files.length > 1).map(([id, files]) => `${id}: ${files.join(", ")}`),
  );

  add(
    "never-started",
    `Filed ${olderThan}+ days ago and still at 0% — the bloat every agent still reads`,
    "keep, or move to an ideas file; a plan nobody starts is not a plan",
    prds
      .filter((p) => !p.done && !p.blocked && p.percent === 0 && (p.bornDays ?? 0) >= olderThan)
      .sort((a, b) => (b.bornDays ?? 0) - (a.bornDays ?? 0))
      .map((p) => `${p.rel}  (filed ${p.bornDays}d ago, last touched ${p.ageDays}d)`),
  );

  add(
    "blocked-stale",
    `Blocked and untouched for ${olderThan}+ days — several blockers outlive their condition`,
    "retry the blocked reason once, record what happened, then re-file",
    prds
      .filter((p) => p.blocked && (p.ageDays ?? 0) >= olderThan)
      .sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0))
      .map((p) => `${p.rel}  (${p.ageDays}d)`),
  );

  add(
    "blocked-without-reason",
    "Blocked PRD not filed under a reason folder — BLOCKED/<short-reason>/<prd>.md",
    "move it under a folder naming the missing evidence, credential or person",
    prds.filter((p) => p.blocked && p.blockedReason === "").map((p) => p.rel),
  );

  const evidenceDir = findEvidenceDir(repoRoot, flags.evidence);
  if (evidenceDir !== undefined && existsSync(evidenceDir)) {
    const referenced = referencedNames(repoRoot, evidenceDir);
    if (referenced !== undefined) {
      add(
        "orphan-evidence",
        `Evidence files under ${relative(repoRoot, evidenceDir)} that nothing outside them references`,
        "delete, or cite them from the PRD they prove",
        listMarkdown(evidenceDir)
          .filter((file) => !referenced.has(basename(file)))
          .map((file) => relative(repoRoot, file)),
      );
    }
  }

  const ORDER = [
    "ready-not-filed",
    "status-says-done",
    "status-says-open",
    "duplicate-ids",
    "no-phase-boxes",
    "compound-criteria",
    "misfiled-done",
    "never-started",
    "blocked-without-reason",
    "blocked-stale",
    "orphan-evidence",
  ];
  findings.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));

  if (flags.json === true) {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  } else if (findings.length === 0) {
    process.stdout.write("No PRD drift found.\n");
  } else {
    let out = "";
    for (const finding of findings) {
      out += `\n${finding.title}  [${finding.items.length}]\n  fix: ${finding.fix}\n`;
      for (const item of finding.items.slice(0, cap)) out += `  - ${item}\n`;
      if (finding.items.length > cap) out += `  … ${finding.items.length - cap} more (--all)\n`;
    }
    const total = findings.reduce((sum, finding) => sum + finding.items.length, 0);
    out += `\n${total} items across ${findings.length} categories.\n`;
    process.stdout.write(out);
    process.stdout.write(savingsLine(prds, out));
  }

  const actionable = new Set(["duplicate-ids", "misfiled-done", "ready-not-filed", "status-says-done", "status-says-open"]);
  if (flags.strict === true && findings.some((finding) => actionable.has(finding.key))) process.exit(1);
}

main();
