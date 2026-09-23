/**
 * Permission scopes, the ordered rule list and the classification table
 * (PRD-017 Phase 1, ROADMAP §47 / FR-085 / FR-147).
 *
 * Authorization is a deterministic function of configuration: there is no model
 * judgement here, so a `deny` is a `deny` on every run. One dispatched call
 * implicates a *set* of scopes, so classification returns a set and the caller
 * takes the strictest outcome — `shell: allow` therefore cannot buy network
 * egress, a package install or an out-of-root read.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve as resolvePath, sep } from "node:path";

export const SCOPES = [
	"read",
	"edit",
	"shell",
	"network",
	"mcp",
	"external_dir",
	"subagent",
	"git_destructive",
	"package_install",
] as const;

export type Scope = (typeof SCOPES)[number];

export const PERMISSION_DECISIONS = ["allow", "ask", "deny"] as const;

export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

/** Where a decision came from; `/permissions` renders this verbatim. */
export type DecisionSource = "user" | "project" | "builtin" | "safety";

export const DECISION_RANK: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 };

/** ROADMAP §47's conservative column: nothing destructive is reachable by default. */
export const BUILTIN_DEFAULTS: Record<Scope, PermissionDecision> = {
	read: "allow",
	edit: "ask",
	shell: "ask",
	network: "ask",
	mcp: "ask",
	external_dir: "deny",
	subagent: "ask",
	git_destructive: "deny",
	package_install: "ask",
};

export const SAFETY_LEVELS = ["low", "medium", "high"] as const;

export type SafetyLevel = (typeof SAFETY_LEVELS)[number];

export function isSafetyLevel(value: string): value is SafetyLevel {
	return (SAFETY_LEVELS as readonly string[]).includes(value);
}

/**
 * `--safety <level>`: one named policy that replaces every other source.
 *
 * Off unless the flag is passed, and when it is passed it is the whole answer —
 * the stored user scope, the project block and every capability rule are
 * ignored, because a level that a forgotten `/permissions set` could undercut
 * would not be a level at all.
 *
 * `low` is the no-prompt profile; `medium` is the conservative column above;
 * `high` reads and asks before an edit, and nothing else runs.
 */
export const SAFETY_PROFILES: Record<SafetyLevel, Record<Scope, PermissionDecision>> = {
	low: Object.fromEntries(SCOPES.map((scope) => [scope, "allow"])) as Record<Scope, PermissionDecision>,
	medium: BUILTIN_DEFAULTS,
	high: {
		read: "allow",
		edit: "ask",
		shell: "deny",
		network: "deny",
		mcp: "deny",
		external_dir: "deny",
		subagent: "deny",
		git_destructive: "deny",
		package_install: "deny",
	},
};

export interface PermissionRule {
	/** `<scope>:<target>`, target matched with a plain glob. */
	capability: string;
	decision: PermissionDecision;
	source: DecisionSource;
}

/** A project-scope request that was rejected because project scope may only tighten. */
export interface IgnoredProjectGrant {
	capability: string;
	decision: PermissionDecision;
	reason: string;
}

/** The effective, already-merged permission configuration the guard resolves against. */
export interface PermissionsConfig {
	defaults: Record<Scope, PermissionDecision>;
	defaultSources: Record<Scope, DecisionSource>;
	rules: PermissionRule[];
	ignoredProjectGrants: IgnoredProjectGrant[];
}

export function isScope(value: string): value is Scope {
	return (SCOPES as readonly string[]).includes(value);
}

export function isPermissionDecision(value: string): value is PermissionDecision {
	return (PERMISSION_DECISIONS as readonly string[]).includes(value);
}

/** `shell:git push --force*` → `{ scope: "shell", target: "git push --force*" }`. */
export function parseCapability(capability: string): { scope: Scope; target: string } | null {
	const separator = capability.indexOf(":");
	const scope = separator === -1 ? capability : capability.slice(0, separator);
	if (!isScope(scope)) return null;
	return { scope, target: separator === -1 ? "" : capability.slice(separator + 1) };
}

export function capabilityId(scope: Scope, target: string): string {
	return `${scope}:${target}`;
}

/** Plain glob: `*` matches any run of characters, `?` one. Everything else is literal. */
export function globMatch(pattern: string, value: string): boolean {
	let regex = "";
	for (const character of pattern) {
		if (character === "*") regex += ".*";
		else if (character === "?") regex += ".";
		else regex += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${regex}$`).test(value);
}

/** Length of a glob's literal prefix; the most specific rule is the longest one. */
export function literalPrefixLength(pattern: string): number {
	const wildcard = pattern.search(/[*?]/);
	return wildcard === -1 ? pattern.length : wildcard;
}

export interface Resolution {
	capability: string;
	decision: PermissionDecision;
	source: DecisionSource;
	/** The rule that decided it, when a rule matched. */
	matchedRule?: string;
}

export function builtinPermissions(): PermissionsConfig {
	return {
		defaults: { ...BUILTIN_DEFAULTS },
		defaultSources: Object.fromEntries(SCOPES.map((scope) => [scope, "builtin" as DecisionSource])) as Record<
			Scope,
			DecisionSource
		>,
		rules: [],
		ignoredProjectGrants: [],
	};
}

/**
 * Most specific matching rule wins (longest literal prefix), then the scope
 * default, then the built-in default. Ties between equally specific rules go to
 * the stricter one, so rule ordering can never loosen an outcome.
 */
export function resolve(capability: string, config: PermissionsConfig): Resolution {
	const parsed = parseCapability(capability);
	let best: PermissionRule | undefined;
	let bestPrefix = -1;
	for (const rule of config.rules) {
		if (!globMatch(rule.capability, capability)) continue;
		const prefix = literalPrefixLength(rule.capability);
		if (best === undefined || prefix > bestPrefix || (prefix === bestPrefix && DECISION_RANK[rule.decision] > DECISION_RANK[best.decision])) {
			best = rule;
			bestPrefix = prefix;
		}
	}
	if (best) {
		return { capability, decision: best.decision, source: best.source, matchedRule: best.capability };
	}
	if (!parsed) return { capability, decision: "deny", source: "builtin" };
	return { capability, decision: config.defaults[parsed.scope], source: config.defaultSources[parsed.scope] };
}

export interface AggregateResolution {
	decision: PermissionDecision;
	/** The resolution that produced the strictest decision; its scope is named in the refusal. */
	deciding: Resolution;
	resolutions: Resolution[];
}

/** The strictest decision across every scope a call implicates (`deny` > `ask` > `allow`). */
export function resolveAll(capabilities: string[], config: PermissionsConfig): AggregateResolution {
	const resolutions = capabilities.map((capability) => resolve(capability, config));
	let deciding = resolutions[0] ?? { capability: "", decision: "allow" as PermissionDecision, source: "builtin" as DecisionSource };
	for (const resolution of resolutions) {
		if (DECISION_RANK[resolution.decision] > DECISION_RANK[deciding.decision]) deciding = resolution;
	}
	return { decision: deciding.decision, deciding, resolutions };
}

// ---------------------------------------------------------------------------
// Classification table
// ---------------------------------------------------------------------------

export interface CallShape {
	toolName: string;
	input: Record<string, unknown>;
}

export interface ClassifiedScope {
	scope: Scope;
	target: string;
	capability: string;
}

const PACKAGE_INSTALL: RegExp[] = [
	/\b(npm|pnpm|yarn|bun)\b[^\n]*\b(install|add|i)\b/,
	/\bpip3?\s+install\b/,
	/\bcargo\s+install\b/,
	/\bgo\s+install\b/,
	/\bgem\s+install\b/,
	/\b(apt|apt-get|brew|pacman|dnf|yum|zypper)\b[^\n]*\binstall\b/,
];

const NETWORK_COMMAND: RegExp[] = [
	/\b(curl|wget|nc|netcat|telnet|ssh|scp|sftp)\b/,
	/\brsync\b[^\n]*(@[^\s]+:|[^\s/]+:\S)/,
];

/** git global options that eat the next token; the `=x` spellings eat nothing. */
const GIT_GLOBAL_VALUE: Record<string, true> = { "-C": true, "-c": true, "--git-dir": true, "--work-tree": true, "--exec-path": true };

/**
 * The `git` subcommand and its arguments with git's own global options
 * consumed, so `git -C . push --force` reads as a push. A token table, not a
 * shell parser: an option table we cannot step over yields `null` (no claim).
 */
function gitInvocation(command: string): { subcommand: string; args: string[] } | null {
	const tokens = command
		.split(/[\s|&;()<>`]+/)
		.map((token) => token.replace(/^['"]+|['"]+$/g, ""))
		.filter((token) => token.length > 0);
	const start = tokens.indexOf("git");
	if (start === -1) return null;
	let index = start + 1;
	while (tokens[index]?.startsWith("-")) index += GIT_GLOBAL_VALUE[tokens[index]!] ? 2 : 1;
	const subcommand = tokens[index];
	if (subcommand === undefined) return null;
	return { subcommand, args: tokens.slice(index + 1) };
}

/** `-fd` carries both `f` and `d`, and `-f -d` carries them apart. */
function hasShortFlag(args: string[], letter: string): boolean {
	return args.some((arg) => arg.length > 1 && arg.startsWith("-") && !arg.startsWith("--") && arg.includes(letter));
}

/** `+refspec` and `--force-with-lease` force a push just as `--force` does. */
function gitIsDestructive({ subcommand, args }: { subcommand: string; args: string[] }): boolean {
	switch (subcommand) {
		case "push":
			return args.some((arg) => arg.startsWith("+") || arg === "--force" || arg === "-f" || arg === "--delete" || arg.startsWith("--force-"));
		case "reset":
			return args.includes("--hard");
		case "clean":
			return (args.includes("--force") || hasShortFlag(args, "f")) && (args.includes("--directory") || hasShortFlag(args, "d"));
		case "branch":
			return args.includes("-D");
		case "checkout":
			return args.includes("--");
		case "update-ref":
			return args.includes("-d");
		default:
			return false;
	}
}

function gitIsNetwork({ subcommand, args }: { subcommand: string; args: string[] }): boolean {
	if (subcommand === "fetch" || subcommand === "pull" || subcommand === "push" || subcommand === "clone" || subcommand === "ls-remote") return true;
	return subcommand === "remote" && ["update", "show", "set-url"].includes(args[0] ?? "");
}

/** Static tool-name tables: which scope a tool name belongs to. */
const READ_TOOLS: Record<string, true> = { read: true, search: true, grep: true, find: true, ls: true };
const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, multiedit: true, multi_edit: true };
// `bash` is Pi's built-in shell, overridden by `pi-patty-bg-tasks`; `bash_bg` is
// that package's fire-and-forget form. Both run a `command` and share the
// classification below — an unclassified tool would reach the catch-all as
// `shell:<toolName>` and lose the network/install/out-of-root scopes.
const SHELL_TOOLS: Record<string, true> = { execute: true, bash: true, bash_bg: true, shell: true, run: true, exec: true };
const SUBAGENT_TOOLS: Record<string, true> = { subagent: true, spawn_subagent: true, task: true, agent: true, delegate: true, agent_bg: true };

function stringArg(input: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** MCP tools travel as `mcp__server__tool`, `mcp:server/tool` or `<server>/<tool>` (PRD-006). */
export function mcpTargetOf(toolName: string, input: Record<string, unknown>): { server: string; tool: string } | null {
	const explicitServer = stringArg(input, "server", "serverName");
	const explicitTool = stringArg(input, "tool", "toolName");
	if (explicitServer && explicitTool) return { server: explicitServer, tool: explicitTool };
	if (toolName.startsWith("mcp__")) {
		const [, server, ...rest] = toolName.split("__");
		if (server && rest.length > 0) return { server, tool: rest.join("__") };
	}
	if (toolName.startsWith("mcp:")) {
		const rest = toolName.slice(4);
		const separator = rest.indexOf("/");
		if (separator > 0) return { server: rest.slice(0, separator), tool: rest.slice(separator + 1) };
	}
	if (toolName.includes("/")) {
		const [server, ...rest] = toolName.split("/");
		if (server && rest.length > 0) return { server, tool: rest.join("/") };
	}
	return null;
}

/** The first path-like argument of a read/edit call. */
function pathArg(input: Record<string, unknown>): string | undefined {
	return stringArg(input, "path", "file", "file_path", "filePath", "target");
}

function realRoot(root: string): string {
	try {
		return realpathSync(root);
	} catch {
		return resolvePath(root);
	}
}

/** A dangling link: `lstat` sees it where `realpath` gives up with ENOENT. */
function linkTarget(path: string): string | null {
	try {
		return lstatSync(path).isSymbolicLink() ? resolvePath(dirname(path), readlinkSync(path)) : null;
	} catch {
		return null;
	}
}

/**
 * `realpath` of the deepest existing ancestor with the not-yet-created tail
 * re-appended, so `link/new.txt` is judged by where `link` actually points.
 * `null` is an unexpected failure (a symlink cycle, an unreadable ancestor):
 * the caller fails closed rather than guessing.
 */
function canonicalize(absolute: string): string | null {
	let current = absolute;
	let missing: string[] = [];
	// Bounded: a cycle of dangling links would otherwise loop for ever.
	for (let hops = 0; hops < 40; hops++) {
		try {
			const real = realpathSync(current);
			return missing.length === 0 ? real : resolvePath(real, ...missing.reverse());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// Nothing exists below a missing or non-directory component: walk up.
			if (code !== "ENOENT" && code !== "ENOTDIR") return null;
			const target = linkTarget(current);
			if (target !== null) {
				current = missing.length === 0 ? target : resolvePath(target, ...missing);
				missing = [];
				continue;
			}
			const parent = dirname(current);
			if (parent === current) return null;
			missing.push(basename(current));
			current = parent;
		}
	}
	return null;
}

/**
 * A path whose `realpath` escapes the session root. Symlinks count: a link
 * inside the root that points outside is an out-of-root read. The candidate is
 * resolved against the canonical root, so a symlinked session root does not
 * deny its own files, and the deepest existing ancestor is canonicalized, so a
 * leaf that does not exist yet cannot smuggle a write out through a link.
 */
export function escapesRoot(root: string, candidate: string): boolean {
	if (candidate.length === 0) return false;
	const expanded = candidate.startsWith("~") ? candidate.replace(/^~/, process.env.HOME ?? "~") : candidate;
	const base = realRoot(root);
	const absolute = isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(base, expanded);
	const canonical = canonicalize(absolute);
	// Fail closed: an ancestor we cannot canonicalize is not evidence of "in root".
	if (canonical === null) return true;
	const prefix = base.endsWith(sep) ? base : base + sep;
	return canonical !== base && !canonical.startsWith(prefix);
}

function looksLikePath(token: string): boolean {
	if (token.length === 0 || token.startsWith("-")) return false;
	if (token.includes("://")) return false;
	return token.startsWith("~") || isAbsolute(token) || token.startsWith("./") || token.startsWith("../") || token.includes("/");
}

/** Split a command line into candidate path tokens; a table, not a shell parser. */
export function pathTokens(command: string): string[] {
	return command
		.split(/[\s|&;()<>`]+/)
		.map((token) => token.replace(/^['"]+|['"]+$/g, ""))
		.filter(looksLikePath);
}

/**
 * Every scope one shell command implicates, added through `add` (PRD-017 AC-13,
 * AC-15, AC-5). Shared by `execute`/`bash`/`bash_bg` and `monitor`'s command
 * source, so a second background form cannot slip past the reach the first one
 * is held to.
 */
function classifyCommand(command: string, root: string, add: (scope: Scope, target: string) => void): void {
	add("shell", command);
	const git = command.includes("git") ? gitInvocation(command) : null;
	if (git !== null && gitIsDestructive(git)) add("git_destructive", command);
	if (PACKAGE_INSTALL.some((pattern) => pattern.test(command))) add("package_install", command);
	if (NETWORK_COMMAND.some((pattern) => pattern.test(command)) || (git !== null && gitIsNetwork(git))) add("network", command);
	for (const token of pathTokens(command)) {
		if (escapesRoot(root, token)) add("external_dir", token);
	}
}

/**
 * Every scope one dispatched call implicates, one `<scope>:<target>` capability
 * id per member. An unrecognised command line is `{shell}` alone; an
 * unrecognised tool is treated as shell reach, the conservative catch-all.
 */
export function classifyScopes(call: CallShape, root: string): ClassifiedScope[] {
	const scopes: ClassifiedScope[] = [];
	const seen = new Set<string>();
	const add = (scope: Scope, target: string): void => {
		const capability = capabilityId(scope, target);
		if (seen.has(capability)) return;
		seen.add(capability);
		scopes.push({ scope, target, capability });
	};

	const toolName = call.toolName;
	const input = call.input ?? {};

	if (READ_TOOLS[toolName] || EDIT_TOOLS[toolName]) {
		const scope: Scope = EDIT_TOOLS[toolName] ? "edit" : "read";
		const path = pathArg(input);
		add(scope, path ?? toolName);
		// A path outside the session root is never a plain read or edit.
		if (path && escapesRoot(root, path)) add("external_dir", path);
		return scopes;
	}

	if (SHELL_TOOLS[toolName]) {
		classifyCommand(stringArg(input, "command", "cmd", "script") ?? "", root, add);
		return scopes;
	}

	// `pi-patty-bg-tasks`' `monitor` streams a command's stdout or a WebSocket
	// feed. The command source is shell reach like any other; the `ws` source is
	// network egress, which `shell: allow` must not buy.
	if (toolName === "monitor") {
		const command = stringArg(input, "command", "cmd", "script");
		const ws = input.ws as { url?: unknown } | undefined;
		const url = typeof ws?.url === "string" ? ws.url : undefined;
		if (command !== undefined) classifyCommand(command, root, add);
		if (url !== undefined) add("network", url);
		if (command === undefined && url === undefined) add("shell", toolName);
		return scopes;
	}

	if (SUBAGENT_TOOLS[toolName]) {
		add("subagent", stringArg(input, "name", "agent", "role", "subagent") ?? toolName);
		return scopes;
	}

	const mcp = mcpTargetOf(toolName, input);
	if (mcp) {
		add("mcp", `${mcp.server}/${mcp.tool}`);
		return scopes;
	}

	// PRD-045's mid-turn router asks for an MCP capability; it resolves under the
	// `mcp` scope like the tools it can admit, not as shell reach.
	if (toolName === "mcp_request") {
		add("mcp", toolName);
		return scopes;
	}

	add("shell", toolName);
	return scopes;
}
