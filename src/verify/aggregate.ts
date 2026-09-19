/**
 * The deterministic aggregate (PRD-009 Phase 3, FR-123).
 *
 * The status PRD-010's gate consumes is computed here and nowhere else, and it
 * is one-way: the gate may lower `pass` to `MISSING_PROOF`, but no API exists by
 * which a JEV answer, a model assertion or a caller can raise this value.
 */
import type { EvidenceRecord, EvidenceStatus } from "./evidence.js";

/** The only status a completion decision may be built from. */
export type VerificationStatus = "pass" | "incomplete" | "deterministic_failure";

/**
 * Exhaustive over the status union with no permissive default arm: a status
 * added to `EvidenceStatus` later fails to compile here instead of falling
 * through to `pass`.
 */
function statusOf(status: EvidenceStatus): VerificationStatus {
	switch (status) {
		case "pass":
			return "pass";
		case "fail":
		case "error":
			return "deterministic_failure";
		case "not_run":
		case "unavailable":
			return "incomplete";
	}
}

/**
 * Pure and total. `records` are the mandatory fresh records; `staleRecords` are
 * mandatory records whose workspace state no longer matches, and any one of
 * them makes the aggregate a `deterministic_failure`. Pass only when every
 * mandatory record is a fresh `pass` — an absent check is a `not_run` record, so
 * it aggregates to `incomplete` rather than being inferred as success.
 */
export function aggregate(records: readonly EvidenceRecord[], staleRecords: readonly EvidenceRecord[] = []): VerificationStatus {
	const statuses: VerificationStatus[] = [
		...staleRecords.map((): VerificationStatus => "deterministic_failure"),
		...records.map((record) => statusOf(record.status)),
	];
	if (statuses.includes("deterministic_failure")) return "deterministic_failure";
	return statuses.includes("incomplete") ? "incomplete" : "pass";
}
