/**
 * What a contract declares for the four runtime verifiers (PRD-022 Phases 1–3).
 *
 * Neither the smoke verifier nor the CLI verifier infers a command, a readiness
 * signal or an expectation: everything they run comes from here, read
 * structurally off the §8 contract's `verification.runtime` block so PRD-004's
 * contract type does not have to grow a key this module owns. A declaration that
 * is absent or malformed leaves the setting `undefined`, which the verifier
 * reports as `not_run` with the missing field named — never as a guess and never
 * as a pass.
 *
 * The plan is bound for the duration of a verification run because PRD-009's
 * `VerifierContext` is that module's type (a runner receives only `cwd`,
 * `timeoutMs`, `artifacts` and `exec`), so the declared settings reach a runner
 * through this module rather than through a widened shared interface.
 */
import type { ExecutionContract } from "../compiler/contract.js";

/** Fixed so two runs' screenshots are comparable; both are declared in the plan's entry. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const;
export const DEFAULT_DEVICE_SCALE_FACTOR = 1;

/** The readiness signal `runtime_smoke` waits for: a log line, a TCP port, or both. */
export interface ReadinessPlan {
	/** A pattern the service's stdout/stderr must print before it counts as up. */
	log?: string;
	port?: number;
	timeoutMs?: number;
}

export interface SmokePlan {
	/** Defaults to the descriptor's resolved command when the contract omits it. */
	command?: string;
	ready?: ReadinessPlan;
	timeoutMs?: number;
}

export interface CliExpectation {
	exitCode?: number;
	stdoutContains?: string[];
	stdoutEquals?: string;
	stderrContains?: string[];
}

export interface CliPlan {
	command?: string;
	stdin?: string;
	/** Every declared clause must hold; an entry with no clauses is `not_run`. */
	expect?: CliExpectation;
	timeoutMs?: number;
}

export interface BrowserPlan {
	url?: string;
	selectors?: string[];
	text?: string[];
	timeoutMs?: number;
}

export interface ScreenshotPlan {
	url?: string;
	/** Path to the stored baseline, relative to the workspace root. */
	baseline?: string;
	/** Ratio of differing pixels above which the comparison fails. Default 0.01. */
	threshold?: number;
	/** Per-channel distance above which a pixel counts as different. Default 0.1. */
	colorThreshold?: number;
	viewport?: { width: number; height: number };
	deviceScaleFactor?: number;
	timeoutMs?: number;
}

export interface RuntimePlan {
	smoke?: SmokePlan;
	cli?: CliPlan;
	browser?: BrowserPlan;
	screenshot?: ScreenshotPlan;
}

/** The verifier kinds this plan's declarations select, in canonical order. */
export const RUNTIME_VERIFIER_KINDS = ["runtime_smoke", "cli_invocation", "browser_test", "screenshot_compare"] as const;

export const EMPTY_RUNTIME_PLAN: RuntimePlan = {};

type FieldKind = "text" | "texts" | "int" | "number";
interface Shape {
	[key: string]: FieldKind | Shape;
}

const SMOKE_SHAPE: Shape = {
	command: "text",
	timeoutMs: "int",
	ready: { log: "text", port: "int", timeoutMs: "int" },
};

const CLI_SHAPE: Shape = {
	command: "text",
	stdin: "text",
	timeoutMs: "int",
	expect: { exitCode: "int", stdoutEquals: "text", stdoutContains: "texts", stderrContains: "texts" },
};

const BROWSER_SHAPE: Shape = { url: "text", selectors: "texts", text: "texts", timeoutMs: "int" };

const SCREENSHOT_SHAPE: Shape = {
	url: "text",
	baseline: "text",
	threshold: "number",
	colorThreshold: "number",
	deviceScaleFactor: "number",
	timeoutMs: "int",
	viewport: { width: "int", height: "int" },
};

function planRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** One declared value, kept only when it is the shape its field declares. */
function fieldOf(value: unknown, kind: FieldKind): unknown {
	switch (kind) {
		case "text":
			return typeof value === "string" && value.trim().length > 0 ? value : undefined;
		case "texts": {
			if (!Array.isArray(value)) return undefined;
			const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
			return entries.length > 0 ? entries : undefined;
		}
		case "int":
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
		case "number":
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	}
}

/** Copy the declared fields that the source actually carries, dropping the rest. */
function readShape(shape: Shape, source: Record<string, unknown>): Record<string, unknown> {
	const parsed: Record<string, unknown> = {};
	for (const [key, spec] of Object.entries(shape)) {
		if (typeof spec === "string") {
			const value = fieldOf(source[key], spec);
			if (value !== undefined) parsed[key] = value;
			continue;
		}
		const nested = planRecord(source[key]);
		if (!nested) continue;
		const inner = readShape(spec, nested);
		if (Object.keys(inner).length > 0) parsed[key] = inner;
	}
	return parsed;
}

function planEntry<T>(runtime: Record<string, unknown>, key: string, shape: Shape): T | undefined {
	const source = planRecord(runtime[key]);
	if (!source) return undefined;
	const parsed = readShape(shape, source);
	return Object.keys(parsed).length > 0 ? (parsed as T) : undefined;
}

/** The four declarations a contract carries, each validated field by field. */
export function runtimePlanOf(contract: ExecutionContract | undefined): RuntimePlan {
	const verification = planRecord((contract as { verification?: unknown } | undefined)?.verification);
	const runtime = planRecord(verification?.runtime);
	if (!runtime) return EMPTY_RUNTIME_PLAN;
	const smoke = planEntry<SmokePlan>(runtime, "smoke", SMOKE_SHAPE);
	const cli = planEntry<CliPlan>(runtime, "cli", CLI_SHAPE);
	const browser = planEntry<BrowserPlan>(runtime, "browser", BROWSER_SHAPE);
	const screenshot = planEntry<ScreenshotPlan>(runtime, "screenshot", SCREENSHOT_SHAPE);
	return {
		...(smoke ? { smoke } : {}),
		...(cli ? { cli } : {}),
		...(browser ? { browser } : {}),
		...(screenshot ? { screenshot } : {}),
	};
}

let bound: RuntimePlan = EMPTY_RUNTIME_PLAN;

/**
 * Bind a plan for the duration of a verification run; the returned function
 * restores whatever was bound before. Registration is per process and a contract
 * is per task, so the session rebinds before each `verifyTask`/gate call.
 */
export function bindRuntimePlan(plan: RuntimePlan | undefined): () => void {
	const previous = bound;
	bound = plan ?? EMPTY_RUNTIME_PLAN;
	return () => {
		bound = previous;
	};
}

/** The plan the verifiers read. `EMPTY_RUNTIME_PLAN` when nothing is bound. */
export function currentRuntimePlan(): RuntimePlan {
	return bound;
}
