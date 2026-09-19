/**
 * The executor lane (PRD-007, ROADMAP §28/§29/§33/§34).
 *
 * `runExecutor(contract, deps)` projects the contract into a task packet carrying
 * exactly the six §28 fields and drives bounded attempts through PRD-008's
 * backend workers. Nothing about the routing process crosses that boundary — not
 * the classifier scores, not the JEV decision records, not the backend-selection
 * reasons — because the projection is a whitelist whose produced key set is
 * asserted.
 *
 * Termination is structural: every loop iteration spends exactly one unit of
 * `limits.execution_attempts` and invokes exactly one backend, so total
 * invocations can never exceed the budget whatever a model or a JEV answer asks
 * for. Escalation never grants an attempt — it only changes what the next one
 * runs on.
 */
import type { ArtifactStore } from "../context/artifacts.js";
import type { JevClient } from "../jev/client.js";
import type { BackendRegistry, HarnessSpawn } from "../backends/index.js";
import { runWorkerTurn } from "../backends/index.js";
import type { RunWorkerTurnOptions } from "../backends/registry.js";
import type { WorkerTaskPacket, WorkerTurnOutcome } from "../backends/worker.js";
import type { CapabilitySlots, ExecutionContract } from "../compiler/contract.js";
import type { LeanPiConfig, ModelRole, SelectedSkill } from "../core/types.js";
import type { EvidenceRecord, EvidenceStore } from "../verify/evidence.js";
import type { ShellExec } from "../verify/run.js";
import { verifyTask } from "../verify/index.js";
import { classifyReview, securitySensitivePathsIn } from "../review/gate.js";
import { review, type ReviewMode, type ReviewRunner } from "../review/lane.js";
import { buildPacket } from "../review/packet.js";
import type { ReviewLevel, ReviewVerdict } from "../review/schema.js";
import { classifyEscalation, escalate, needsClarification, type EscalationCategory } from "./escalation.js";
import { nextAttempt, recordAttempt, type AttemptStrategy, type FailureInput, type RetryBudget, type RetryRecord } from "./retry.js";
import { classifyFailure, retryUseful, FAILURE_SITE_ID, RETRY_SITE_ID, type FailureCategory } from "./sites.js";

/** The six §28 fields, and nothing else. */
export const EXECUTOR_TASK_KEYS = ["objective", "acceptanceCriteria", "context", "capabilities", "budget", "retryLimit"] as const;

export interface ExecutorTask {
	objective: string;
	acceptanceCriteria: ReadonlyArray<{ id: string; text: string }>;
	context: { strategy: string; budgetTokens: number; files: string[] };
	capabilities: CapabilitySlots;
	budget: number;
	retryLimit: number;
}

export interface ExecutorInvocation {
	role: ModelRole;
	backend: string;
	/** What produced this attempt: `initial`, or the escalation category that changed it. */
	strategy: string;
	ok: boolean;
	failure?: string;
}

export interface ExecutorReviewOutcome {
	level: ReviewLevel;
	verdict: ReviewVerdict | null;
	/** True when `classifyReview` returned `NO_SEMANTIC_REVIEW`, so no reviewer ran. */
	skipped: boolean;
}

export interface ExecutorOutcome {
	status: "completed" | "blocked";
	changedFiles: string[];
	evidence: EvidenceRecord[];
	/** The verification command lines this turn resolved, in execution order. */
	commands: string[];
	retryHistory: RetryRecord[];
	invocations: ExecutorInvocation[];
	review: ExecutorReviewOutcome;
	blockedReason?: string;
	escalations: EscalationCategory[];
	/** One row per decision-site call this turn (FR-020, §56). */
	sites: ExecutorSiteRow[];
	/** Set when a `USER_INPUT` escalation cleared the clarification site. */
	question?: string;
	/** Recorded when the lane proceeded on a stated assumption instead of asking. */
	assumption?: string;
}

export interface ExecutorSiteRow {
	site: string;
	answer: string | number | boolean;
	fallbackUsed: boolean;
}

export type ExecutorWorker = (packet: WorkerTaskPacket, options: RunWorkerTurnOptions) => Promise<WorkerTurnOutcome>;

export interface ExecutorDeps {
	registry: BackendRegistry;
	cwd: string;
	config: LeanPiConfig;
	agentDir?: string;
	artifacts?: ArtifactStore;
	store?: EvidenceStore;
	/** The JEV control plane; absent means every site answers deterministically. */
	jev?: Pick<JevClient, "ask" | "fallbackCount">;
	/** Test seam: replaces the PRD-008 backend invocation. */
	worker?: ExecutorWorker;
	spawn?: HarnessSpawn;
	env?: NodeJS.ProcessEnv;
	/** Test seam: PRD-009's command runner. */
	exec?: ShellExec;
	/** Verifier command overrides for this turn, on top of the config's `verify` block. */
	verifyCommands?: Partial<Record<string, string>>;
	/** Test seam: replaces the PRD-011 reviewer worker. */
	reviewRunner?: ReviewRunner;
	/** Spy seam: the broad capability-registry scan the quick path must never reach. */
	onCapabilityScan?: () => void;
	/** Spy seam: PRD-012's PRD entry point, which this lane never calls. */
	onPrdLane?: () => void;
	/** PRD-022's worktree isolation, used when `limits.isolation === "worktree"`. */
	isolate?: (run: (cwd: string) => Promise<ExecutorOutcome>) => Promise<ExecutorOutcome>;
	now?: () => number;
}

export class ExecutorPacketError extends Error {
	constructor(keys: string[]) {
		super(`Executor task packet carries ${JSON.stringify(keys)}; §28 allows exactly ${JSON.stringify([...EXECUTOR_TASK_KEYS])}.`);
		this.name = "ExecutorPacketError";
	}
}

/**
 * Project the §8 contract onto the six §28 fields. The key-set assertion is on
 * the **produced** packet, never on the contract, which legitimately carries
 * `routing`, `reasoning` and `verification` — asserting on the contract would
 * throw on every real turn.
 */
export function toExecutorTask(contract: ExecutionContract, context: { files?: readonly string[] } = {}): ExecutorTask {
	const task: ExecutorTask = {
		objective: contract.task.objective,
		acceptanceCriteria: contract.task.acceptance_criteria.map((criterion) => ({ id: criterion.id, text: criterion.text })),
		context: {
			strategy: contract.context.strategy,
			budgetTokens: contract.context.budget_tokens,
			files: [...(context.files ?? [])],
		},
		capabilities: contract.capabilities,
		budget: contract.context.budget_tokens,
		retryLimit: contract.limits.execution_attempts,
	};
	const keys = Object.keys(task);
	if (keys.length !== EXECUTOR_TASK_KEYS.length || keys.some((key) => !(EXECUTOR_TASK_KEYS as readonly string[]).includes(key))) {
		throw new ExecutorPacketError(keys);
	}
	return task;
}

/** The §28 executor prompt: objective, criteria, selected context, capabilities, budget. */
export function renderExecutorPrompt(task: ExecutorTask): string {
	const criteria = task.acceptanceCriteria.map((criterion) => `- ${criterion.id}: ${criterion.text}`).join("\n");
	const skills = task.capabilities.skills.map((skill) => skill.name).join(", ") || "none";
	return [
		`objective: ${task.objective}`,
		`acceptance criteria:\n${criteria || "- none recorded"}`,
		`context: ${task.context.strategy}, ${task.context.files.length} selected file reference(s)`,
		`capabilities: skills [${skills}], mcp ${task.capabilities.mcps.length}, lsp ${task.capabilities.lsp}, rtk ${task.capabilities.rtk}`,
		`budget: ${task.budget} tokens; retry limit ${task.retryLimit}`,
	].join("\n");
}

function selectedContextFiles(contract: ExecutionContract): string[] {
	const skills: SelectedSkill[] = contract.capabilities.skills;
	return skills.map((skill) => skill.source).slice(0, 16);
}

export async function runExecutor(contract: ExecutionContract, deps: ExecutorDeps): Promise<ExecutorOutcome> {
	if (contract.limits.isolation === "worktree" && deps.isolate) {
		return deps.isolate((isolatedCwd) => runExecutor(contract, { ...deps, cwd: isolatedCwd, isolate: undefined }));
	}

	// §29: the quick path calls neither the capability scan nor the PRD lane.
	// Those calls are absent from this function, which is why the property is
	// structural; the spies in `deps` exist so a spec can observe the absence.
	const task = toExecutorTask(contract, { files: selectedContextFiles(contract) });
	const worker = deps.worker ?? runWorkerTurn;

	const budget: RetryBudget = {
		attemptsUsed: 0,
		executionAttempts: contract.limits.execution_attempts,
		escalationsUsed: 0,
		maxEscalations: contract.limits.max_escalations,
	};
	const retryHistory: RetryRecord[] = [];
	const invocations: ExecutorInvocation[] = [];
	const evidence: EvidenceRecord[] = [];
	const commands: string[] = [];
	const escalations: EscalationCategory[] = [];
	const sites: ExecutorSiteRow[] = [];

	let role: ModelRole = contract.routing.executor_class;
	let excludeBackends: string[] = [];
	let strategyLabel = "initial";
	let attemptStrategy: AttemptStrategy = "same";
	let lastFailure: FailureInput | null = null;
	let pendingEvidence = false;
	const seenRecords = new Set<string>();
	let question: string | undefined;
	let assumption: string | undefined;

	const blocked = (reason: string): ExecutorOutcome => ({
		status: "blocked",
		changedFiles: [],
		evidence,
		commands,
		retryHistory,
		invocations,
		review: { level: "NO_SEMANTIC_REVIEW", verdict: null, skipped: true },
		blockedReason: reason,
		escalations,
		sites,
		...(question ? { question } : {}),
		...(assumption ? { assumption } : {}),
	});

	for (;;) {
		if (budget.attemptsUsed >= budget.executionAttempts) {
			return blocked(`the attempt budget of ${budget.executionAttempts} is exhausted`);
		}
		budget.attemptsUsed += 1;

		const outcome = await worker(
			{
				objective: task.objective,
				role,
				prompt: renderExecutorPrompt(task),
				...(task.context.files.length > 0 ? { files: [...task.context.files] } : {}),
				allowedTools: ["read", "search", "edit", "write", "execute"],
				budget: task.budget,
			},
			{
				registry: deps.registry,
				cwd: deps.cwd,
				...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
				...(deps.spawn ? { spawn: deps.spawn } : {}),
				...(deps.env ? { env: deps.env } : {}),
				...(deps.now ? { now: deps.now } : {}),
				exclude: [...excludeBackends],
			},
		);

		const backendName = outcome.backend ?? "none";
		if (outcome.status === "blocked" || !outcome.result || outcome.result.status === "blocked") {
			const reason = outcome.attempts.map((attempt) => `${attempt.backend}: ${attempt.reason}`).join("; ") || outcome.result?.summary || "the backend reported it is blocked";
			invocations.push({ role, backend: backendName, strategy: strategyLabel, ok: false, failure: reason });
			lastFailure = { kind: "worker", detail: reason };
			pendingEvidence = false;
			if (!outcome.backend) {
				recordAttempt(retryHistory, { strategy: attemptStrategy, failure: lastFailure, newEvidence: false, model: role, backend: backendName });
				return blocked(reason);
			}
		} else {
			invocations.push({ role, backend: backendName, strategy: strategyLabel, ok: true });
			const result = await verifyTask(contract, deps.cwd, {
				...(deps.store ? { store: deps.store } : {}),
				...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
				...(deps.jev ? { jev: deps.jev } : {}),
				config: deps.config,
				touchedPaths: outcome.result.changedFiles,
				...(deps.verifyCommands ? { commands: deps.verifyCommands } : {}),
				...(deps.exec ? { exec: deps.exec } : {}),
			});
			evidence.push(...result.records);
			commands.push(...result.commands);

			if (result.status === "pass") {
				const reviewOutcome = await runReview(contract, deps, {
					changedFiles: outcome.result.changedFiles,
					evidence: result.records,
					failedAttempts: retryHistory.length,
				});
				return {
					status: "completed",
					changedFiles: outcome.result.changedFiles,
					evidence,
					commands,
					retryHistory,
					invocations,
					review: reviewOutcome,
					escalations,
					sites,
					...(assumption ? { assumption } : {}),
				};
			}

			const failing = result.records.find((record) => record.status === "fail" || record.status === "error");
			lastFailure = {
				kind: failing?.kind ?? "verification",
				// The diagnostic itself, when the run captured one: two attempts that
				// print the same error must hash the same, and two that print
				// different errors must not.
				detail: failing ? `exit ${failing.exitCode ?? "none"} ${diagnosticOf(failing.artifactRef, deps.artifacts) || failing.scope}` : "verification did not pass",
			};
			// New evidence: this attempt produced records the turn did not have
			// before. A bare repeat of the same diagnostic is not new evidence.
			pendingEvidence = result.records.some((record) => !seenRecords.has(recordKey(record)));
			for (const record of result.records) seenRecords.add(recordKey(record));
		}

		const failure: FailureInput = { ...(lastFailure ?? { kind: "unknown", detail: "no failure recorded" }), newEvidence: pendingEvidence };
		// The decision reads the attempts *before* this one; the current attempt is
		// recorded after, so a failure is never compared against itself.
		const decision = nextAttempt(retryHistory, failure, budget);
		recordAttempt(retryHistory, { strategy: attemptStrategy, failure, newEvidence: pendingEvidence, model: role, backend: backendName });
		if (decision === "reject") {
			return blocked(`the retry policy rejected another attempt after ${retryHistory.length} failed attempt(s): ${failure.detail}`);
		}
		if (decision === "retry") {
			const category = await classifyFailure({ ...(deps.jev ? { client: deps.jev } : {}), failure });
			sites.push({ site: FAILURE_SITE_ID, answer: category.value, fallbackUsed: category.fallbackUsed });
			const useful = await retryUseful({ ...(deps.jev ? { client: deps.jev } : {}), history: retryHistory, failure, strategy: strategyFor(category.value) });
			sites.push({ site: RETRY_SITE_ID, answer: useful.value, fallbackUsed: useful.fallbackUsed });
			if (!useful.value) {
				return blocked(`another attempt was judged unlikely to change the outcome: ${failure.detail}`);
			}
			attemptStrategy = "reassess";
			strategyLabel = strategyFor(category.value);
			// An environment failure is the backend's, not the code's: retrying the
			// same backend repeats the same environment, so it is burned first.
			if (category.value === "environment") {
				const burned = invocations[invocations.length - 1]?.backend;
				if (burned && burned !== "none") excludeBackends = [...excludeBackends, burned];
			}
			continue;
		}

		// escalate — the gate runs, but it never grants an attempt.
		budget.escalationsUsed += 1;
		const classification = await classifyEscalation({
			...(deps.jev ? { client: deps.jev } : {}),
			history: retryHistory,
			role,
			failure,
		});
		escalations.push(classification.category);
		sites.push({ site: "executor.escalation_reason", answer: classification.category, fallbackUsed: classification.fallbackUsed });
		const lastBackend = invocations[invocations.length - 1]?.backend;
		const action = escalate(classification.category, { role, ...(lastBackend ? { lastBackend } : {}) });
		// The gate is not an attempt, so it appends no row; the attempt it enables
		// is recorded with strategy `escalate` and the role the gate chose.

		if (action.category === "USER_INPUT") {
			const ask = await needsClarification({ ...(deps.jev ? { client: deps.jev } : {}), objective: task.objective, failure });
			if (ask) {
				question = `${task.objective} — the executor needs clarification: ${failure.detail}`;
				return blocked("the executor needs user input to continue");
			}
			assumption = `proceeded on the stated objective without asking: ${task.objective}`;
		}

		if (!action.continues) {
			return blocked(action.reason);
		}
		role = action.role;
		if (action.excludeBackend) excludeBackends = [...excludeBackends, action.excludeBackend];
		attemptStrategy = "escalate";
		strategyLabel = action.category;
	}
}

/** The record identity used to decide whether an attempt produced new evidence. */
function recordKey(record: EvidenceRecord): string {
	return `${record.kind}\u0000${record.status}\u0000${record.artifactRef ?? ""}\u0000${record.scope}`;
}

/** The captured diagnostic bytes for a record, when the turn stored them. */
function diagnosticOf(artifactRef: string | null, artifacts: ArtifactStore | undefined): string {
	if (!artifactRef || !artifacts) return "";
	try {
		return artifacts.expand(artifactRef).toString("utf8").slice(0, 2_000);
	} catch {
		return "";
	}
}

/** The strategy label a failure category selects for the next attempt. */
export function strategyFor(category: FailureCategory): string {
	switch (category) {
		case "environment":
			return "retry_other_environment";
		case "dependency":
			return "retry_after_dependency_repair";
		case "syntax":
			return "retry_fix_syntax";
		case "assertion":
			return "retry_fix_assertion";
		case "likely_logic_bug":
			return "retry_reassess_logic";
	}
}

async function runReview(
	contract: ExecutionContract,
	deps: ExecutorDeps,
	change: { changedFiles: readonly string[]; evidence: readonly EvidenceRecord[]; failedAttempts: number },
): Promise<ExecutorReviewOutcome> {
	// The review decision is PRD-011's, and nothing here re-implements it: a local
	// `review_risk === 'low'` shortcut would route exactly the changes PRD-011's
	// deterministic floor protects.
	const gate = await classifyReview({
		changedFiles: change.changedFiles,
		executionComplexity: contract.task.execution_complexity,
		reviewRisk: contract.task.review_risk,
		reviewerClass: contract.routing.reviewer_class,
		failedAttempts: change.failedAttempts,
		securitySensitivePaths: securitySensitivePathsIn(change.changedFiles),
		proofStrength: change.evidence.some((record) => record.status === "pass") ? "strong" : "none",
		...(deps.jev ? { client: deps.jev } : {}),
	});
	if (gate.level === "NO_SEMANTIC_REVIEW") {
		return { level: gate.level, verdict: null, skipped: true };
	}
	const built = buildPacket({
		objective: contract.task.objective,
		acceptanceCriteria: contract.task.acceptance_criteria,
		cwd: deps.cwd,
		changedFiles: change.changedFiles,
		evidence: change.evidence,
		executorSummary: "the executor reports the change is complete and deterministically verified",
		...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
	});
	const outcome = await review(built.packet, gate.level, "gate" as ReviewMode, {
		registry: deps.registry,
		cwd: deps.cwd,
		...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
		...(deps.reviewRunner ? { runner: deps.reviewRunner } : {}),
		...(deps.spawn ? { spawn: deps.spawn } : {}),
		...(deps.env ? { env: deps.env } : {}),
	});
	return { level: gate.level, verdict: outcome.verdict, skipped: false };
}
