/**
 * The out-of-context skill registry (PRD-005 Phase 1, ROADMAP §16).
 *
 * Only YAML frontmatter is read — never a body — so the installed corpus is
 * indexed for ~one line per skill instead of being pasted into context (§6.3).
 * Roots come from configuration with a runtime-resolved default; no absolute
 * machine path is hard-coded here.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { bundledRoot, packVersion, verifyBundledFile } from "../skills/pack.js";

/** Precedence order: project > user global > plugin > bundled (PRD-026). */
export type SourceClass = "project" | "user" | "plugin" | "bundled";

export interface SkillRecord {
	name: string;
	description: string;
	tags: string[];
	capabilities: string[];
	risk: string | null;
	cost_hint: string | null;
	version: string | null;
	source: { class: SourceClass; path: string; root: string };
	status: "ok" | "invalid";
	/** Parse message, present only when `status` is `invalid`. */
	error?: string;
}

export interface SkillRoot {
	path: string;
	class: SourceClass;
}

/** How much of a `SKILL.md` the registry is allowed to touch. */
export const FRONTMATTER_READ_LIMIT = 4096;

export interface ScanStats {
	files: number;
	bytesRead: number;
}

/** Module-level measurement of the out-of-context claim, read by the test suite. */
export const scanStats: ScanStats = { files: 0, bytesRead: 0 };

export function resetScanStats(): void {
	scanStats.files = 0;
	scanStats.bytesRead = 0;
}

/** The default root order: project > user global > plugin (§16 precedence). */
export function defaultSkillRoots(cwd: string, home: string = homedir()): SkillRoot[] {
	const roots: SkillRoot[] = [
		{ path: join(cwd, ".claude/skills"), class: "project" },
		{ path: join(cwd, ".codex/skills"), class: "project" },
		{ path: join(home, ".claude/skills"), class: "user" },
		{ path: join(home, ".codex/skills"), class: "user" },
	];
	for (const pluginRoot of pluginSkillRoots(home)) roots.push({ path: pluginRoot, class: "plugin" });
	// Last: the pack that ships inside the package, so a user's own copy of a
	// skill always wins. The bundled pack is a floor, not an override.
	roots.push({ path: bundledRoot(), class: "bundled" });
	return roots;
}

/** `$HOME/.claude/plugins/cache/<vendor>/<plugin>/<version>/skills`. */
export function pluginSkillRoots(home: string = homedir()): string[] {
	const cache = join(home, ".claude/plugins/cache");
	if (!existsSync(cache)) return [];
	const roots: string[] = [];
	for (const vendor of safeReaddir(cache)) {
		const vendorPath = join(cache, vendor);
		for (const plugin of safeReaddir(vendorPath)) {
			const pluginPath = join(vendorPath, plugin);
			for (const version of safeReaddir(pluginPath)) {
				const candidate = join(pluginPath, version, "skills");
				if (existsSync(candidate)) roots.push(candidate);
			}
		}
	}
	return roots.sort();
}

function safeReaddir(path: string): string[] {
	try {
		return readdirSync(path).sort();
	} catch {
		return [];
	}
}

/** Read at most `FRONTMATTER_READ_LIMIT` bytes; a 200 KB body must never be touched. */
function readHead(path: string): string {
	const descriptor = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(FRONTMATTER_READ_LIMIT);
		const bytes = readSync(descriptor, buffer, 0, FRONTMATTER_READ_LIMIT, 0);
		scanStats.files += 1;
		scanStats.bytesRead += bytes;
		return buffer.subarray(0, bytes).toString("utf8");
	} finally {
		closeSync(descriptor);
	}
}

/** The frontmatter block only; anything after the closing `---` is never parsed. */
export function frontmatterOf(head: string): string | null {
	if (!head.startsWith("---")) return null;
	const end = head.indexOf("\n---", 3);
	if (end === -1) return null;
	return head.slice(3, end);
}

function versionFromPath(path: string): string | null {
	const match = /\/cache\/[^/]+\/[^/]+\/([^/]+)\/skills\//.exec(path.replace(/\\/g, "/"));
	return match ? match[1]! : null;
}

function toRecord(name: string, root: SkillRoot, path: string, head: string): SkillRecord {
	const frontmatter = frontmatterOf(head);
	const base: SkillRecord = {
		name,
		description: "",
		tags: [],
		capabilities: [],
		risk: null,
		cost_hint: null,
		// A bundled row reports the lock's pin (an upstream version, or a content
		// pin for a skill that declares none), so `/skills` never shows it blank.
		version: root.class === "plugin" ? versionFromPath(path) : root.class === "bundled" ? packVersion(name, root.path) : null,
		source: { class: root.class, path, root: root.path },
		status: "ok",
	};
	if (frontmatter === null) {
		return { ...base, status: "invalid", error: "frontmatter block not found" };
	}
	try {
		const parsed = (parseYaml(frontmatter) ?? {}) as Record<string, unknown>;
		const list = (value: unknown): string[] =>
			Array.isArray(value) ? value.map(String) : typeof value === "string" && value.length > 0 ? [value] : [];
		return {
			...base,
			name: typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : name,
			description: typeof parsed.description === "string" ? parsed.description.trim() : "",
			tags: list(parsed.tags),
			capabilities: list(parsed.capabilities),
			risk: typeof parsed.risk === "string" ? parsed.risk : null,
			cost_hint: typeof parsed.cost_hint === "string" ? parsed.cost_hint : null,
			version: typeof parsed.version === "string" ? parsed.version : base.version,
		};
	} catch (error) {
		return { ...base, status: "invalid", error: error instanceof Error ? error.message : String(error) };
	}
}

export interface ScanOptions {
	/** Overrides the root list entirely, e.g. for a controlled fixture set. */
	roots?: SkillRoot[];
	/** `$HOME` used to resolve the default plugin roots. */
	home?: string;
}

/** Scan the roots in precedence order; the first root to claim a name wins. */
export function scanSkills(cwd: string, options: ScanOptions = {}): SkillRecord[] {
	const roots = options.roots ?? resolveConfiguredRoots(cwd, options.home);
	const byName = new Map<string, SkillRecord>();
	for (const root of roots) {
		if (!existsSync(root.path)) continue;
		for (const entry of safeReaddir(root.path)) {
			const directory = join(root.path, entry);
			try {
				if (!statSync(directory).isDirectory()) continue;
			} catch {
				continue;
			}
			const file = join(directory, "SKILL.md");
			if (!existsSync(file)) continue;
			const record = toRecord(entry, root, file, readHead(file));
			if (!byName.has(record.name)) byName.set(record.name, record);
		}
	}
	return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function resolveConfiguredRoots(cwd: string, home?: string): SkillRoot[] {
	return defaultSkillRoots(cwd, home ?? homedir());
}

/**
 * Full body, read only for skills that were actually selected. A `bundled`
 * source is hash-checked against `pack.lock.json` first: the check runs here,
 * on selection, because the registry scan deliberately never reads a body.
 */
export function loadSkillBody(record: SkillRecord): string {
	if (record.source.class === "bundled") verifyBundledFile(record.source.path, record.source.root);
	if (!existsSync(record.source.path)) return "";
	const head = readHead(record.source.path);
	const frontmatter = frontmatterOf(head);
	if (frontmatter === null) return "";
	// The body is read in full here and only here — this is the body-load step of
	// the disclosure pipeline, not the registry scan.
	return readBody(record.source.path, frontmatter.length + 8);
}

function readBody(path: string, offset: number): string {
	const descriptor = openSync(path, "r");
	try {
		const size = statSync(path).size;
		const buffer = Buffer.alloc(Math.max(size - offset, 0));
		readSync(descriptor, buffer, 0, buffer.length, offset);
		return buffer.toString("utf8").trim();
	} finally {
		closeSync(descriptor);
	}
}

export interface SkillStateEntry {
	enabled?: boolean;
	pinned?: boolean;
}

export interface SkillControl {
	/** Disable wins over pin: a disabled skill never loads, whatever its pin state. */
	isEnabled(name: string): boolean;
	isPinned(name: string): boolean;
	disable(name: string): void;
	enable(name: string): void;
	pin(name: string): { ok: boolean; message: string };
	unpin(name: string): void;
	state(): Record<string, SkillStateEntry>;
	/** Skills eligible for ranking: enabled, unpinned (pins bypass ranking). */
	candidates(records: SkillRecord[]): SkillRecord[];
	pinnedRecords(records: SkillRecord[]): SkillRecord[];
}

export function createSkillControl(initial: Record<string, SkillStateEntry> = {}, onChange?: (state: Record<string, SkillStateEntry>) => void): SkillControl {
	const state: Record<string, SkillStateEntry> = { ...initial };
	const entry = (name: string): SkillStateEntry => {
		state[name] ??= {};
		return state[name];
	};
	const commit = () => onChange?.(state);
	return {
		isEnabled: (name) => state[name]?.enabled !== false,
		isPinned: (name) => state[name]?.pinned === true && state[name]?.enabled !== false,
		disable(name) {
			entry(name).enabled = false;
			commit();
		},
		enable(name) {
			entry(name).enabled = true;
			commit();
		},
		pin(name) {
			if (state[name]?.enabled === false) {
				return { ok: false, message: `${name} is disabled; enable it before pinning (disable wins over pin)` };
			}
			entry(name).pinned = true;
			commit();
			return { ok: true, message: `${name} pinned` };
		},
		unpin(name) {
			entry(name).pinned = false;
			commit();
		},
		state: () => state,
		candidates: (records) => records.filter((record) => state[record.name]?.enabled !== false && state[record.name]?.pinned !== true),
		pinnedRecords: (records) => records.filter((record) => state[record.name]?.pinned === true && state[record.name]?.enabled !== false),
	};
}
