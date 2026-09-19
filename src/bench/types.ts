/**
 * PRD-021's shared shapes: the suite, the configuration matrix, one attempt's
 * ledger row and the two report folds' inputs.
 *
 * Nothing here re-declares a §52 field: the numbers this harness aggregates come
 * from `RunTelemetry` (PRD-015), and the harness's own artifacts are the *ledger*
 * (one line per attempt, with provenance and the independent verdict) and the
 * report folds over it. `bench/out/<runId>/ledger.jsonl` follows the
 * `autoresearch` skill's ledger convention — one row per attempt, carrying the
 * source revision, the configuration and the budget it ran under.
 */

/** One configuration's error, named so a caller can act on it (never a bare throw). */
export class BenchError extends Error {
	constructor(
		message: string,
		readonly kind: "suite" | "config" | "workspace" | "adapter" | "telemetry-join" | "owner-gate" | "usage" | "rubric",
	) {
		super(message);
		this.name = "BenchError";
	}
}

/** Where a task's attempt starts, and how that revision was resolved. */
export interface BenchTaskSource {
	/** Upstream repository URL (or a local path; `git clone` accepts both). */
	repo: string;
	/** The revision the attempt starts from — the fix commit's parent. */
	commit: string;
	/** The upstream commit that added the acceptance test, when one exists. */
	fix_commit: string | null;
	/** How `commit` was resolved (provenance; e.g. `git log %P of <fix_commit>`). */
	pinned_via: string;
}

/** The held-out acceptance check. `kind: "none"` routes the task to the rubric judgement. */
export interface BenchGolden {
	kind: "upstream-test" | "none";
	/** Files the adjudicator checks out from `fix_commit` after the attempt is sealed. */
	files: string[];
	/** The command that decides completion; run in the sealed workspace. */
	command: string;
	/** ISO date the command was executed end-to-end by the owner, or null when only captured. */
	validated_at: string | null;
}

/** One suite task: a real upstream revision, a prompt and a held-out check. */
export interface BenchTask {
	id: string;
	prompt: string;
	source: BenchTaskSource;
	/** §55 categories this task exercises, by id (`suite.ts` owns the vocabulary). */
	categories: string[];
	/** Commands run in the workspace before the attempt (dependency install, generation). */
	setup: string[];
	golden: BenchGolden;
	/** Free-form curation note shown by `--list`. */
	notes: string;
}

export type BenchAdapterKind = "leanpi" | "stock-pi" | "external" | "omp";

/** One row of `bench/configs/*.yaml`: which adapter, which model, which features are on. */
export interface BenchConfigRow {
	id: string;
	label: string;
	adapter: BenchAdapterKind;
	/** External harness vendor for `adapter: external`; null otherwise. */
	vendor: "claude" | "codex" | null;
	/** JEV mode the LeanPi session runs under. */
	jev: "enabled" | "disabled" | "metadata-only" | "redacted";
	/** The executor model id the row dispatches; the capability index is looked up by it. */
	executor_model: string;
	/** Reviewer role's model, recorded so rubric independence is auditable. */
	reviewer_model: string | null;
	/** Features the row turns on, printed in the report so a row is self-describing. */
	features: string[];
	/** True for the subscription baselines that need joao's logged-in CLIs. */
	owner_gated: boolean;
	/** True when the row consumes a subscription pool (recorded as §52 `subscription_usage`). */
	subscription: boolean;
	/** Per-attempt ceiling in USD; the runner stops the row's task loop when it is crossed. */
	budget_usd: number;
}

/** Where one adjudicator verdict came from, recorded per attempt. */
export interface BenchAdjudication {
	verdict: "complete" | "incomplete" | "error";
	kind: "upstream-test" | "rubric" | "none";
	/** The adjudicator's identity: the golden command, or `rubric:<model id>`. */
	adjudicator: string;
	reason: string | null;
	/** The rubric judge's model id; null for the golden path. */
	rubric_model: string | null;
	/** The attempt's own reviewer model id, copied from its §52 record. */
	reviewer_model: string | null;
}

/** One attempt's line in `ledger.jsonl`: provenance, LeanPi's claim, the independent verdict. */
export interface BenchLedgerRow {
	run_id: string;
	task_id: string;
	config_id: string;
	/** The §52 record's `task_id`, which is how the attempt's telemetry is joined. */
	telemetry_task_id: string;
	session_id: string;
	source: BenchTaskSource;
	budget_usd: number;
	/** LeanPi's own `result.success`, read back from the store — not the adapter's word. */
	reported_success: boolean;
	adjudication: BenchAdjudication;
	/** What the adapter reported about itself: identity, loaded extensions, a non-fatal note. */
	adapter: { operator: string; extensions: string[]; note: string | null };
	/** Set when the row's per-attempt budget stopped its task loop early. */
	note: string | null;
	started_at: string;
	finished_at: string;
}

/** What an adapter returns for one attempt. Everything else is read from the store. */
export interface BenchAttemptResult {
	/** What the session loaded; the stock-Pi row must report an empty list. */
	extensions: string[];
	/** Adapter identity recorded in the report (e.g. `leanpi`, `stock-pi`, `claude`). */
	operator: string;
	/** Subscription usage the worker reported; null when the row is not subscription-backed. */
	subscription_usage: number | null;
	/** Non-fatal adapter note (a fallback chain, a retried dispatch). */
	note: string | null;
}

/** Everything one attempt needs; the workspace is already prepared and sealed off from the golden. */
export interface BenchAttempt {
	task: BenchTask;
	config: BenchConfigRow;
	/** The throwaway checkout the attempt edits. */
	workspace: string;
	session_id: string;
	/** The `task_id` the attempt's §52 record must carry for the join to succeed. */
	telemetry_task_id: string;
	/** The run's §52 store. The runner owns it; every adapter writes its record here. */
	telemetry_path: string;
}

export type BenchAttemptExecutor = (attempt: BenchAttempt) => Promise<BenchAttemptResult>;

/** A prepared workspace and its cleanup. */
export interface BenchWorkspace {
	dir: string;
	cleanup(): void;
}

export type BenchWorkspacePreparer = (task: BenchTask, runDir: string) => Promise<BenchWorkspace>;
