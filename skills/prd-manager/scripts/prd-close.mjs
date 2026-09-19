#!/usr/bin/env node
/**
 * Close a finished PRD, or reopen one that regressed — the archive move as one command
 * instead of a ritual nobody performs.
 *
 * Dry run by default: it prints the plan and changes nothing until `--yes`.
 *
 * Usage: node prd-close.mjs <prd file> [--yes] [--keep-batch] [--no-status] [--force]
 *        node prd-close.mjs <prd file> --reopen --reason "<what regressed>" [--yes]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { findPrdRoot, parseArgs, progressOf, repoRootOf } from "./prd-lib.mjs";
import { stampDone, stampReopened } from "./prd-status.mjs";

const BOX = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/u;

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Every unticked box with its line number, so "what is left" needs no PRD read. */
function openBoxes(markdown) {
  const out = [];
  markdown.split("\n").forEach((line, index) => {
    const box = BOX.exec(line);
    if (box !== null && box[1] === " ") out.push({ line: index + 1, text: box[2].trim() });
  });
  return out;
}

/** `PRD-214-render-js-owns-the-mobile-frame.md` -> `PRD-214`, for citing a PR. */
function prdId(name) {
  const match = /^(PRD-[A-Za-z0-9.]*\d[A-Za-z0-9.]*)/u.exec(name);
  return match === null ? name.replace(/\.md$/iu, "") : match[1];
}

/** The commit the close is stamped against, for the PRD's own provenance line. */
function headSha(repoRoot) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** The open PR whose title or branch names this PRD, so the stamp can cite it. */
function matchingPr(repoRoot, id) {
  try {
    const raw = execFileSync(
      "gh",
      ["pr", "list", "--state", "all", "--limit", "100", "--search", id, "--json", "number,title,headRefName"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const needle = id.toLowerCase();
    const hit = JSON.parse(raw).find(
      (pr) => pr.title.toLowerCase().includes(needle) || pr.headRefName.toLowerCase().includes(needle),
    );
    return hit === undefined ? undefined : `#${hit.number}`;
  } catch {
    return undefined;
  }
}

function gitMove(repoRoot, from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    execFileSync("git", ["mv", relative(repoRoot, from), relative(repoRoot, to)], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    renameSync(from, to);
  }
}

function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const file = positional[0];
  if (file === undefined) {
    process.stderr.write("usage: prd-close.mjs <prd file> [--yes] [--reopen --reason \"…\"]\n");
    process.exit(1);
  }
  const full = resolve(file);
  if (!existsSync(full)) {
    process.stderr.write(`${file}: no such file\n`);
    process.exit(1);
  }
  const root = flags.root === undefined ? findPrdRoot(dirname(full)) : resolve(flags.root);
  const repoRoot = repoRootOf(root);
  const markdown = readFileSync(full, "utf8");
  const progress = progressOf(markdown);
  const inDone = relative(root, full)
    .split(sep)
    .some((segment) => /^(?:done|archive|archived)$/iu.test(segment));
  const apply = flags.yes === true;

  if (flags.reopen === true) {
    if (!inDone) {
      process.stderr.write(`${file} is not under done/ — nothing to reopen.\n`);
      process.exit(1);
    }
    const reason = typeof flags.reason === "string" ? flags.reason : undefined;
    if (reason === undefined) {
      process.stderr.write(
        "--reopen needs --reason \"<what specifically regressed, and the commit or gate that shows it>\".\n" +
          "Reopening without a named regression deletes the record that the work landed.\n",
      );
      process.exit(1);
    }
    const batch = typeof flags.batch === "string" ? flags.batch : "";
    const target = join(root, batch, basename(full));
    const stamped = stampReopened(markdown, { date: today(), reason });
    process.stdout.write(
      `reopen  ${relative(repoRoot, full)}\n` +
        `    ->  ${relative(repoRoot, target)}\n` +
        `status  **Status:** REOPENED — ${today()}. ${reason}\n` +
        stamped.changes.map((change) => `        ${change}\n`).join("") +
        "keep every ticked box and its evidence; add the new work unticked.\n",
    );
    if (!apply) {
      process.stdout.write("\ndry run — add --yes to apply.\n");
      return;
    }
    writeFileSync(full, stamped.markdown);
    gitMove(repoRoot, full, target);
    process.stdout.write(
      `\ndone. commit message:\n\n  docs(PRDs): reopen ${basename(full)}\n\n  ${reason}\n`,
    );
    return;
  }

  if (inDone) {
    process.stdout.write(`${file} is already under done/.\n`);
    return;
  }

  if (progress.phases === 0) {
    process.stderr.write(
      `${file}: no phase checkboxes, so completion cannot be verified.\n` +
        "Add the boxes from the phase prose first, or pass --force if the PRD genuinely has no phases.\n",
    );
    if (flags.force !== true) process.exit(1);
  }

  if (progress.percent !== 100 && flags.force !== true) {
    const open = openBoxes(markdown);
    process.stderr.write(
      `${file} is at ${progress.percent}% — not ready to close.\n` +
        `  phases     ${progress.phasesComplete}/${progress.phases} (${progress.phaseBoxesTicked}/${progress.phaseBoxes} boxes)\n` +
        `  acceptance ${progress.acceptanceTicked}/${progress.acceptanceTotal}\n` +
        `\n${open.length} open box${open.length === 1 ? "" : "es"}:\n`,
    );
    for (const box of open.slice(0, 30)) {
      process.stderr.write(`  L${box.line}  ${box.text.slice(0, 100)}\n`);
    }
    if (open.length > 30) process.stderr.write(`  … ${open.length - 30} more\n`);
    process.stderr.write(
      "\nTick and evidence them, or --force if the PRD is closing with items deliberately left open.\n",
    );
    process.exit(1);
  }

  const keepBatch = flags["keep-batch"] === true;
  const sub = keepBatch ? dirname(relative(root, full)) : "";
  const target = join(root, "done", sub === "." ? "" : sub, basename(full));
  const stamped = stampDone(markdown, {
    date: today(),
    openBoxes: progress.openBoxes,
    pr: flags["no-status"] === true ? undefined : matchingPr(repoRoot, prdId(basename(full))),
    sha: headSha(repoRoot),
  });
  const willRewrite = flags["no-status"] !== true;

  process.stdout.write(
    `close   ${relative(repoRoot, full)}  (${progress.percent}%, ` +
      `${progress.phaseBoxesTicked}/${progress.phaseBoxes} phase boxes, ` +
      `${progress.acceptanceTicked}/${progress.acceptanceTotal} acceptance)\n` +
      `    ->  ${relative(repoRoot, target)}\n` +
      (willRewrite
        ? stamped.changes.map((change) => `status  ${change}\n`).join("")
        : "status  left as written\n"),
  );

  if (!apply) {
    process.stdout.write("\ndry run — add --yes to apply.\n");
    return;
  }

  if (willRewrite) writeFileSync(full, stamped.markdown);
  gitMove(repoRoot, full, target);
  process.stdout.write(
    "\ndone. Archive the move in the same commit as the work that finished it:\n\n" +
      `  docs(PRDs): close ${basename(full)}\n`,
  );
}

main();
