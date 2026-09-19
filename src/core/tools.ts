/**
 * Baseline tool surface (PRD-001 Phase 1, ROADMAP §44).
 *
 * LeanPi exposes exactly five tools — read, search, edit, write, execute — and
 * delegates each to Pi's own implementation rather than reimplementing it.
 * Additional capabilities are routed internally (§44) instead of permanently
 * widening the model's tool surface.
 */
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@mariozechner/pi-coding-agent";

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

export function baselineToolDefinitions(cwd: string): ToolDefinition[] {
	const definitions: ToolDefinition[] = [];
	for (const name of BASELINE_TOOL_NAMES) {
		const definition = BASELINE_TOOL_MAP[name](cwd) as unknown as ToolDefinition;
		definitions.push(definition.name === name ? definition : { ...definition, name, label: name });
	}
	return definitions;
}

/** Registers the five baseline tools on the extension. Returns the names for the session allowlist. */
export function registerBaselineTools(pi: ExtensionAPI, cwd: string): string[] {
	for (const definition of baselineToolDefinitions(cwd)) pi.registerTool(definition);
	return [...BASELINE_TOOL_NAMES];
}
