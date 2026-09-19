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
import { realpathSync } from "node:fs";
import { isAbsolute, resolve as resolvePath, sep } from "node:path";

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
export type DecisionSource = "user" | "project" | "builtin";

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

const DESTRUCTIVE_GIT: RegExp[] = [
	/\bgit\s+push\b[^\n]*(--force\b|\s-f\b|--delete\b)/,
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\b[^\n]*\s-[a-z]*f[a-z]*d/,
	/\bgit\s+clean\b[^\n]*\s-[a-z]*d[a-z]*f/,
	/\bgit\s+branch\b[^\n]*\s-D\b/,
	/\bgit\s+checkout\s+--\s/,
	/\bgit\s+update-ref\s+-d\b/,
];

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
	/\bgit\s+(fetch|pull|push|clone|ls-remote)\b/,
	/\bgit\s+remote\s+(update|show|set-url)\b/,
];

/** Static tool-name tables: which scope a tool name belongs to. */
const READ_TOOLS: Record<string, true> = { read: true, search: true, grep: true, find: true, ls: true };
const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, multiedit: true, multi_edit: true };
const SHELL_TOOLS: Record<string, true> = { execute: true, bash: true, shell: true, run: true, exec: true };
const SUBAGENT_TOOLS: Record<string, true> = { subagent: true, spawn_subagent: true, task: true, agent: true, delegate: true };

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

/**
 * A path whose `realpath` escapes the session root. Symlinks count: a link
 * inside the root that points outside is an out-of-root read.
 */
export function escapesRoot(root: string, candidate: string): boolean {
	if (candidate.length === 0) return false;
	const expanded = candidate.startsWith("~") ? candidate.replace(/^~/, process.env.HOME ?? "~") : candidate;
	const absolute = isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(root, expanded);
	const base = realRoot(root);
	const contained = (value: string): boolean => value === base || value.startsWith(base.endsWith(sep) ? base : base + sep);
	if (!contained(absolute)) return true;
	try {
		return !contained(realpathSync(absolute));
	} catch {
		return false;
	}
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
		const command = stringArg(input, "command", "cmd", "script") ?? "";
		add("shell", command);
		if (DESTRUCTIVE_GIT.some((pattern) => pattern.test(command))) add("git_destructive", command);
		if (PACKAGE_INSTALL.some((pattern) => pattern.test(command))) add("package_install", command);
		if (NETWORK_COMMAND.some((pattern) => pattern.test(command))) add("network", command);
		for (const token of pathTokens(command)) {
			if (escapesRoot(root, token)) add("external_dir", token);
		}
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

	add("shell", toolName);
	return scopes;
}
