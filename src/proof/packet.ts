/**
 * The per-criterion packet (PRD-010 Phase 1, §37, FR-124).
 *
 * A packet holds **only** the records PRD-009 attributed to one criterion —
 * `EvidenceRecord.criterion` is the key — so a sibling criterion's passing
 * check is not in this packet and therefore cannot evidence this criterion.
 * That filter is the whole FR-124 mechanism.
 *
 * Model assertions never reach `evidence`: the executor's claims land under
 * `claims`, where the questions treat them as hearsay. Absent checks are named
 * as `not_run` gaps rather than fabricated as records; stale and `unavailable`
 * records are named as gaps too, and an `unavailable` record is never presented
 * as a measurement.
 */
import type { ArtifactStore } from "../context/artifacts.js";
import type { ExecutionContract } from "../compiler/contract.js";
import type { EvidenceRecord, EvidenceStatus, EvidenceView, ModelAssertion } from "../verify/evidence.js";
import { quoteScope, type ScopeSpec } from "../verify/descriptors.js";
import { normalizeVerifierKind, verificationBlockOf } from "../verify/select.js";

/**
 * Kinds PRD-009 runs on every task regardless of the contract's `required`
 * list: `git_status` is always selected, and `workspace_hash` is the freshness
 * stamp itself. A criterion that declares one of them is gated on it.
 */
const TASK_LEVEL_KINDS: Record<string, true> = { git_status: true, workspace_hash: true };

/** One acceptance criterion as the gate reads it. */
export interface ProofCriterion {
	id: string;
	/** The criterion's wording when the caller carries it; the set of criteria is structural, the prose is not. */
	text?: string;
	/**
	 * The verifier kinds that gate this criterion: the ones it declares that the
	 * contract also marks required. Empty means no deterministic check is mapped
	 * to it, which the coverage rule treats as unprovable rather than as proved.
	 */
	required: readonly string[];
	/** The concrete surface this criterion's verifiers cover: a declared pattern or the compiler's literal path list. */
	scope?: ScopeSpec;
}

export interface ProofPacket {
	criterion: { id: string; text: string | null; required: string[]; scope: string | null };
	/** Task-level: the executor's own report of what changed. */
	changes: Array<{ path: string; description: string }>;
	/** This criterion's fresh measurements: kind, status, scope. An assertion can never appear here. */
	evidence: Array<{ kind: string; status: EvidenceStatus; scope: string; exitCode: number | null }>;
	/** Executor claims: hearsay for the questions, never evidence. */
	claims: Array<{ source: string; text: string }>;
	review: { status: string };
	/** Reference lines: `stale: <kind>`, `unavailable: <kind> (<reason>)`, `not_run: <kind>`. */
	known_gaps: string[];
}

/** PRD-009's evidence view plus the hash it was read at, so freshness is arguable. */
export interface ProofEvidenceView extends EvidenceView {
	workspaceHash: string;
}

export interface PacketContext {
	/** Files the executor reports it changed. */
	changedFiles?: readonly string[];
	/** The executor's own report; its first line describes each change. */
	summary?: string | null;
	/** The reviewer lane's status for this task; `none` when the contract demands no review. */
	reviewStatus?: string | null;
	/** When reachable, an `unavailable` record's reason is read out of its artifact. */
	artifacts?: ArtifactStore;
}

/** PRD-009 drops a verifier's `reason` on the floor, keeping only the artifact ref, so read it there. */
function artifactReason(artifacts: ArtifactStore | undefined, record: EvidenceRecord): string | null {
	if (!artifacts || record.artifactRef === null) return null;
	try {
		const line = artifacts
			.expand(record.artifactRef)
			.toString("utf8")
			.split("\n")
			.map((entry) => entry.trim())
			.find((entry) => entry.length > 0);
		return line ? line.slice(0, 200) : null;
	} catch {
		// A pruned artifact costs the packet a parenthetical, never the turn.
		return null;
	}
}

/** The kinds the contract names, normalized to PRD-009's canonical spelling and deduplicated. */
export function normalizedKinds(names: readonly string[]): string[] {
	const kinds = new Set<string>();
	for (const name of names) {
		const kind = normalizeVerifierKind(name);
		if (kind !== undefined) kinds.add(kind);
	}
	return [...kinds];
}

/**
 * Derive the criteria to gate from the contract's verification block: an id and
 * the required kinds each criterion declares. A criterion declaring a kind the
 * contract does not require declares nothing runnable, so its required set is
 * empty and the gate refuses to pass it.
 */
export function criteriaOf(contract: ExecutionContract): ProofCriterion[] {
	const block = verificationBlockOf(contract);
	const taskRequired = new Set(normalizedKinds(block.required));
	const criteria: ProofCriterion[] = [];
	for (const entry of block.criteria) {
		const required = normalizedKinds(entry.verifiers ?? []).filter(
			(kind) => taskRequired.has(kind) || TASK_LEVEL_KINDS[kind] === true,
		);
		criteria.push({
			id: entry.id,
			required,
			...(entry.scope !== undefined && quoteScope(entry.scope).trim().length > 0 ? { scope: entry.scope } : {}),
		});
	}
	return criteria;
}

/** The compact §37 packet for one criterion, built from this criterion's records only. */
export function buildPacket(criterion: ProofCriterion, view: ProofEvidenceView, context: PacketContext = {}): ProofPacket {
	const attributed = view.records.filter((record) => record.criterion.includes(criterion.id));
	const stale = view.staleRecords.filter((record) => record.criterion.includes(criterion.id));

	const evidence: ProofPacket["evidence"] = [];
	const knownGaps: string[] = [];
	for (const record of attributed) {
		if (record.status === "unavailable") {
			const reason = artifactReason(context.artifacts, record);
			knownGaps.push(`unavailable: ${record.kind}${reason ? ` (${reason})` : ""}`);
			continue;
		}
		evidence.push({ kind: record.kind, status: record.status, scope: record.scope, exitCode: record.exitCode });
	}
	for (const record of stale) knownGaps.push(`stale: ${record.kind}`);
	const measured = new Set(attributed.map((record) => record.kind));
	for (const kind of criterion.required) {
		if (!measured.has(kind)) knownGaps.push(`not_run: ${kind}`);
	}

	const reported = (context.summary ?? "")
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);

	const scopeText = criterion.scope === undefined ? null : quoteScope(criterion.scope);
	return {
		criterion: {
			id: criterion.id,
			text: criterion.text ?? null,
			required: [...criterion.required],
			scope: scopeText !== null && scopeText.trim().length > 0 ? scopeText : null,
		},
		changes: (context.changedFiles ?? []).map((path) => ({ path, description: reported ?? "changed" })),
		evidence,
		claims: view.assertions.map((assertion: ModelAssertion) => ({ source: assertion.source, text: assertion.text })),
		review: { status: context.reviewStatus ?? "none" },
		known_gaps: knownGaps,
	};
}
