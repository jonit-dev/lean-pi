/**
 * `/config` — the resolved configuration with per-key provenance (PRD-016 Phase 1, AC-3).
 *
 * Read-only by design: config edits happen in the file, where they are
 * diffable and reviewable. Values come from the loader's own resolution result,
 * so the `value` column cannot drift from what LeanPi actually applied;
 * provenance is decided by whether the project file declares the leaf, which is
 * the only source scope this loader has. Secrets are rendered `<set>`/`<unset>`
 * and never printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { CommandRegistry, CommandResult } from "./registry.js";
import type { CommandSurface } from "./surface.js";

/** The documented defaults of PRD-001's loader: what a project file overrides. */
const DEFAULT_VALUES: Record<string, unknown> = {
	"instructions.ponytail": true,
	"jev.mode": "enabled",
	"jev.endpoint": "https://api.typesafe.ai/v1/systemone",
	"jev.model": "jev-latest",
	"jev.apiKey": null,
	"skills.maxLoaded": 3,
	"skills.state": {},
	"bench.skills.maxUnnecessaryLoadRate": 0.04,
	"capabilities.skillRoots": [],
	"capabilities.mcpConfigPaths": [],
	"context.artifact_threshold_bytes": 32768,
	"context.compaction_threshold_bytes": 48000,
	"context.working_state_max_bytes": 3000,
	"lsp.mode": "auto",
	"lsp.servers": {},
	"thresholds.gate_prd_required": 0.5,
	"thresholds.complexity": 0.5,
	"thresholds.review_risk": 0.5,
	// Unconfigured, both ceilings stay absent and the compiler derives a bound
	// from the task's complexity — so the value a project override displaces is
	// that derived bound, not a fixed number.
	"limits.executionAttempts": "complexity-derived",
	"limits.semanticReviewRounds": "complexity-derived",
};

/** Subtrees another command owns, or that carry no provenance of their own. */
const SKIPPED_PREFIXES = ["configPath", "permissions", "mcp"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flatten(value: unknown, prefix: string, into: Map<string, unknown>): void {
	if (isPlainObject(value)) {
		const entries = Object.entries(value);
		if (entries.length === 0) {
			into.set(prefix, value);
			return;
		}
		for (const [key, child] of entries) flatten(child, prefix.length > 0 ? `${prefix}.${key}` : key, into);
		return;
	}
	into.set(prefix, value);
}

function render(value: unknown): string {
	if (value === undefined) return "<unset>";
	if (value === null) return "null";
	if (typeof value === "string") return value;
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function equal(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function renderConfig(surface: CommandSurface): string {
	const resolved = new Map<string, unknown>();
	flatten(surface.config, "", resolved);

	const declared = new Map<string, unknown>();
	const path = surface.config.configPath;
	if (path && existsSync(path)) {
		const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
		flatten(parsed ?? {}, "", declared);
	}

	const rows: string[][] = [["key", "value", "source", "losing value"]];
	for (const key of [...resolved.keys()].filter((key) => !SKIPPED_PREFIXES.some((skip) => key === skip || key.startsWith(`${skip}.`))).sort()) {
		if (/apiKey$/i.test(key)) rows.push([key, resolved.get(key) ? "<set>" : "<unset>", resolved.get(key) ? "project/runtime" : "unset", "<unset>"]);
		else if (declared.has(key)) rows.push([key, render(resolved.get(key)), `project ${path}`, render(DEFAULT_VALUES[key])]);
		else if (key in DEFAULT_VALUES && equal(resolved.get(key), DEFAULT_VALUES[key])) rows.push([key, render(resolved.get(key)), "built-in default", "—"]);
		else rows.push([key, render(resolved.get(key)), "runtime", render(DEFAULT_VALUES[key])]);
	}

	const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? "").length)));
	const table = rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n");
	return [`project config: ${path ?? "<none>"}`, table].join("\n");
}

export function registerConfigCommand(registry: CommandRegistry, surface: CommandSurface): void {
	registry.register({
		name: "config",
		summary: "show the resolved configuration and which file each value came from",
		usage: "/config",
		run: (): CommandResult => ({ ok: true, text: renderConfig(surface) }),
	});
}
