/**
 * The reviewer packet, the typed verdict and the parser between them (PRD-011
 * Phase 1, ROADMAP §30/§32).
 *
 * Two trust boundaries live here. `ReviewPacket` is exactly the seven §30 keys,
 * so the reviewer never sees the executor conversation; `parseVerdict` is the
 * only place reviewer output becomes a verdict, and it maps *any* violation —
 * unparseable text, an unknown decision, a finding missing a field — to
 * `ESCALATE` with a synthetic finding naming the failure. There is no branch
 * that turns malformed output into `PASS`.
 */
import type { EvidenceRecord } from "../verify/evidence.js";
import type { ModelRole } from "../core/types.js";

/** ROADMAP §32's review levels, cheapest first. */
export const REVIEW_LEVELS = ["NO_SEMANTIC_REVIEW", "QUICK_REVIEW", "STRONG_REVIEW"] as const;

export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

/** The levels `review()` accepts: a lane invocation that skips review is not a lane invocation. */
export type ActiveReviewLevel = Exclude<ReviewLevel, "NO_SEMANTIC_REVIEW">;

/** §32 ordering. `classifyReview` composes the deterministic floor with the model's answer through this. */
export const REVIEW_LEVEL_RANK: Record<ReviewLevel, number> = {
	NO_SEMANTIC_REVIEW: 0,
	QUICK_REVIEW: 1,
	STRONG_REVIEW: 2,
};

export function maxReviewLevel(a: ReviewLevel, b: ReviewLevel): ReviewLevel {
	return REVIEW_LEVEL_RANK[a] >= REVIEW_LEVEL_RANK[b] ? a : b;
}

export function isReviewLevel(value: unknown): value is ReviewLevel {
	return typeof value === "string" && (REVIEW_LEVELS as readonly string[]).includes(value);
}

/** §30's verdict enum. */
export const REVIEW_DECISIONS = ["PASS", "FIX_REQUIRED", "ESCALATE"] as const;

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * §30's finding. `severity` is deliberately an open string: the ROADMAP names
 * the field and no taxonomy, so PRD-011 invents none.
 */
export interface ReviewFinding {
	criterion: string;
	file: string;
	location: string;
	severity: string;
	evidence: string;
}

export interface ReviewVerdict {
	decision: ReviewDecision;
	findings: ReviewFinding[];
}

/** The seven §30 packet keys, in the order the packet renders them. */
export const REVIEW_PACKET_KEYS = [
	"objective",
	"acceptance_criteria",
	"final_diff",
	"changed_files",
	"verification_results",
	"known_warnings",
	"executor_summary",
] as const;

export type ReviewPacketKey = (typeof REVIEW_PACKET_KEYS)[number];

export interface AcceptanceCriterion {
	id: string;
	text: string;
}

/**
 * The compact evidence packet PRD-011 §30 hands the reviewer. Constructed only
 * by `buildPacket()`, which takes no transcript argument — so "the executor
 * conversation is absent" is structural rather than a convention.
 */
export interface ReviewPacket {
	objective: string;
	acceptance_criteria: AcceptanceCriterion[];
	final_diff: string;
	changed_files: string[];
	verification_results: EvidenceRecord[];
	known_warnings: string[];
	executor_summary: string;
}

/** The review-family roles: the same spellings as the contract's `reviewer_class`. */
export type ReviewerRole = Extract<ModelRole, "review_quick" | "review_strong">;

/** The role a level runs on. `NO_SEMANTIC_REVIEW` has none — which is why `review()` takes an active level. */
export function reviewerRoleOf(level: ActiveReviewLevel): ReviewerRole {
	return level === "STRONG_REVIEW" ? "review_strong" : "review_quick";
}

function syntheticFailure(reason: string): ReviewFinding {
	// Every field is populated even here, so "a finding carries all five fields"
	// holds for synthetic findings too — one invariant, no special case.
	return {
		criterion: "review.verdict",
		file: "(reviewer output)",
		location: "decision",
		severity: "error",
		evidence: reason.slice(0, 500),
	};
}

export function escalateVerdict(reason: string): ReviewVerdict {
	return { decision: "ESCALATE", findings: [syntheticFailure(reason)] };
}

function findingOf(value: unknown, index: number): ReviewFinding | string {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return `finding[${index}] is not an object`;
	}
	const entry = value as Record<string, unknown>;
	const fields = ["criterion", "file", "location", "severity", "evidence"] as const;
	for (const field of fields) {
		if (typeof entry[field] !== "string") return `finding[${index}]."${field}" is missing or not a string`;
	}
	const finding = entry as unknown as ReviewFinding;
	for (const field of fields) {
		if (finding[field].trim().length === 0) return `finding[${index}]."${field}" is empty`;
	}
	return finding;
}

/**
 * The only conversion from reviewer output to a verdict. A violation is never
 * repaired or ignored: it becomes `ESCALATE` carrying the reason, and the caller
 * (PRD-007/PRD-010) decides what a second round costs.
 */
export function parseVerdict(text: string): ReviewVerdict {
	if (text.trim().length === 0) return escalateVerdict("reviewer returned no output");

	// A fenced block is the one wrapper real reviewers reliably add; nothing
	// beyond it is tolerated, so prose surrounding a verdict is a parse failure
	// rather than something a pattern match silently rescues.
	const trimmed = text.trim();
	const fenced = trimmed.startsWith("```");
	const firstBreak = fenced ? trimmed.indexOf("\n") : -1;
	let body = firstBreak === -1 ? trimmed : trimmed.slice(firstBreak + 1);
	if (firstBreak !== -1) {
		const closing = body.lastIndexOf("```");
		body = (closing === -1 ? body : body.slice(0, closing)).trim();
	}

	let value: unknown;
	try {
		value = JSON.parse(body) as unknown;
	} catch (error) {
		return escalateVerdict(`reviewer output is not JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return escalateVerdict("reviewer output is not a verdict object");
	}

	const record = value as Record<string, unknown>;
	if (!(REVIEW_DECISIONS as readonly unknown[]).includes(record.decision)) {
		return escalateVerdict(`reviewer decision ${JSON.stringify(record.decision)} is not one of ${REVIEW_DECISIONS.join(" | ")}`);
	}
	if (!Array.isArray(record.findings)) {
		return escalateVerdict("reviewer verdict has no findings array");
	}

	const findings: ReviewFinding[] = [];
	for (const [index, entry] of record.findings.entries()) {
		const parsed = findingOf(entry, index);
		if (typeof parsed === "string") return escalateVerdict(parsed);
		findings.push(parsed);
	}
	return { decision: record.decision as ReviewDecision, findings };
}
