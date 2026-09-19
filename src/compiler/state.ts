/**
 * Separated task state (PRD-004 Phase 3, FR-004).
 *
 * Four containers, each reachable only through its own accessor, each read
 * returning its own frozen snapshot and each write touching only its own slice.
 * The separation is enforced by construction rather than convention, so an
 * executor retry cannot silently rewrite the planning record the proof gate will
 * later be judged against.
 */

export interface PlanningState {
	decision: string | null;
	contract_frozen: boolean;
	notes: string[];
}

export interface ExecutionState {
	attempts: number;
	last_error: string | null;
	files_touched: string[];
}

export interface VerificationState {
	evidence: Array<{ kind: string; status: string; criterion?: string }>;
}

export interface ReviewState {
	rounds: number;
	verdicts: string[];
}

export interface TaskStateSnapshot {
	planning: PlanningState;
	execution: ExecutionState;
	verification: VerificationState;
	review: ReviewState;
}

export interface TaskState {
	planning(): Readonly<PlanningState>;
	execution(): Readonly<ExecutionState>;
	verification(): Readonly<VerificationState>;
	review(): Readonly<ReviewState>;
	recordPlanning(patch: Partial<PlanningState>): Readonly<PlanningState>;
	/** The only way to bump the attempt counter; touches nothing outside `execution`. */
	recordAttempt(error?: string): Readonly<ExecutionState>;
	recordEvidence(entry: { kind: string; status: string; criterion?: string }): Readonly<VerificationState>;
	recordReview(verdict: string): Readonly<ReviewState>;
	snapshot(): TaskStateSnapshot;
}

function frozen<T extends object>(value: T): Readonly<T> {
	for (const entry of Object.values(value)) {
		if (entry !== null && typeof entry === "object") frozen(entry as object);
	}
	return Object.freeze(value);
}

export function createTaskState(initial: Partial<TaskStateSnapshot> = {}): TaskState {
	const containers: TaskStateSnapshot = {
		planning: { decision: null, contract_frozen: false, notes: [], ...initial.planning },
		execution: { attempts: 0, last_error: null, files_touched: [], ...initial.execution },
		verification: { evidence: [], ...initial.verification },
		review: { rounds: 0, verdicts: [], ...initial.review },
	};

	return {
		planning: () => frozen({ ...containers.planning, notes: [...containers.planning.notes] }),
		execution: () => frozen({ ...containers.execution, files_touched: [...containers.execution.files_touched] }),
		verification: () => frozen({ ...containers.verification, evidence: containers.verification.evidence.map((entry) => ({ ...entry })) }),
		review: () => frozen({ ...containers.review, verdicts: [...containers.review.verdicts] }),

		recordPlanning(patch) {
			Object.assign(containers.planning, patch, {
				notes: patch.notes ? [...patch.notes] : containers.planning.notes,
			});
			return this.planning();
		},
		recordAttempt(error) {
			containers.execution.attempts += 1;
			containers.execution.last_error = error ?? null;
			return this.execution();
		},
		recordEvidence(entry) {
			containers.verification.evidence.push({ ...entry });
			return this.verification();
		},
		recordReview(verdict) {
			containers.review.rounds += 1;
			containers.review.verdicts.push(verdict);
			return this.review();
		},
		snapshot() {
			return {
				planning: JSON.parse(JSON.stringify(containers.planning)) as PlanningState,
				execution: JSON.parse(JSON.stringify(containers.execution)) as ExecutionState,
				verification: JSON.parse(JSON.stringify(containers.verification)) as VerificationState,
				review: JSON.parse(JSON.stringify(containers.review)) as ReviewState,
			};
		},
	};
}

/** Deep-freeze the assembled contract: a later lane must not be able to rewrite it. */
export function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
		Object.freeze(value);
	}
	return value;
}
