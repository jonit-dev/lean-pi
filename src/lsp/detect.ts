/**
 * Language-server detection (PRD-018 Phase 2, FR-090).
 *
 * A small static table, probed against `PATH` and the project's local
 * `node_modules/.bin`, with `LeanPiConfig.lsp.servers` overrides honored first.
 * An absent server is an *absent entry with a reason*, never a thrown error —
 * step 2 of mode selection degrades on it and `LSP_OFF` is a first-class
 * outcome. Nothing here starts a process: no installer, no bundled server, no
 * download; LeanPi uses what the user already has.
 */
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { LeanPiConfig } from "../core/types.js";
import { lspConfigOf } from "./config.js";

/** Language id → server command lines, in preference order. Args after the executable are passed through. */
export const LSP_SERVER_COMMANDS: Record<string, string[]> = {
	typescript: ["typescript-language-server --stdio"],
	javascript: ["typescript-language-server --stdio"],
	python: ["pyright-langserver --stdio", "pylsp"],
	rust: ["rust-analyzer"],
	go: ["gopls"],
	c: ["clangd"],
	cpp: ["clangd"],
};

/** Extension → language id. A language absent here has no server this module detects. */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".pyi": "python",
	".rs": "rust",
	".go": "go",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	// Non-server languages: they take part in the change set (so a Markdown-only
	// change is visible as a language with no server) but never contribute one.
	".md": "markdown",
	".mdx": "markdown",
	".json": "json",
	".yaml": "yaml",
	".yml": "yaml",
};

export function languageOfPath(path: string): string | null {
	const match = /(\.[^./\\]+)$/.exec(path.replace(/\\/g, "/"));
	if (!match) return null;
	return LANGUAGE_BY_EXTENSION[match[1]!.toLowerCase()] ?? null;
}

export interface DetectOptions {
	config?: LeanPiConfig;
	env?: NodeJS.ProcessEnv;
}

export interface DetectedServer {
	language: string;
	/** The command line that resolved, as named in the table or config. */
	command: string;
	/** Arguments after the executable. */
	args: string[];
	/** The executable that will be spawned. */
	path: string;
	source: "config" | "path" | "local-bin";
}

/** Disposition of a language: a resolved server, or the reason there is none. */
export type ServerLookup = { ok: true; server: DetectedServer } | { ok: false; reason: string };

function isExecutableFile(path: string): boolean {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return false;
		// A Windows shim carries no mode bits; elsewhere a file that cannot be
		// executed is not a server.
		return process.platform === "win32" || (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

interface ProbeDir {
	path: string;
	source: "path" | "local-bin";
}

/** Discovery order: the project's own bin dir first, then PATH. */
function probeDirs(root: string, env: NodeJS.ProcessEnv): ProbeDir[] {
	const dirs: ProbeDir[] = [{ path: join(root, "node_modules/.bin"), source: "local-bin" }];
	for (const entry of (env.PATH ?? env.Path ?? "").split(delimiter)) {
		if (entry.length > 0) dirs.push({ path: entry, source: "path" });
	}
	return dirs;
}

function resolveCommand(root: string, command: string, env: NodeJS.ProcessEnv): { path: string; source: DetectedServer["source"] } | null {
	if (isAbsolute(command)) return isExecutableFile(command) ? { path: command, source: "config" } : null;
	for (const dir of probeDirs(root, env)) {
		for (const candidate of [command, `${command}.cmd`, `${command}.exe`]) {
			const path = join(dir.path, candidate);
			if (isExecutableFile(path)) return { path, source: dir.source };
		}
	}
	return null;
}

/** True when `command` resolves on this machine's PATH — the test-skip guard. */
export function commandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return resolveCommand(process.cwd(), command, env) !== null;
}

/** The command list for a language: the config override first, the table otherwise. */
export function serverCommandsFor(language: string, config?: LeanPiConfig): string[] {
	const override = lspConfigOf(config).servers[language];
	if (override !== undefined) return [override];
	return LSP_SERVER_COMMANDS[language] ?? [];
}

/** Availability probe for one language. Never throws. */
export function lookupServer(root: string, language: string, options: DetectOptions = {}): ServerLookup {
	const env = options.env ?? process.env;
	const commands = serverCommandsFor(language, options.config);
	if (commands.length === 0) return { ok: false, reason: `no language server is defined for "${language}"` };
	for (const command of commands) {
		const [executable, ...args] = command.split(/\s+/).filter((token) => token.length > 0);
		if (executable === undefined) continue;
		const resolved = resolveCommand(root, executable, env);
		if (resolved === null) continue;
		return { ok: true, server: { language, command, args, path: resolved.path, source: resolved.source } };
	}
	return {
		ok: false,
		reason: `no language server for "${language}": looked for ${commands.join(", ")} on PATH and ${join(root, "node_modules/.bin")}`,
	};
}

/** Every language with a server on this machine, plus config-declared ones. */
export function detectServers(root: string, options: DetectOptions = {}): DetectedServer[] {
	const declared = Object.keys(lspConfigOf(options.config).servers).filter((language) => LSP_SERVER_COMMANDS[language] === undefined);
	const found: DetectedServer[] = [];
	for (const language of [...Object.keys(LSP_SERVER_COMMANDS), ...declared]) {
		const lookup = lookupServer(root, language, options);
		if (lookup.ok) found.push(lookup.server);
	}
	return found;
}
