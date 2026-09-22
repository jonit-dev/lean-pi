/**
 * Requirement-driven verifier selection (PRD-009 Phase 2, ROADMAP §35, §8).
 *
 * Selection reads the contract's verification block and stamps each descriptor
 * with the acceptance-criterion ids it covers and the surface it runs over —
 * the only point in the system that knows *why* a verifier was chosen. The
 * regression-scope decision site can add a verifier (the broad suite); it can
 * never remove a mandatory one or alter a recorded result.
 */
import type { ExecutionContract } from "../compiler/contract.js";
import type { JevClient } from "../jev/client.js";
import { ensureSite, type DecisionSite } from "../jev/registry.js";
import type { ChoiceAnswer, JevQuestion, JevResult } from "../jev/types.js";
import { DEFAULT_SCOPES, isVerifierKind, resolveCommand, type VerifierDescriptor, type VerifierKind } from "./descriptors.js";

export type RegressionScope = "TARGETED_SUFFICIENT" | "BROADER_SUITE_REQUIRED";

export const REGRESSION_SCOPE_SITE_ID = "verify.regression_scope";
export const REGRESSION_SCOPE_TELEMETRY_TAG = "verify/regression_scope";

/**
 * The rule's file-count floor. §10 wants calibration in one place; `confidence.ts`
 * holds confidence thresholds rather than scope heuristics, so the knob lives
 * with its rule and is overridable per call.
 */
export const REGRESSION_SCOPE_FILE_THRESHOLD = 5;

/** ROADMAP §8 spellings that must not fall through to `not_run` for a kind we do run. */
const KIND_ALIASES: Record<string, VerifierKind> = {
	affected_tests: "targeted_test",
	compile: "typecheck",
};

/** A changed file that is itself a test: the only surface a targeted test can name. */
const TEST_FILE_PATTERN = /\.(spec|test)\.[cm]?[jt]sx?$/;
const TEST_DIRECTORY_PATTERN = /(^|\/)(tests|__tests__)\//;

/**
 * The test files among `files`, space-joined, or `""` when there are none.
 *
 * One rule, two readers: the compiler stamps the contract's criteria with it,
 * and selection derives the targeted scope from the run's own files with it, so
 * "what does the targeted test run over" cannot be answered two ways.
 */
export function targetedSurfaceOf(files: readonly string[]): string {
	return files.filter((file) => TEST_FILE_PATTERN.test(file) || TEST_DIRECTORY_PATTERN.test(file)).join(" ");
}

/**
 * Whether the effective targeted command can run with no scope at all — the one
 * case where a contract may require `affected_tests` without naming a surface.
 * The question is the selector's own `resolveCommand`, so the compiler cannot
 * require a check this layer would resolve to the empty string.
 */
export function targetedRunsWithoutScope(commands: Partial<Record<string, string>> = {}): boolean {
	return resolveCommand("targeted_test", "", commands).length > 0;
}

export function normalizeVerifierKind(raw: string): VerifierKind | undefined {
	const value = raw.trim().toLowerCase().replaceAll("-", "_");
	return KIND_ALIASES[value] ?? (isVerifierKind(value) ? value : undefined);
}

/** One acceptance criterion's verification declaration (§8 / FR-124). */
export interface CriterionVerification {
	id: string;
	/** Verifier kinds this criterion is proved by. Absent means it declares none. */
	verifiers?: string[];
	/** The concrete surface for this criterion's verifier, e.g. a test pattern. */
	scope?: string;
}

export interface VerificationBlock {
	required: string[];
	criteria: CriterionVerification[];
}

/** What the caller knows about the diff; the deterministic rule reads only this. */
export interface DiffSummary {
	files: readonly string[];
	/** The executor/compiler report that the change modifies an exported symbol. */
	exportedSymbol?: boolean;
	/** The change set could not be derived, so scope cannot be narrowed. */
	unknown?: boolean;
}

export interface SelectOptions {
	/** The JEV control plane. Absent means the deterministic rule answers directly. */
	jev?: Pick<JevClient, "ask">;
	diff?: DiffSummary;
	commands?: Partial<Record<string, string>>;
}

export interface Selection {
	descriptors: VerifierDescriptor[];
	/** Kinds the contract asked for that this layer cannot run; recorded, never omitted. */
	skipped: Array<{ kind: string; reason: string }>;
	regressionScope: RegressionScope;
}

/** The contract's verification block as this module reads it (`required` is PRD-004's shipping field). */
export function verificationBlockOf(contract: ExecutionContract): VerificationBlock {
	const raw = (contract as { verification?: unknown }).verification;
	const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const required = Array.isArray(record.required) ? record.required.filter((value): value is string => typeof value === "string") : [];
	const criteria: CriterionVerification[] = [];
	if (Array.isArray(record.criteria)) {
		for (const entry of record.criteria) {
			if (entry === null || typeof entry !== "object") continue;
			const item = entry as Record<string, unknown>;
			if (typeof item.id !== "string" || item.id.length === 0) continue;
			const verifiers = Array.isArray(item.verifiers) ? item.verifiers.filter((value): value is string => typeof value === "string") : undefined;
			criteria.push({
				id: item.id,
				...(verifiers ? { verifiers } : {}),
				...(typeof item.scope === "string" ? { scope: item.scope } : {}),
			});
		}
	}
	return { required, criteria };
}

function criterionIdsFor(kind: VerifierKind, criteria: readonly CriterionVerification[]): string[] {
	return criteria.filter((entry) => (entry.verifiers ?? []).some((name) => normalizeVerifierKind(name) === kind)).map((entry) => entry.id);
}

function scopeFor(kind: VerifierKind, criteria: readonly CriterionVerification[], derived = ""): string {
	// A package-wide surface (typecheck, lint, build) is what the verifier
	// actually runs over regardless of which criterion asked for it; only a kind
	// with no default surface — the targeted test pattern — takes the surface the
	// contract's verification block declares for the criterion.
	if ((DEFAULT_SCOPES[kind] ?? "").length > 0) return DEFAULT_SCOPES[kind]!;
	const declared = criteria.find(
		(entry) => entry.scope !== undefined && entry.scope.trim().length > 0 && (entry.verifiers ?? []).some((name) => normalizeVerifierKind(name) === kind),
	);
	if (declared?.scope !== undefined) return declared.scope.trim();
	// Nothing declared one, so the run's own test files are the surface — the
	// only one this layer can name without guessing. A kind with no default
	// surface and no command of its own takes none.
	return kind === "targeted_test" ? derived : "";
}

/** Config and build surfaces whose change reaches beyond any targeted test set. */
const SHARED_CONTRACT_PATTERNS: readonly RegExp[] = [
	/^package\.json$/,
	/^tsconfig(\.[^/]+)?\.json$/,
	/(^|\/)[^/]+\.config\.(js|mjs|cjs|ts)$/,
	/\.ya?ml$/,
	/^pnpm-lock\.yaml$/,
	/^Dockerfile$/,
	/^\.github\//,
];

export function coversTargetedOnly(diff: DiffSummary, threshold: number = REGRESSION_SCOPE_FILE_THRESHOLD): boolean {
	return diff.files.length <= threshold;
}

export function changesSharedContract(diff: DiffSummary): boolean {
	return diff.exportedSymbol === true || diff.files.some((file) => SHARED_CONTRACT_PATTERNS.some((pattern) => pattern.test(file)));
}

/**
 * The declared deterministic fallback of the `verify.regression_scope` site:
 * broader suite when the diff touches more than the threshold's worth of files,
 * edits an exported symbol, or changes config/build files; targeted only
 * otherwise. With no diff supplied it cannot justify widening.
 */
export function regressionScopeRule(diff: DiffSummary | undefined, threshold: number = REGRESSION_SCOPE_FILE_THRESHOLD): RegressionScope {
	if (!diff) return "TARGETED_SUFFICIENT";
	// An unknown change set cannot be shown to be covered by the targeted tests,
	// so the conservative scope is the broader suite.
	if (diff.unknown === true) return "BROADER_SUITE_REQUIRED";
	return coversTargetedOnly(diff, threshold) && !changesSharedContract(diff) ? "TARGETED_SUFFICIENT" : "BROADER_SUITE_REQUIRED";
}

const REGRESSION_SCOPE_OPTIONS: Record<string, string> = {
	TARGETED_SUFFICIENT: "the named targeted tests cover every changed path",
	BROADER_SUITE_REQUIRED: "the change reaches code or contracts the targeted tests do not cover",
};

const REGRESSION_SCOPE_QUESTIONS: JevQuestion[] = [
	{
		id: "regression_scope.coverage",
		kind: "Choice",
		text: "Does the diff touch only code covered by the named targeted tests?",
		options: REGRESSION_SCOPE_OPTIONS,
	},
	{
		id: "regression_scope.contract_change",
		kind: "Choice",
		text: "Does the diff change a shared/exported contract with other callers?",
		options: REGRESSION_SCOPE_OPTIONS,
	},
];

function choiceAnswer(question: JevQuestion, choice: RegressionScope): ChoiceAnswer {
	return { kind: "Choice", questionId: question.id, choice, probabilities: { [choice]: 1 }, confidence: 1 };
}

/** The rule's verdict, expressed as answers to the site's two atomic questions. */
function ruleAnswers(diff: DiffSummary | undefined, threshold: number): JevResult[] {
	return [
		choiceAnswer(REGRESSION_SCOPE_QUESTIONS[0]!, diff && !coversTargetedOnly(diff, threshold) ? "BROADER_SUITE_REQUIRED" : "TARGETED_SUFFICIENT"),
		choiceAnswer(REGRESSION_SCOPE_QUESTIONS[1]!, diff && changesSharedContract(diff) ? "BROADER_SUITE_REQUIRED" : "TARGETED_SUFFICIENT"),
	];
}

export function registerRegressionScopeSite(): DecisionSite {
	return ensureSite({
		id: REGRESSION_SCOPE_SITE_ID,
		questions: REGRESSION_SCOPE_QUESTIONS,
		returnType: ["Choice", "Choice"],
		consequence: "normal",
		telemetryTag: REGRESSION_SCOPE_TELEMETRY_TAG,
		fallback: ({ state }) => {
			const carried = state as { diff?: DiffSummary; threshold?: number } | undefined;
			return ruleAnswers(carried?.diff, carried?.threshold ?? REGRESSION_SCOPE_FILE_THRESHOLD);
		},
	});
}

/** A JEV failure is never a selection failure: the rule answers instead. */
async function decideRegressionScope(options: SelectOptions): Promise<RegressionScope> {
	if (!options.jev) return regressionScopeRule(options.diff);
	try {
		const results = await options.jev.ask(REGRESSION_SCOPE_SITE_ID, REGRESSION_SCOPE_QUESTIONS, {
			diff: options.diff,
			threshold: REGRESSION_SCOPE_FILE_THRESHOLD,
		});
		return results.some((result) => result.kind === "Choice" && result.choice === "BROADER_SUITE_REQUIRED") ? "BROADER_SUITE_REQUIRED" : "TARGETED_SUFFICIENT";
	} catch {
		return regressionScopeRule(options.diff);
	}
}

/**
 * Select the descriptors for this contract: everything the contract requires
 * (aliases normalized), the always-cheap `git_status` dirty proof, and — when
 * the regression-scope decision says the change is broader than the targeted
 * tests — the full suite on top. Attribution is stamped here.
 */
export async function selectVerifiers(contract: ExecutionContract, options: SelectOptions = {}): Promise<Selection> {
	registerRegressionScopeSite();
	const block = verificationBlockOf(contract);
	const descriptors: VerifierDescriptor[] = [];
	const skipped: Array<{ kind: string; reason: string }> = [];
	// The diff is also the fallback surface for the targeted test: the files this
	// run changed are the tests it must re-run, when the contract names none.
	const derived = targetedSurfaceOf(options.diff?.files ?? []);

	const add = (kind: VerifierKind, scope: string = scopeFor(kind, block.criteria, derived), mandatory = true): void => {
		if (descriptors.some((descriptor) => descriptor.kind === kind)) return;
		descriptors.push({
			kind,
			command: resolveCommand(kind, scope, options.commands ?? {}),
			mandatory,
			criterion: criterionIdsFor(kind, block.criteria),
			scope,
		});
	};

	for (const raw of block.required) {
		const kind = normalizeVerifierKind(raw);
		if (!kind) {
			skipped.push({ kind: raw, reason: `unsupported verifier kind "${raw}"` });
			continue;
		}
		add(kind);
	}
	add("git_status");

	const targeted = descriptors.find((descriptor) => descriptor.kind === "targeted_test");
	let regressionScope: RegressionScope = "TARGETED_SUFFICIENT";
	if (targeted && !descriptors.some((descriptor) => descriptor.kind === "full_suite")) {
		regressionScope = await decideRegressionScope(options);
		if (regressionScope === "BROADER_SUITE_REQUIRED") {
			add("full_suite", targeted.scope.trim().length > 0 ? targeted.scope : scopeFor("full_suite", block.criteria));
		}
	}

	return { descriptors, skipped, regressionScope };
}
