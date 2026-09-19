/**
 * Deterministic candidate production (PRD-023 Phase 1, ROADMAP §6.4).
 *
 * Candidates in, nothing else: a fresh grep over the harness's own search is
 * cheaper than a stale index, so there is no index, no embedding store and no
 * cache here. The search surface is a port because the executor's `search` tool
 * (PRD-001) and PRD-018's symbol queries live outside this module — but the
 * shipped implementation is plain `node:fs`, which is what makes the whole
 * module runnable with no model, no credential and no network (§49).
 *
 * Bounded by construction: a walk stops at `MAX_WALK_FILES`, a grep stops at
 * `maxCandidates`, and a file larger than `MAX_SCAN_BYTES` is never scanned, so
 * "explore the repository" can never degrade into an unbounded scan.
 */
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";
import { languageOfPath } from "../lsp/detect.js";

export interface GrepHit {
	/** Repo-relative posix path. */
	path: string;
	lines: Array<{ number: number; text: string }>;
}

export interface GrepQuery {
	pattern: string;
	root: string;
	ignore?: readonly string[];
	maxFiles?: number;
	maxMatchesPerFile?: number;
}

export interface GlobQuery {
	pattern: string;
	root: string;
	ignore?: readonly string[];
	maxFiles?: number;
}

/** The harness's search surface. PRD-001's `search` tool or PRD-018's LSP queries back it. */
export interface SearchPort {
	grep(query: GrepQuery): GrepHit[];
	glob(query: GlobQuery): string[];
	read(path: string): string;
	/** File size in bytes; `0` when the path does not exist. */
	size(path: string): number;
}

export interface Candidate {
	path: string;
	bytes: number;
	language: string;
	matchCount: number;
	matchedLines: Array<{ number: number; text: string }>;
	/** Declaration-shaped matches: evidence a symbol the task cares about lives here. */
	symbolHits: number;
	/** Directory distance to the nearest changed file; `0` means "same directory". */
	distanceToChangedFiles: number;
}

export interface GatherInput {
	objective: string;
	/** Subsystem root to search, repo-relative; `"."` searches the repository. */
	root: string;
	search: SearchPort;
	changedFiles: readonly string[];
	ignore?: readonly string[];
	maxCandidates: number;
	maxMatchesPerFile?: number;
	/** Symbol evidence from the LSP navigation port (PRD-018), keyed by path. */
	symbolHits?: ReadonlyMap<string, number>;
}

export const DEFAULT_IGNORE_GLOBS: readonly string[] = [
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"coverage",
	".next",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	"vendor",
	"target",
];

/** Beyond this a file is not scanned: an exploration never reads a blob. */
export const MAX_SCAN_BYTES = 512 * 1024;
/** The walk's own ceiling, so a huge tree cannot turn `grep` into an unbounded scan. */
export const MAX_WALK_FILES = 2_000;

/**
 * Docs and data are not code candidates: they can match an objective but they
 * never carry the change. The extension table itself is PRD-018's, so LeanPi
 * has one definition of "which language is this path".
 */
const NON_CODE_LANGUAGES = new Set(["markdown", "json", "yaml"]);

/** The candidate's language, or `undefined` when the path is not a code file. */
export function candidateLanguage(path: string): string | undefined {
	const language = languageOfPath(path);
	return language !== null && !NON_CODE_LANGUAGES.has(language) ? language : undefined;
}

const DECLARATION_PATTERN = /(^|[^A-Za-z0-9_])(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var|def|fn|struct|impl|func)\s+[A-Za-z_]/;

const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"into",
	"when",
	"must",
	"should",
	"make",
	"sure",
	"fix",
	"fixes",
	"add",
	"adds",
	"bug",
	"issue",
	"task",
	"code",
]);

/** Objective → search terms. Deterministic, deduped, capped; the order is first-seen. */
export function objectiveTerms(objective: string, limit = 8): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const token of objective.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
		if (token.length < 3 || STOP_WORDS.has(token) || seen.has(token)) continue;
		seen.add(token);
		terms.push(token);
		if (terms.length >= limit) break;
	}
	return terms;
}

export function objectivePattern(objective: string, limit = 8): string {
	return objectiveTerms(objective, limit)
		.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|");
}

function toPosix(path: string): string {
	return path.split(sep).join("/");
}

/** Sorted depth-first walk under `base`, skipping ignored segments; paths are relative to `base`. */
function walk(base: string, ignore: readonly string[], maxFiles: number): string[] {
	const found: string[] = [];
	const visit = (dir: string): void => {
		if (found.length >= maxFiles) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(join(base, dir), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
			if (found.length >= maxFiles) return;
			const relPath = dir.length === 0 ? entry.name : `${dir}/${entry.name}`;
			if (relPath.split("/").some((segment) => ignore.includes(segment))) continue;
			if (entry.isDirectory()) visit(relPath);
			else if (entry.isFile()) found.push(relPath);
		}
	};
	visit("");
	return found;
}

/** `**\/x`, `*.ext` and literal segments; enough for test globs and ignore sets, no dependency. */
export function matchesGlob(relPath: string, pattern: string): boolean {
	const pathSegments = relPath.split("/");
	const patternSegments = pattern.split("/");
	const match = (pathIndex: number, patternIndex: number): boolean => {
		if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
		const segment = patternSegments[patternIndex]!;
		if (segment === "**") {
			if (patternIndex === patternSegments.length - 1) return true;
			for (let index = pathIndex; index <= pathSegments.length; index += 1) {
				if (match(index, patternIndex + 1)) return true;
			}
			return false;
		}
		if (pathIndex >= pathSegments.length) return false;
		const ok = segment.includes("*")
			? new RegExp(`^${segment.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(pathSegments[pathIndex]!)
			: segment === pathSegments[pathIndex];
		return ok && match(pathIndex + 1, patternIndex + 1);
	};
	return match(0, 0);
}

export interface FileSearchOptions {
	cwd: string;
	ignore?: readonly string[];
	maxScanBytes?: number;
	maxWalkFiles?: number;
}

/**
 * The shipped `SearchPort`: `node:fs` plus a regex. No index, no daemon, no
 * network. ponytail: each grep walks the tree and reads every code file until it
 * has enough hits — bounded by `MAX_WALK_FILES`, and only paid when exploration
 * runs; swap in PRD-001's `search` tool or an LSP-backed index if a repository
 * ever makes the walk the dominant cost.
 */
export function createFileSearch(options: FileSearchOptions): SearchPort {
	const cwd = options.cwd;
	const ignore = options.ignore ?? DEFAULT_IGNORE_GLOBS;
	const maxScanBytes = options.maxScanBytes ?? MAX_SCAN_BYTES;
	const maxWalkFiles = options.maxWalkFiles ?? MAX_WALK_FILES;
	const absolute = (relPath: string): string => join(cwd, relPath);

	return {
		grep(query) {
			const pattern = new RegExp(query.pattern, "i");
			const maxFiles = query.maxFiles ?? 64;
			const maxMatchesPerFile = query.maxMatchesPerFile ?? 24;
			const rootPrefix = query.root === "." || query.root.length === 0 ? "" : `${toPosix(query.root).replace(/\/$/, "")}/`;
			const files = walk(absolute(query.root === "." ? "" : toPosix(query.root)), query.ignore ?? ignore, maxWalkFiles);
			const hits: GrepHit[] = [];
			for (const file of files) {
				if (hits.length >= maxFiles) break;
				if (candidateLanguage(file) === undefined) continue;
				const relPath = `${rootPrefix}${file}`;
				const size = this.size(relPath);
				if (size === 0 || size > maxScanBytes) continue;
				const lines: Array<{ number: number; text: string }> = [];
				try {
					const text = readFileSync(absolute(relPath), "utf8");
					const rawLines = text.split("\n");
					for (let index = 0; index < rawLines.length && lines.length < maxMatchesPerFile; index += 1) {
						if (pattern.test(rawLines[index]!)) lines.push({ number: index + 1, text: rawLines[index]! });
					}
				} catch {
					continue;
				}
				if (lines.length > 0) hits.push({ path: relPath, lines });
			}
			return hits;
		},

		glob(query) {
			const maxFiles = query.maxFiles ?? 200;
			const files = walk(absolute(query.root === "." ? "" : toPosix(query.root)), query.ignore ?? ignore, maxWalkFiles);
			const rootPrefix = query.root === "." || query.root.length === 0 ? "" : `${toPosix(query.root).replace(/\/$/, "")}/`;
			const matched: string[] = [];
			for (const file of files) {
				if (matched.length >= maxFiles) break;
				if (matchesGlob(file, query.pattern)) matched.push(`${rootPrefix}${file}`);
			}
			return matched;
		},

		read(path) {
			return readFileSync(absolute(path), "utf8");
		},

		size(path) {
			try {
				const stats = statSync(absolute(path));
				return stats.isFile() ? stats.size : 0;
			} catch {
				return 0;
			}
		},
	};
}

/** Distance between a candidate's directory and the nearest changed file's directory. */
export function pathDistanceToChanged(path: string, changedFiles: readonly string[]): number {
	const dir = path.split("/").slice(0, -1);
	let best = Number.POSITIVE_INFINITY;
	for (const changed of changedFiles) {
		const changedDir = changed.split("/").slice(0, -1);
		let common = 0;
		while (common < dir.length && common < changedDir.length && dir[common] === changedDir[common]) common += 1;
		best = Math.min(best, dir.length - common + changedDir.length - common);
	}
	return Number.isFinite(best) ? best : 0;
}

/**
 * Deterministic candidates for one round: grep the objective's terms under one
 * root and keep code files. Sorted by match count then path, so the ranking's
 * input order is stable before any score exists.
 */
export function gatherCandidates(input: GatherInput): Candidate[] {
	const pattern = objectivePattern(input.objective);
	if (pattern.length === 0) return [];
	const hits = input.search.grep({
		pattern,
		root: input.root,
		ignore: input.ignore,
		maxFiles: input.maxCandidates,
		maxMatchesPerFile: input.maxMatchesPerFile,
	});
	return hits
		.map(
			(hit): Candidate => ({
				path: hit.path,
				bytes: input.search.size(hit.path),
				language: candidateLanguage(hit.path) ?? "other",
				matchCount: hit.lines.length,
				matchedLines: hit.lines,
				symbolHits: hit.lines.filter((line) => DECLARATION_PATTERN.test(line.text)).length + (input.symbolHits?.get(hit.path) ?? 0),
				distanceToChangedFiles: pathDistanceToChanged(hit.path, input.changedFiles),
			}),
		)
		.sort((left, right) => right.matchCount - left.matchCount || left.path.localeCompare(right.path))
		.slice(0, input.maxCandidates);
}

/** The raw text of one grep hit as the harness produced it — the bytes a drop must preserve. */
export function snippetTextOf(hit: GrepHit): string {
	return hit.lines.map((line) => `${line.number}: ${line.text}`).join("\n");
}
