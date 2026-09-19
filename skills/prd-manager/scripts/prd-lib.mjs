/**
 * Shared PRD parsing for the prd-manager skill. Zero dependencies, plain Node ESM,
 * so it runs in any repository without an install step.
 *
 * A PRD is bucketed on *ticked phase boxes* and only reaches 100% when every phase
 * box and every acceptance box is ticked, so the number can never exceed what the
 * file itself supports.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** "### Phase 2 — …" and the numbered "### 3. …" form used under an Implementation order heading. */
const PHASE_HEADING = /^#{3,4}\s+(?:Phase\b|\d+\.\s)/iu;
const ACCEPTANCE_HEADING = /^#{2,4}\s+Acceptance criteria\b/iu;
const ANY_HEADING = /^#{2,4}\s/u;
const BOX = /^\s*[-*]\s+\[([ xX])\]/u;
const STATUS_LINE = /^\s*(?:[-*]\s+)?\*{0,2}status\b/iu;
const PRD_FILE = /^PRD-[^/]*\.md$/iu;
const PRD_ID = /^PRD-([A-Za-z0-9.-]*?\d[A-Za-z0-9.-]*?)-/u;

/** Splits a PRD into phase / acceptance / other sections and tallies the boxes in each. */
export function readSections(markdown) {
  const sections = [];
  let current = { kind: "other", ticked: 0, total: 0 };
  sections.push(current);
  for (const line of markdown.split("\n")) {
    if (ANY_HEADING.test(line)) {
      const kind = PHASE_HEADING.test(line)
        ? "phase"
        : ACCEPTANCE_HEADING.test(line)
          ? "acceptance"
          : "other";
      current = { kind, ticked: 0, total: 0 };
      sections.push(current);
      continue;
    }
    const box = BOX.exec(line);
    if (box === null) continue;
    current.total += 1;
    if (box[1] !== " ") current.ticked += 1;
  }
  return sections;
}

/** Progress for one PRD's markdown. `phases === 0` is the shape that cannot report. */
export function progressOf(markdown) {
  const sections = readSections(markdown);
  const phases = sections.filter((s) => s.kind === "phase" && s.total > 0);
  const acceptance = sections.filter((s) => s.kind === "acceptance");
  const acceptanceTotal = acceptance.reduce((sum, s) => sum + s.total, 0);
  const acceptanceTicked = acceptance.reduce((sum, s) => sum + s.ticked, 0);
  const phasesComplete = phases.filter((s) => s.ticked === s.total).length;
  const phaseBoxes = phases.reduce((sum, s) => sum + s.total, 0);
  const phaseBoxesTicked = phases.reduce((sum, s) => sum + s.ticked, 0);
  const openBoxes = sections.reduce((sum, s) => sum + (s.total - s.ticked), 0);

  const ready =
    phases.length > 0 &&
    phasesComplete === phases.length &&
    acceptanceTotal > 0 &&
    acceptanceTicked === acceptanceTotal;

  let percent;
  if (ready) percent = 100;
  else if (phases.length === 0) percent = 0;
  else {
    const ratio = phaseBoxes === 0 ? 0 : phaseBoxesTicked / phaseBoxes;
    percent = ratio >= 0.75 ? 75 : ratio >= 0.5 ? 50 : ratio > 0 ? 25 : 0;
  }

  return {
    acceptanceTicked,
    acceptanceTotal,
    openBoxes,
    percent,
    phaseBoxes,
    phaseBoxesTicked,
    phases: phases.length,
    phasesComplete,
    ready,
  };
}

/** The PRD's own status line, flattened to one short string. */
export function statusOf(markdown) {
  for (const line of markdown.split("\n").slice(0, 60)) {
    if (!STATUS_LINE.test(line)) continue;
    return line
      .replace(/^\s*(?:[-*]\s+)?\*{0,2}status:?\*{0,2}:?\s*/iu, "")
      .replace(/[*`]/gu, "")
      .trim();
  }
  return "";
}

/** Walks up from `start` for a directory holding `docs/PRDs` (or the usual variants). */
export function findPrdRoot(start = process.cwd()) {
  if (process.env.PRD_ROOT !== undefined && process.env.PRD_ROOT !== "") {
    return resolve(process.env.PRD_ROOT);
  }
  const candidates = ["docs/PRDs", "docs/prds", "docs/PRD", "PRDs", "prds"];
  let dir = resolve(start);
  for (;;) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (existsSync(full) && statSync(full).isDirectory()) return full;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "no PRD directory found. Run inside a repository with docs/PRDs, or set PRD_ROOT=<dir>.",
  );
}

/** The repository root containing `root`, or `root` itself when git is unavailable. */
export function repoRootOf(root) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return root;
  }
}

function walk(dir, out, matches) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, matches);
    else if (matches(entry.name)) out.push(full);
  }
  return out;
}

/**
 * `PRD-<id>-<slug>.md` is the convention here, but a repo that files plans under
 * plain names still has PRDs. Fall back to every `.md` rather than reporting zero,
 * and let `PRD_PATTERN` override both.
 */
function collect(root) {
  if (process.env.PRD_PATTERN !== undefined && process.env.PRD_PATTERN !== "") {
    const pattern = new RegExp(process.env.PRD_PATTERN, "u");
    return walk(root, [], (name) => name.endsWith(".md") && pattern.test(name));
  }
  const conventional = walk(root, [], (name) => PRD_FILE.test(name));
  if (conventional.length > 0) return conventional;
  return walk(root, [], (name) => name.endsWith(".md") && !/^(?:README|AGENTS|CLAUDE)\.md$/iu.test(name));
}

/**
 * One epoch-seconds timestamp per file, from a single `git log` pass — per-file
 * `git log` calls cost ~20 ms each and 400 PRDs make that the slowest thing here.
 */
function lastTouched(repoRoot, root) {
  const ages = new Map();
  const born = new Map();
  try {
    const log = execFileSync(
      "git",
      ["log", "--format=@%ct", "--name-only", "--", relative(repoRoot, root) || "."],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
    let when = 0;
    for (const line of log.split("\n")) {
      if (line.startsWith("@")) {
        when = Number.parseInt(line.slice(1), 10);
        continue;
      }
      if (line === "" || when === 0) continue;
      const full = join(repoRoot, line);
      if (!ages.has(full)) ages.set(full, when);
      born.set(full, when);
    }
  } catch {
    /* not a git repo, or git missing: ages stay unknown */
  }
  return { ages, born };
}

/** Every PRD under the root, parsed once, with folder state and age attached. */
export function loadPrds(root = findPrdRoot()) {
  const repoRoot = repoRootOf(root);
  const { ages, born } = lastTouched(repoRoot, root);
  const now = Date.now() / 1000;
  return collect(root)
    .map((file) => {
      const markdown = readFileSync(file, "utf8");
      const rel = relative(root, file);
      const segments = rel.split(sep);
      const name = basename(file);
      const idMatch = PRD_ID.exec(name);
      const touched = ages.get(file);
      const created = born.get(file);
      return {
        ...progressOf(markdown),
        ageDays: touched === undefined ? undefined : Math.floor((now - touched) / 86400),
        bornDays: created === undefined ? undefined : Math.floor((now - created) / 86400),
        batch: segments.length > 1 ? segments.slice(0, -1).join("/") : "",
        blocked: /^blocked$/iu.test(segments[0] ?? ""),
        // `BLOCKED/<short-reason>/<prd>.md` is the shape; a PRD loose under BLOCKED/ names no blocker.
        blockedReason: /^blocked$/iu.test(segments[0] ?? "") && segments.length > 2 ? segments[1] : "",
        done: segments.some((segment) => /^(?:done|archive|archived)$/iu.test(segment)),
        file,
        id: idMatch === null ? name.replace(/\.md$/iu, "") : `PRD-${idMatch[1]}`,
        name,
        rel,
        repoRoot,
        root,
        status: statusOf(markdown),
        words: markdown.split(/\s+/u).length,
      };
    })
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** `--flag value` / `--flag` / positional parsing, small enough not to need a dependency. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[arg.slice(2)] = next;
      i += 1;
    } else flags[arg.slice(2)] = true;
  }
  return { flags, positional };
}

/**
 * The point of this skill is that an agent answers PRD questions without reading PRDs.
 * Every command says what it just saved, so the saving is visible rather than assumed.
 * ~1.33 tokens per word is the usual English ratio for Claude's tokenizer.
 */
export function savingsLine(prds, output) {
  const words = prds.reduce((sum, prd) => sum + prd.words, 0);
  const readTokens = Math.round(words * 1.33);
  const printTokens = Math.round(output.split(/\s+/u).length * 1.33);
  if (readTokens <= printTokens) return "";
  const saved = readTokens - printTokens;
  const pct = Math.round((saved / readTokens) * 100);
  return (
    `\nsaved ~${saved.toLocaleString()} tokens (${pct}%): ${prds.length} PRDs ` +
    `≈ ${readTokens.toLocaleString()} tokens to read, this report ≈ ${printTokens.toLocaleString()}.\n`
  );
}

export function truncate(text, width) {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}
