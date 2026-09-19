/**
 * The RTK measurement report, its verdict rule and the derived default (PRD-019 Phase 3, FR-112).
 *
 * The default mode is *computed from the recorded file*, never hand-set: there is
 * no default-mode constant anywhere in LeanPi, and `verdictFromArms()` is the one
 * implementation of "did RTK help" — PRD-021's suite-wide run imports it and
 * regenerates the same file rather than restating the rule, so a later
 * measurement re-decides the default with no code change here.
 *
 * A missing or unreadable report is the no-measurement state and resolves to
 * `auto`, which is non-`on`: reduction then still applies the deterministic rule,
 * so a below-threshold output spawns no reducer while an above-threshold one is
 * reduced.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { LeanPiConfig } from "../core/types.js";
import type { RtkArm, RtkMode } from "./policy.js";
import { RTK_MODES } from "./policy.js";

/** The committed report the shipped default is derived from (PRD-019 Phase 3). */
export const RTK_MEASUREMENT_PATH_DEFAULT = "src/core/rtk-measurement.json";

/** Explicit override, for a bench run writing elsewhere and for tests. */
export const RTK_MEASUREMENT_ENV = "LEANPI_RTK_MEASUREMENT";

export type RtkVerdict = "improved" | "no_benefit";

/** ROADMAP §57's seven metrics, in the order the section lists them. */
export interface RtkArmMetrics {
	arm: RtkArm;
	/** Fixture tasks the arm ran. */
	tasks: number;
	shell_output_bytes: number;
	context_tokens: number;
	model_calls: number;
	retries: number;
	/** Solved tasks over total, taken from PRD-009 evidence records. */
	solve_rate: number;
	wall_ms: number;
	/** PRD-015 `cost.effective_cost` over runs whose `result.success` is true. */
	cost_per_success: number;
}

export interface RtkMeasurement {
	schema: 1;
	generated_at: string;
	/** Where the fixture set came from: `bench/fixtures/shell-heavy.json` or the bundled set. */
	fixture_set: string;
	model_role: string | null;
	tasks: number;
	arms: { off: RtkArmMetrics; on: RtkArmMetrics };
	verdict: RtkVerdict;
}

/** The two quantities the verdict is stated over, so PRD-021 can apply the rule without this PRD's runner. */
export type RtkArmOutcome = Pick<RtkArmMetrics, "solve_rate" | "cost_per_success">;

/**
 * The one verdict rule: ON must be strictly cheaper per success *and* must not
 * regress solve rate. An unmoved or worse verdict is `no_benefit`, which is the
 * valid PRD-closing outcome — the gate never re-runs until it looks favorable.
 */
export function verdictFromArms(off: RtkArmOutcome, on: RtkArmOutcome): RtkVerdict {
	// No solved task on either side is a failed measurement, not a win: a cost
	// per success over zero successes would otherwise read as 0 and "improve".
	if (off.solve_rate <= 0 || on.solve_rate <= 0) return "no_benefit";
	if (on.solve_rate < off.solve_rate) return "no_benefit";
	if (!Number.isFinite(off.cost_per_success) || !Number.isFinite(on.cost_per_success)) return "no_benefit";
	return on.cost_per_success < off.cost_per_success ? "improved" : "no_benefit";
}

/** `on` only for a recorded improvement; every other state — including no report — resolves to `auto`. */
export function resolveRtkDefault(report: RtkMeasurement | null | undefined): Extract<RtkMode, "on" | "auto"> {
	return report?.verdict === "improved" ? "on" : "auto";
}

/** The report location for a project: the env override, an explicit path, else §Phase 3's committed file. */
export function rtkMeasurementPath(
	cwd: string,
	override?: string,
	env: Record<string, string | undefined> = process.env,
): string {
	const declared = override ?? env[RTK_MEASUREMENT_ENV] ?? RTK_MEASUREMENT_PATH_DEFAULT;
	return isAbsolute(declared) ? declared : join(cwd, declared);
}

function metricsOf(value: unknown): RtkArmMetrics | null {
	if (value === null || typeof value !== "object") return null;
	const row = value as Partial<RtkArmMetrics>;
	const numbers = ["tasks", "shell_output_bytes", "context_tokens", "model_calls", "retries", "solve_rate", "wall_ms", "cost_per_success"];
	if (row.arm !== "off" && row.arm !== "on") return null;
	if (!numbers.every((key) => typeof row[key as keyof RtkArmMetrics] === "number")) return null;
	return row as RtkArmMetrics;
}

/** Reading degrades, never throws: an absent, truncated or unknown-schema report is "no measurement yet". */
export function readRtkMeasurement(path: string): RtkMeasurement | null {
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RtkMeasurement>;
		const off = metricsOf(parsed?.arms?.off);
		const on = metricsOf(parsed?.arms?.on);
		if (parsed?.schema !== 1 || !off || !on || (parsed.verdict !== "improved" && parsed.verdict !== "no_benefit")) return null;
		return { ...(parsed as RtkMeasurement), arms: { off, on } };
	} catch {
		return null;
	}
}

/** Write the report §Phase 3 commits; the A/B runner always lands here rather than reading a stale copy. */
export function writeRtkMeasurement(report: RtkMeasurement, path: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
	return path;
}

export interface RtkModeOptions {
	cwd?: string;
	/** Explicit report path; the env override and the committed default follow. */
	reportPath?: string;
	env?: Record<string, string | undefined>;
}

/**
 * The resolved mode: an explicit `rtk.mode` setting wins (a user override is not a
 * default), otherwise the recorded measurement decides, otherwise `auto`.
 */
export function rtkModeOf(config?: LeanPiConfig | null, options: RtkModeOptions = {}): RtkMode {
	const explicit = (config as { rtk?: { mode?: unknown } } | null | undefined)?.rtk?.mode;
	if (typeof explicit === "string" && (RTK_MODES as readonly string[]).includes(explicit)) return explicit as RtkMode;
	return resolveRtkDefault(readRtkMeasurement(rtkMeasurementPath(options.cwd ?? process.cwd(), options.reportPath, options.env ?? process.env)));
}
