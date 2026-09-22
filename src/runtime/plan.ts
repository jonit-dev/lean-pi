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
 * A runner reads the declarations from its own `VerifierContext.runtime`, which
 * the session threads per run, so two overlapping verifications cannot see each
 * other's plan. The process-global binder at the bottom of this module is legacy
 * for direct-runner tests only.
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

/**
 * Field domains, validated here so a typo cannot become a check that runs with a
 * floored timeout, a port outside TCP's range, or a threshold above 1 that makes
 * every capture pass. `textAllowEmpty` is distinct because an empty CLI `stdin`
 * or `stdoutEquals` is declared data, not an absent one.
 */
type FieldKind = "text" | "textAllowEmpty" | "texts" | "int" | "positiveInt" | "port" | "unit" | "positiveNumber";
interface Shape {
	[key: string]: FieldKind | Shape;
}

const SMOKE_SHAPE: Shape = {
	command: "text",
	timeoutMs: "positiveInt",
	ready: { log: "text", port: "port", timeoutMs: "positiveInt" },
};

const CLI_SHAPE: Shape = {
	command: "text",
	stdin: "textAllowEmpty",
	timeoutMs: "positiveInt",
	expect: { exitCode: "int", stdoutEquals: "textAllowEmpty", stdoutContains: "texts", stderrContains: "texts" },
};

const BROWSER_SHAPE: Shape = { url: "text", selectors: "texts", text: "texts", timeoutMs: "positiveInt" };

const SCREENSHOT_SHAPE: Shape = {
	url: "text",
	baseline: "text",
	threshold: "unit",
	colorThreshold: "unit",
	deviceScaleFactor: "positiveNumber",
	timeoutMs: "positiveInt",
	viewport: { width: "positiveInt", height: "positiveInt" },
};

const RUNTIME_SHAPES = [
	["smoke", SMOKE_SHAPE],
	["cli", CLI_SHAPE],
	["browser", BROWSER_SHAPE],
	["screenshot", SCREENSHOT_SHAPE],
] as const;

function planRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** One declared value, kept only when it is the shape its field declares. */
function fieldOf(value: unknown, kind: FieldKind): unknown {
	switch (kind) {
		case "text":
			return typeof value === "string" && value.trim().length > 0 ? value : undefined;
		case "textAllowEmpty":
			return typeof value === "string" ? value : undefined;
		case "texts": {
			if (!Array.isArray(value) || value.length === 0) return undefined;
			// A malformed member is dropped by no one: one bad entry makes the whole
			// assertion list an issue rather than silently shrinking the check.
			const entries = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
			return entries.length === value.length ? entries : undefined;
		}
		case "int":
			return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
		case "positiveInt":
			return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
		case "port":
			return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65_535 ? value : undefined;
		case "unit":
			return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
		case "positiveNumber":
			return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
	}
}

/** A parse of a raw runtime block: the valid subset, plus the dotted paths it had to drop. */
export interface RuntimePlanParse {
	plan: RuntimePlan;
	/** Fields that were present but not the shape the field declares, as `smoke.ready.port`-style paths. */
	issues: string[];
}

/**
 * Collect the valid fields of `source` into `parsed`, recording any present-but-
 * malformed field *and* any key the shape does not declare: an unknown key is an
 * intended check's name, so deleting it would be the silent omission this walk
 * exists to prevent.
 */
function collectShape(shape: Shape, source: Record<string, unknown>, prefix: string, parsed: Record<string, unknown>, issues: string[]): void {
	for (const [key, value] of Object.entries(source)) {
		const path = prefix.length === 0 ? key : `${prefix}.${key}`;
		const spec = shape[key];
		if (spec === undefined) {
			issues.push(path);
			continue;
		}
		if (typeof spec === "string") {
			const got = fieldOf(value, spec);
			if (got === undefined) issues.push(path);
			else parsed[key] = got;
			continue;
		}
		const nested = planRecord(value);
		if (!nested) {
			issues.push(path);
			continue;
		}
		const inner: Record<string, unknown> = {};
		collectShape(spec, nested, path, inner, issues);
		if (Object.keys(inner).length > 0) parsed[key] = inner;
	}
}

/**
 * The per-block completeness rules. A block whose declaration is present but
 * cannot name a runnable check is an issue, so `smoke: {}` or `cli: {bogus: 1}`
 * fails config load instead of compiling no required verifier at all. A command
 * may come from the plan or the matching configured override (`runtime_smoke` /
 * `cli_invocation`), which is the same pair the verifiers resolve.
 */
function incompleteBlocks(plan: RuntimePlan, declared: ReadonlySet<string>, commands: Partial<Record<string, string>>): string[] {
	const issues: string[] = [];
	if (declared.has("smoke")) {
		if (plan.smoke?.command === undefined && !commands.runtime_smoke) issues.push("smoke.command");
		if (plan.smoke?.ready?.log === undefined && plan.smoke?.ready?.port === undefined) issues.push("smoke.ready");
	}
	if (declared.has("cli")) {
		if (plan.cli?.command === undefined && !commands.cli_invocation) issues.push("cli.command");
		const expect = plan.cli?.expect;
		if (
			expect === undefined ||
			(expect.exitCode === undefined &&
				expect.stdoutEquals === undefined &&
				(expect.stdoutContains?.length ?? 0) === 0 &&
				(expect.stderrContains?.length ?? 0) === 0)
		) {
			issues.push("cli.expect");
		}
	}
	if (declared.has("browser")) {
		if (plan.browser?.url === undefined) issues.push("browser.url");
		else if ((plan.browser.selectors?.length ?? 0) === 0 && (plan.browser.text?.length ?? 0) === 0) issues.push("browser.assertions");
	}
	if (declared.has("screenshot")) {
		if (plan.screenshot?.url === undefined) issues.push("screenshot.url");
		if (plan.screenshot?.baseline === undefined) issues.push("screenshot.baseline");
	}
	return issues;
}

export interface RuntimePlanParseOptions {
	/** The project's configured commands, so a smoke/cli block may omit its command when an override supplies one. */
	commands?: Partial<Record<string, string>>;
}

/**
 * Validate one raw `verification.runtime` block. `runtimePlanOf` keeps only what
 * is valid and ignores the rest; a config loader uses the same walk and turns
 * `issues` into a named error, so the two paths cannot disagree about validity.
 */
export function parseRuntimePlan(value: unknown, options: RuntimePlanParseOptions = {}): RuntimePlanParse {
	const runtime = planRecord(value);
	if (!runtime) return { plan: EMPTY_RUNTIME_PLAN, issues: [""] };
	const known: Set<string> = new Set(RUNTIME_SHAPES.map(([key]) => key));
	const issues: string[] = [];
	const plan: RuntimePlan = {};
	const declared = new Set<string>();
	for (const [key, shape] of RUNTIME_SHAPES) {
		if (runtime[key] === undefined) continue;
		const nested = planRecord(runtime[key]);
		if (!nested) {
			issues.push(key);
			continue;
		}
		declared.add(key);
		const parsed: Record<string, unknown> = {};
		collectShape(shape, nested, key, parsed, issues);
		if (Object.keys(parsed).length > 0) plan[key] = parsed as never;
	}
	for (const key of Object.keys(runtime)) if (!known.has(key)) issues.push(key);
	// Completeness is appended after the field walk, so a malformed field keeps
	// naming itself first and the named error an operator sees is the typo.
	issues.push(...incompleteBlocks(plan, declared, options.commands ?? {}));
	return { plan, issues };
}

/** The four declarations a contract carries, each validated field by field. */
export function runtimePlanOf(contract: ExecutionContract | undefined): RuntimePlan {
	const verification = planRecord((contract as { verification?: unknown } | undefined)?.verification);
	const runtime = planRecord(verification?.runtime);
	if (!runtime) return EMPTY_RUNTIME_PLAN;
	return parseRuntimePlan(runtime).plan;
}

let bound: RuntimePlan = EMPTY_RUNTIME_PLAN;

/**
 * Bind a plan for the duration of a verification run; the returned function
 * restores whatever was bound before.
 *
 * LEGACY ONLY. Production threads the plan through `VerifierContext.runtime`
 * (verifyTask, the gate, recovery and the executor all pass it explicitly), so
 * two overlapping verifications never share a plan. This process-global binder
 * survives for direct-runner tests and older callers that have not moved to the
 * per-context field; a verifier reads it only when its context carries none.
 */
export function bindRuntimePlan(plan: RuntimePlan | undefined): () => void {
	const previous = bound;
	bound = plan ?? EMPTY_RUNTIME_PLAN;
	return () => {
		bound = previous;
	};
}

/** The legacy process-global plan; `EMPTY_RUNTIME_PLAN` when nothing is bound. Production reads `VerifierContext.runtime`. */
export function currentRuntimePlan(): RuntimePlan {
	return bound;
}
