/**
 * The RTK profile and its deterministic output-class rule (PRD-019, ROADMAP §19).
 *
 * Output reduction is *available and safe* here, never default: the rule below is
 * the shipped decision, and the only thing that can move the mode to `on` is a
 * recorded measurement (`resolveRtkDefault`, PRD-019 Phase 3) — this module holds
 * no default-mode literal at all.
 *
 * `rtkConfigOf()` reads the `rtk:` block structurally, the way PRD-015 reads
 * `cost:`: the keys are declared here with their defaults and a config that has
 * no `rtk:` block behaves exactly like `rtk: auto` with reduction never firing
 * below the floor. No config key is added by this module.
 */
import { createHash } from "node:crypto";
import type { LeanPiConfig } from "../core/types.js";

/** ROADMAP §19's four modes. */
export const RTK_MODES = ["off", "on", "auto", "experiment"] as const;

export type RtkMode = (typeof RTK_MODES)[number];

/** The two arms FR-112's A/B comparison is between; `experiment` assigns one per task. */
export type RtkArm = "off" | "on";

/** Tool kinds whose output is a log a reducer can summarize. */
export const REDUCIBLE_KINDS = ["shell", "test", "build", "lint"] as const;

export type RtkToolKind = (typeof REDUCIBLE_KINDS)[number] | "grep" | "search" | "read" | "json" | "other";

export interface RtkConfig {
	/**
	 * An explicit `rtk.mode` setting only. `undefined` means "ask the recorded
	 * measurement", which is what keeps the measurement the owner of the default.
	 */
	mode?: RtkMode;
	/** Bare command name; discovery is `PATH`'s job, no absolute path is hard-coded. */
	binary: string;
	args: string[];
	timeout_ms: number;
	/**
	 * The minimum-size floor: `on` reduces everything at or above it, `auto`
	 * additionally requires `min_lines` and an unstructured shape.
	 */
	min_bytes: number;
	min_lines: number;
	/** `[low, high)` byte range in which the optional JEV site may overrule the rule. */
	ambiguous_band_bytes: readonly [number, number];
	/** Off by default: the ★★☆☆☆ site is measurable, not shipped. */
	jev_policy: boolean;
}

/** The documented defaults; `mode` is deliberately absent — the measurement file owns it. */
export const RTK_DEFAULTS: Omit<RtkConfig, "mode"> = {
	binary: "rtk",
	args: [],
	timeout_ms: 5_000,
	min_bytes: 16_384,
	min_lines: 200,
	ambiguous_band_bytes: [16_384, 65_536],
	jev_policy: false,
};

function numberOf(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Read the `rtk:` surface out of a loaded config; a malformed field keeps its default. */
export function rtkConfigOf(config?: LeanPiConfig | null): RtkConfig {
	const raw = (config as { rtk?: Record<string, unknown> } | null | undefined)?.rtk ?? {};
	const mode = raw.mode;
	const band = raw.ambiguous_band_bytes;
	return {
		...(typeof mode === "string" && (RTK_MODES as readonly string[]).includes(mode) ? { mode: mode as RtkMode } : {}),
		binary: typeof raw.binary === "string" && raw.binary.length > 0 ? raw.binary : RTK_DEFAULTS.binary,
		args: Array.isArray(raw.args) ? raw.args.filter((value): value is string => typeof value === "string") : [...RTK_DEFAULTS.args],
		timeout_ms: numberOf(raw.timeout_ms, RTK_DEFAULTS.timeout_ms),
		min_bytes: numberOf(raw.min_bytes, RTK_DEFAULTS.min_bytes),
		min_lines: numberOf(raw.min_lines, RTK_DEFAULTS.min_lines),
		ambiguous_band_bytes:
			Array.isArray(band) && band.length === 2 && typeof band[0] === "number" && typeof band[1] === "number"
				? [band[0], band[1]]
				: RTK_DEFAULTS.ambiguous_band_bytes,
		jev_policy: raw.jev_policy === true,
	};
}

/**
 * The `experiment` arm: a stable hash of the task id, so a resumed session keeps
 * its arm and both arms accumulate comparable data during ordinary use.
 */
export function armOf(taskId: string | undefined): RtkArm {
	if (taskId === undefined || taskId.length === 0) return "off";
	return (createHash("sha256").update(taskId).digest()[0]! & 1) === 1 ? "on" : "off";
}

const KIND_ALIASES: Record<string, RtkToolKind> = {
	shell: "shell",
	bash: "shell",
	exec: "shell",
	execute: "shell",
	command: "shell",
	test: "test",
	tests: "test",
	vitest: "test",
	jest: "test",
	build: "build",
	compile: "build",
	tsc: "build",
	lint: "lint",
	eslint: "lint",
	grep: "grep",
	search: "search",
	read: "read",
	json: "json",
};

/** A tool's free-text kind, mapped onto the classes the rule and §57's metrics use. */
export function classifyKind(kind?: string): RtkToolKind {
	if (kind === undefined) return "other";
	const normalized = kind.trim().toLowerCase();
	if (normalized in KIND_ALIASES) return KIND_ALIASES[normalized]!;
	// `shell:pnpm test` and `test:unit` carry their class as a prefix.
	const prefix = normalized.split(/[:/]/)[0]!;
	return KIND_ALIASES[prefix] ?? "other";
}

/** Machine-readable output is not safely summarizable; parsing is only attempted above the floor. */
export function looksStructured(output: string): boolean {
	const trimmed = output.trim();
	if (trimmed.length === 0) return false;
	const first = trimmed[0]!;
	if (first !== "{" && first !== "[") return false;
	try {
		JSON.parse(trimmed);
		return true;
	} catch {
		return false;
	}
}

export interface OutputClass {
	kind: RtkToolKind;
	bytes: number;
	lines: number;
	structured: boolean;
}

/** The three facts the rule and the JEV question are stated over. */
export function outputClassOf(output: string, kind?: string): OutputClass {
	return {
		kind: classifyKind(kind),
		bytes: Buffer.byteLength(output, "utf8"),
		lines: output.length === 0 ? 0 : output.split("\n").length,
		structured: !(REDUCIBLE_KINDS as readonly string[]).includes(classifyKind(kind)) || looksStructured(output),
	};
}

export interface RuleDecision {
	decision: "reduce" | "keep_raw";
	reason: string;
	/** True inside the configured ambiguous band, where the optional JEV site may overrule. */
	ambiguous: boolean;
}

/** The three settings the rule reads; the site's fallback has no binary or timeout to supply. */
export type RtkRuleConfig = Pick<RtkConfig, "min_bytes" | "min_lines" | "ambiguous_band_bytes">;

/**
 * The primary decision, and the only implementation of it: the JEV site's
 * registered fallback calls this, so "off" and "JEV unavailable" answer
 * identically by construction.
 */
export function decideReduction(output: OutputClass, config: RtkRuleConfig): RuleDecision {
	const [low, high] = config.ambiguous_band_bytes;
	const ambiguous = output.bytes >= low && output.bytes < high;
	if (output.bytes < config.min_bytes) {
		return { decision: "keep_raw", reason: `below the ${config.min_bytes}-byte floor`, ambiguous: false };
	}
	if (output.structured) {
		return { decision: "keep_raw", reason: `${output.kind} output is reference material a summary would damage`, ambiguous };
	}
	if (output.lines < config.min_lines) {
		return { decision: "keep_raw", reason: `${output.lines} lines: re-reading is cheaper than a summary`, ambiguous };
	}
	return { decision: "reduce", reason: `${output.lines} lines of ${output.kind} output above the floor`, ambiguous };
}
