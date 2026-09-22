/**
 * The review gate (PRD-011 Phase 2, ROADMAP §32, Principle 6.4).
 *
 * `classifyReview()` decides whether a completed change needs no semantic
 * review, a quick one, or a strong one. The order is deliberate:
 *
 * 1. deterministic pre-filters run first and are *floors*, not hints — zero
 *    changed files is `NO_SEMANTIC_REVIEW`, and a security-sensitive path, a
 *    public-API change or the contract's own reviewer class raise the floor
 *    before any model is asked;
 * 2. the JEV `Choice` at `review.level` may only *raise* the level, never lower
 *    it, so a confident-but-wrong answer cannot unlock a cheaper review than the
 *    deterministic rules already demand;
 * 3. JEV unavailable, throwing, answering an unknown option or low confidence
 *    falls back to the conservative `QUICK_REVIEW` (§49: JEV is never a single
 *    point of failure, and its fallback is conservative, not permissive).
 */
import type { ExecutionComplexity, ReviewerClass, ReviewRisk } from "../compiler/contract.js";
import type { JevClient } from "../jev/client.js";
import { ensureSite, type DecisionSite } from "../jev/registry.js";
import type { JevResult } from "../jev/types.js";
import { isReviewLevel, maxReviewLevel, type ReviewLevel } from "./schema.js";

export const REVIEW_LEVEL_SITE_ID = "review.level";
export const REVIEW_LEVEL_QUESTION_ID = "review.level";

const REVIEW_LEVEL_OPTIONS: Record<ReviewLevel, string> = {
	NO_SEMANTIC_REVIEW: "the change is small and low risk, and deterministic verification covers every acceptance criterion",
	QUICK_REVIEW: "one independent reviewer pass at the cheap reviewer role is enough",
	STRONG_REVIEW: "the change needs a rigorous independent review at the strong reviewer role",
};

const REVIEW_LEVEL_QUESTION = {
	id: REVIEW_LEVEL_QUESTION_ID,
	kind: "Choice" as const,
	text:
		"Given the diff size, files changed, execution complexity, task risk, failed attempts, novelty, security-sensitive paths, " +
		"public-API change and proof strength below, does this change need no semantic review, a quick review, or a strong review?",
	options: REVIEW_LEVEL_OPTIONS,
};

/**
 * The registered decision site. Registered at module load and re-ensured by
 * `classifyReview()`, because the registry is process-scoped state a test may
 * reset between cases; `ensureSite` makes the second registration a lookup.
 */
export function registerReviewLevelSite(): DecisionSite {
	return ensureSite({
		id: REVIEW_LEVEL_SITE_ID,
		questions: [REVIEW_LEVEL_QUESTION],
		returnType: ["Choice"],
		// `normal`, not `high`: every wrong answer here degrades to the floor or to
		// `QUICK_REVIEW` and a review still happens, while a rejected high-confidence
		// answer would buy nothing the deterministic floors do not already cover.
		consequence: "normal",
		telemetryTag: REVIEW_LEVEL_SITE_ID,
		// Deterministic and non-null: the one level this gate may never skip to is
		// "no review", so the fallback is the cheapest review rather than the
		// cheapest outcome.
		fallback: () => [
			{ kind: "Choice", questionId: REVIEW_LEVEL_QUESTION_ID, choice: "QUICK_REVIEW", probabilities: { QUICK_REVIEW: 1 }, confidence: 1 },
		],
	});
}

registerReviewLevelSite();

/** PRD-004's review-risk inputs plus the two signals an executor turn already knows. */
export interface ReviewGateInputs {
	/** The candidate change's files; empty means nothing changed and nothing to review. */
	changedFiles?: readonly string[];
	/** True when the change set could not be derived, so `changedFiles` empty is unknown, not "no diff". */
	changedFilesUnknown?: boolean;
	diffBytes?: number;
	executionComplexity?: ExecutionComplexity;
	reviewRisk?: ReviewRisk;
	/** The contract's own §14 reviewer class; a request for review is itself a floor. */
	reviewerClass?: ReviewerClass;
	testCoverage?: "none" | "partial" | "full";
	/** Earlier failed attempts on this task; with a security-sensitive change these force a strong review. */
	failedAttempts?: number;
	novelty?: "familiar" | "novel";
	securitySensitivePaths?: readonly string[];
	publicApiChange?: boolean;
	proofStrength?: "none" | "weak" | "strong";
	/** The JEV control plane. Absent, disabled or unreachable all resolve through the fallback. */
	client?: Pick<JevClient, "ask">;
}

export interface ReviewGateResult {
	level: ReviewLevel;
	/** `floor` — deterministic rules decided; `site` — the decision site answered; `unavailable` — its fallback did. */
	source: "floor" | "site" | "unavailable";
	reason: string;
	/** The deterministic level before the model's answer, reported so a consumer can explain the result. */
	floor: ReviewLevel;
	confidence: number | null;
	fallbackUsed: boolean;
}

const CLASS_LEVELS: Record<ReviewerClass, ReviewLevel> = {
	none: "NO_SEMANTIC_REVIEW",
	review_quick: "QUICK_REVIEW",
	review_strong: "STRONG_REVIEW",
};

/**
 * Paths whose change is security-relevant by name. The list lives beside the
 * floor that consumes it so a caller cannot drift its own weaker copy.
 */
const SECURITY_SENSITIVE_PATTERNS: readonly RegExp[] = [
	/(^|\/)auth[\w-]*\.[jt]sx?$/i,
	/(^|\/)(auth|security|permissions|credentials|secrets|crypto)(\/|$)/i,
	/(^|\/)[\w-]*(token|password|secret|credential|session)[\w-]*\.[jt]sx?$/i,
	/(^|\/)\.env(\.|$)/,
	/(^|\/)(Dockerfile|docker-compose\.ya?ml)$/,
	/(^|\/)\.github\/workflows\//,
];

/** The subset of `files` the floor treats as security-sensitive. */
export function securitySensitivePathsIn(files: readonly string[]): string[] {
	return files.filter((file) => SECURITY_SENSITIVE_PATTERNS.some((pattern) => pattern.test(file)));
}

/**
 * The deterministic side of the gate. Every rule here is a floor the model
 * answer cannot lower, which is what keeps a mis-tuned or unreachable model from
 * skipping the review of a risky change.
 */
function reviewFloor(inputs: ReviewGateInputs): { level: ReviewLevel; reason: string } {
	let level: ReviewLevel = inputs.reviewerClass ? CLASS_LEVELS[inputs.reviewerClass] : "NO_SEMANTIC_REVIEW";
	const reasons: string[] = [];
	if (inputs.reviewerClass && inputs.reviewerClass !== "none") reasons.push(`the contract routes reviewer_class ${inputs.reviewerClass}`);

	const securitySensitive = (inputs.securitySensitivePaths?.length ?? 0) > 0 || inputs.publicApiChange === true;
	if (securitySensitive) {
		level = maxReviewLevel(level, "QUICK_REVIEW");
		reasons.push(inputs.publicApiChange === true ? "the change touches a public API" : `security-sensitive path (${inputs.securitySensitivePaths!.join(", ")})`);
	}
	// A security-sensitive change that already failed an attempt is the case §32
	// weights hardest: a second opinion at the cheap role is not enough.
	if (securitySensitive && (inputs.failedAttempts ?? 0) > 0) {
		level = "STRONG_REVIEW";
		reasons.push(`${inputs.failedAttempts} prior failed attempt(s) on a security-sensitive change`);
	}
	return { level, reason: reasons.length > 0 ? reasons.join("; ") : "no deterministic signal requires review" };
}

/**
 * Classify the review level for a completed change. A `NO_SEMANTIC_REVIEW` result
 * is the only one that may skip the reviewer entirely, so it is the only result
 * the floors can produce without asking the model — and only when nothing changed.
 */
export async function classifyReview(inputs: ReviewGateInputs): Promise<ReviewGateResult> {
	if (!inputs.changedFilesUnknown && (inputs.changedFiles?.length ?? 0) === 0) {
		// Nothing changed: there is no diff for a reviewer to read, so this is the
		// one short-circuit the model never gets to overturn. An unknown change set
		// is not "nothing changed" and must not take this path.
		return {
			level: "NO_SEMANTIC_REVIEW",
			source: "floor",
			reason: "no files changed",
			floor: "NO_SEMANTIC_REVIEW",
			confidence: null,
			fallbackUsed: false,
		};
	}

	const floor = reviewFloor(inputs);
	const site = registerReviewLevelSite();

	if (!inputs.client) {
		return {
			level: maxReviewLevel(floor.level, "QUICK_REVIEW"),
			source: "unavailable",
			reason: `${floor.reason}; JEV is not available, so the conservative fallback applies`.trim(),
			floor: floor.level,
			confidence: null,
			fallbackUsed: true,
		};
	}

	let answers: JevResult[];
	try {
		answers = await inputs.client.ask(site.id, site.questions, {
			changed_files: inputs.changedFiles?.length ?? 0,
			diff_bytes: inputs.diffBytes ?? null,
			execution_complexity: inputs.executionComplexity ?? null,
			review_risk: inputs.reviewRisk ?? null,
			test_coverage: inputs.testCoverage ?? null,
			failed_attempts: inputs.failedAttempts ?? 0,
			novelty: inputs.novelty ?? null,
			security_sensitive_paths: inputs.securitySensitivePaths ?? [],
			public_api_change: inputs.publicApiChange ?? false,
			proof_strength: inputs.proofStrength ?? null,
			deterministic_floor: floor.level,
			deterministic_reason: floor.reason,
		});
	} catch (error) {
		return {
			level: maxReviewLevel(floor.level, "QUICK_REVIEW"),
			source: "unavailable",
			reason: `${floor.reason}; JEV failed (${error instanceof Error ? error.message : String(error)}), so the conservative fallback applies`,
			floor: floor.level,
			confidence: null,
			fallbackUsed: true,
		};
	}

	const answer = answers.find((entry) => entry.questionId === REVIEW_LEVEL_QUESTION_ID);
	if (!answer || answer.kind !== "Choice" || !isReviewLevel(answer.choice)) {
		return {
			level: maxReviewLevel(floor.level, "QUICK_REVIEW"),
			source: "unavailable",
			reason: `${floor.reason}; JEV returned no usable level, so the conservative fallback applies`,
			floor: floor.level,
			confidence: null,
			fallbackUsed: true,
		};
	}

	// The model may only raise: `max` is the whole mechanism protecting the floors.
	const level = maxReviewLevel(floor.level, answer.choice);
	return {
		level,
		source: level === answer.choice ? "site" : "floor",
		reason:
			level === answer.choice
				? `the review-level decision site answered ${answer.choice}`
				: `${answer.choice} was raised to ${level}: ${floor.reason}`,
		floor: floor.level,
		confidence: answer.confidence,
		fallbackUsed: false,
	};
}
