/**
 * The evidence store and its two channels (PRD-009 Phase 1, FR-120/FR-121).
 *
 * `records` holds deterministic results produced by a registered verifier only;
 * `assertions` holds model/executor claims. There is no API that writes a
 * `ModelAssertion` into `records` — the type separation is the mechanism, not a
 * naming convention — and no setter rewrites `criterion`/`scope` after
 * `record()` accepted a result, so attribution is fixed at selection time.
 *
 * Freshness is a read-time comparison, not a flag on the record: `view(hash)`
 * splits stored records by whether their `workspaceHash` still equals the hash
 * computed right now. Stale records are reported, never dropped.
 */

export type EvidenceStatus = "pass" | "fail" | "not_run" | "error" | "unavailable";

/**
 * The shared evidence contract consumed by PRD-010 (proof gate), PRD-011
 * (reviewer packet), PRD-012/013 and PRD-022. Exactly these eight fields.
 */
export interface EvidenceRecord {
	kind: string;
	status: EvidenceStatus;
	workspaceHash: string;
	startedAt: string;
	exitCode: number | null;
	artifactRef: string | null;
	/** Acceptance-criterion ids this run covers; empty when the contract declared none. */
	criterion: string[];
	/** The concrete surface the run covered: test pattern, package name, path glob. */
	scope: string;
}

/** What a registered verifier returns; `reason` is captured into the artifact when one exists. */
export interface VerifierResult {
	kind: string;
	status: EvidenceStatus;
	exitCode: number | null;
	artifactRef: string | null;
	criterion: string[];
	scope: string;
	reason?: string;
}

export interface ModelAssertion {
	source: string;
	text: string;
	recordedAt: string;
}

export interface AssertionInput {
	source: string;
	text: string;
	recordedAt?: string;
}

export interface EvidenceView {
	/** Records whose `workspaceHash` equals the hash the view was read with. */
	records: EvidenceRecord[];
	/** Records collected against a different workspace state. Never silently dropped. */
	staleRecords: EvidenceRecord[];
	assertions: ModelAssertion[];
}

export class EvidenceStore {
	private readonly stored: EvidenceRecord[] = [];
	private readonly claims: ModelAssertion[] = [];

	constructor(private readonly now: () => Date = () => new Date()) {}

	/** Deterministic channel: a result produced by a registered verifier, stamped with the run's hash. */
	record(result: VerifierResult, workspaceHash: string, startedAt: string = this.now().toISOString()): EvidenceRecord {
		const record: EvidenceRecord = {
			kind: result.kind,
			status: result.status,
			workspaceHash,
			startedAt,
			exitCode: result.exitCode,
			artifactRef: result.artifactRef,
			criterion: [...result.criterion],
			scope: result.scope,
		};
		this.stored.push(record);
		return record;
	}

	/** Model-assertion channel: a claim, never a measurement. */
	assert(claim: AssertionInput): ModelAssertion {
		const assertion: ModelAssertion = {
			source: claim.source,
			text: claim.text,
			recordedAt: claim.recordedAt ?? this.now().toISOString(),
		};
		this.claims.push(assertion);
		return assertion;
	}

	/** The FR-124 key PRD-010's per-criterion packet filters on. Freshness-agnostic. */
	forCriterion(id: string): EvidenceRecord[] {
		return this.stored.filter((record) => record.criterion.includes(id));
	}

	view(workspaceHash: string): EvidenceView {
		return {
			records: this.stored.filter((record) => record.workspaceHash === workspaceHash),
			staleRecords: this.stored.filter((record) => record.workspaceHash !== workspaceHash),
			assertions: [...this.claims],
		};
	}

	/** The fresh-only projection: records collected against exactly this workspace state. */
	current(workspaceHash: string): EvidenceRecord[] {
		return this.stored.filter((record) => record.workspaceHash === workspaceHash);
	}
}
