/**
 * Baseline tool surface (PRD-001 Phase 1, ROADMAP §44).
 *
 * LeanPi exposes exactly five tools — read, search, edit, write, execute — and
 * delegates each to Pi's own implementation rather than reimplementing it.
 * Additional capabilities are routed internally (§44) instead of permanently
 * widening the model's tool surface.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** LeanPi name → the Pi tool definition it delegates to. */
export const BASELINE_TOOL_MAP = {
	read: createReadToolDefinition,
	search: createGrepToolDefinition,
	edit: createEditToolDefinition,
	write: createWriteToolDefinition,
	execute: createBashToolDefinition,
} as const;

export type BaselineToolName = keyof typeof BASELINE_TOOL_MAP;

export const BASELINE_TOOL_NAMES = Object.keys(BASELINE_TOOL_MAP) as BaselineToolName[];

/**
 * The ceiling on one shell command, in seconds.
 *
 * Pi's schema makes `timeout` optional with **no default**, so a command that
 * waits — a test runner blocked on a lock, a package manager waiting on the
 * network — waits forever and takes the turn with it. Measured on the bench
 * path: one agent-issued `npx eslint … && npm test` sat for 14 minutes with zero
 * CPU time and voided a whole suite run, because nothing bounded it. A
 * model-supplied timeout still wins; this is only the ceiling when the model
 * names none.
 */
export const COMMAND_TIMEOUT_SECONDS_DEFAULT = 900;

/** The same definition with a timeout the model did not supply. */
export function boundedCommand(definition: ToolDefinition, seconds: number = COMMAND_TIMEOUT_SECONDS_DEFAULT): ToolDefinition {
	const execute = definition.execute.bind(definition);
	return {
		...definition,
		execute: (toolCallId, params, signal, onUpdate, ctx) => {
			const named = (params as { timeout?: number } | undefined)?.timeout;
			return execute(toolCallId, { ...(params as object), timeout: named ?? seconds } as never, signal, onUpdate, ctx);
		},
	};
}

export function baselineToolDefinitions(cwd: string): ToolDefinition[] {
	const definitions: ToolDefinition[] = [];
	for (const name of BASELINE_TOOL_NAMES) {
		const raw = BASELINE_TOOL_MAP[name](cwd) as unknown as ToolDefinition;
		const definition = raw.name === name ? raw : { ...raw, name, label: name };
		definitions.push(name === "execute" ? boundedCommand(definition) : definition);
	}
	return definitions;
}

/** Registers the five baseline tools on the extension. Returns the names for the session allowlist. */
export function registerBaselineTools(pi: ExtensionAPI, cwd: string): string[] {
	for (const definition of baselineToolDefinitions(cwd)) pi.registerTool(definition);
	return [...BASELINE_TOOL_NAMES];
}
