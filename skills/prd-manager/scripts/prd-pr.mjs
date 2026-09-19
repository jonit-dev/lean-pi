#!/usr/bin/env node
/**
 * The PRD's progress label, applied to its pull request.
 *
 * The label is computed from the PRD's own checkboxes, so it cannot be talked into a
 * number the file does not support, and it is re-applied on every push rather than set
 * once and forgotten. This also enforces the rule the label exists to make visible:
 * one pull request per PRD, never one per phase.
 *
 * Usage: node prd-pr.mjs <prd file> [--pr <number>] [--yes]
 *        node prd-pr.mjs --all [--yes]          every open PRD with a matching PR
 *        node prd-pr.mjs --create-labels [--yes]
 */
import { execFileSync } from "node:child_process";
import { basename, dirname, relative, resolve } from "node:path";
import { findPrdRoot, loadPrds, parseArgs, progressOf, repoRootOf } from "./prd-lib.mjs";
import { readFileSync } from "node:fs";

/** Red through yellow to green, one bucket per quarter. */
export const LABELS = [
  { color: "d73a4a", description: "PRD not started", name: "prd:0%", percent: 0 },
  { color: "d73a4a", description: "PRD phase 1 verified", name: "prd:25%", percent: 25 },
  { color: "e36209", description: "PRD half the phases verified", name: "prd:50%", percent: 50 },
  { color: "fbca04", description: "PRD phases in, acceptance open", name: "prd:75%", percent: 75 },
  { color: "0e8a16", description: "PRD complete, ready to merge", name: "prd:100% — ready", percent: 100 },
];

function gh(args, cwd) {
  return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function tryGh(args, cwd) {
  try {
    return gh(args, cwd);
  } catch {
    return undefined;
  }
}

/** `PRD-214-render-js-owns-the-mobile-frame.md` -> `PRD-214`. */
function prdId(name) {
  const match = /^(PRD-[A-Za-z0-9.]*\d[A-Za-z0-9.]*)/u.exec(name);
  return match === null ? name.replace(/\.md$/iu, "") : match[1];
}

/** Every open PR whose title, branch or body names this PRD. */
function prsFor(repoRoot, id) {
  const raw = tryGh(
    ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,title,headRefName,body,labels,isDraft"],
    repoRoot,
  );
  if (raw === undefined) return undefined;
  const needle = id.toLowerCase();
  return JSON.parse(raw).filter(
    (pr) =>
      pr.title.toLowerCase().includes(needle) ||
      pr.headRefName.toLowerCase().includes(needle) ||
      (pr.body ?? "").toLowerCase().includes(needle),
  );
}

function labelFor(percent) {
  return LABELS.find((label) => label.percent === percent) ?? LABELS[0];
}

function createLabels(repoRoot, apply) {
  for (const label of LABELS) {
    if (!apply) {
      process.stdout.write(`would create  ${label.name}  #${label.color}\n`);
      continue;
    }
    const made = tryGh(
      ["label", "create", label.name, "--color", label.color, "--description", label.description],
      repoRoot,
    );
    process.stdout.write(`${made === undefined ? "exists" : "created"}  ${label.name}\n`);
  }
}

/** Swaps the PRD label on one PR: every other bucket off, the computed one on. */
function applyLabel(repoRoot, pr, label, apply) {
  const current = (pr.labels ?? []).map((entry) => entry.name);
  const stale = current.filter((name) => name.startsWith("prd:") && name !== label.name);
  if (current.includes(label.name) && stale.length === 0) {
    process.stdout.write(`  #${pr.number} already ${label.name}\n`);
    return;
  }
  process.stdout.write(
    `  #${pr.number} ${stale.length > 0 ? `${stale.join(", ")} -> ` : ""}${label.name}\n`,
  );
  if (!apply) return;
  for (const name of stale) tryGh(["pr", "edit", String(pr.number), "--remove-label", name], repoRoot);
  if (tryGh(["pr", "edit", String(pr.number), "--add-label", label.name], repoRoot) === undefined) {
    process.stdout.write(`     label ${label.name} missing — run --create-labels first\n`);
  }
}

function handle(repoRoot, prd, wanted, apply) {
  const id = prdId(basename(prd.file ?? prd));
  const percent = prd.percent;
  const label = labelFor(percent);
  const prs = wanted ?? prsFor(repoRoot, id);
  if (prs === undefined) {
    process.stderr.write("gh is unavailable or not authenticated; cannot reach the pull requests.\n");
    process.exit(1);
  }
  if (prs.length === 0) {
    process.stdout.write(`${id}  ${percent}%  no open PR names it — open one draft PR before phase 1\n`);
    return;
  }
  process.stdout.write(`${id}  ${percent}%  -> ${label.name}\n`);
  if (prs.length > 1) {
    process.stdout.write(
      `  ${prs.length} open PRs name this PRD: ${prs.map((pr) => `#${pr.number}`).join(", ")}\n` +
        "  One PR per PRD. Phase-sized PRs split the evidence across branches nobody re-reads;\n" +
        "  close the extras into the first one, or say in each why the split is deliberate.\n",
    );
  }
  for (const pr of prs) applyLabel(repoRoot, pr, label, apply);
  if (percent === 100) {
    process.stdout.write("  100%: take the PR out of draft and git mv the PRD to done/ in this same PR.\n");
  }
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const apply = flags.yes === true;
  const root = flags.root === undefined ? findPrdRoot(positional[0] === undefined ? process.cwd() : dirname(resolve(positional[0]))) : resolve(flags.root);
  const repoRoot = repoRootOf(root);

  if (flags["create-labels"] === true) {
    createLabels(repoRoot, apply);
    if (!apply) process.stdout.write("\ndry run — add --yes to apply.\n");
    return;
  }

  if (flags.all === true) {
    const open = loadPrds(root).filter((prd) => !prd.done);
    for (const prd of open) {
      const prs = prsFor(repoRoot, prdId(prd.name));
      if (prs !== undefined && prs.length > 0) handle(repoRoot, prd, prs, apply);
    }
    if (!apply) process.stdout.write("\ndry run — add --yes to apply.\n");
    return;
  }

  const file = positional[0];
  if (file === undefined) {
    process.stderr.write("usage: prd-pr.mjs <prd file> [--pr <n>] [--yes] | --all | --create-labels\n");
    process.exit(1);
  }
  const full = resolve(file);
  const prd = { ...progressOf(readFileSync(full, "utf8")), file: full, name: basename(full) };
  const wanted =
    flags.pr === undefined
      ? undefined
      : JSON.parse(
          tryGh(["pr", "view", String(flags.pr), "--json", "number,title,headRefName,body,labels,isDraft"], repoRoot) ??
            "null",
        );
  handle(repoRoot, prd, wanted === null ? undefined : wanted === undefined ? undefined : [wanted], apply);
  process.stdout.write(
    `\n${relative(repoRoot, full)}\n` + (apply ? "" : "dry run — add --yes to apply.\n"),
  );
}

main();
