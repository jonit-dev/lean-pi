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
import { modelFor, runWorkerTurn } from "../backends/index.js";
import type { RunWorkerTurnOptions } from "../backends/registry.js";
import type { WorkerTaskPacket, WorkerTurnOutcome } from "../backends/worker.js";
import type { CapabilitySlots, ExecutionContract } from "../compiler/contract.js";
import type { LeanPiConfig, ModelRole, SelectedSkill } from "../core/types.js";
import type { ClearingSource } from "../routing/candidates.js";
import { dispatchRequest, effortParameterOf, selectRoute } from "../routing/router.js";
import type { RouteCostBlock } from "../telemetry/record.js";
import type { EvidenceRecord, EvidenceStore } from "../verify/evidence.js";
import type { ShellExec } from "../verify/run.js";
import { verifyTask } from "../verify/index.js";
import { classifyReview, securitySensitivePathsIn } from "../review/gate.js";
import { review, type Independence, type ReviewMode, type ReviewRunner } from "../review/lane.js";
import { buildPacket } from "../review/packet.js";
import type { ActiveReviewLevel, ReviewLevel, ReviewVerdict } from "../review/schema.js";
import { classifyEscalation, escalate, needsClarification, type EscalationCategory } from "./escalation.js";
import { nextAttempt, recordAttempt, type AttemptStrategy, type FailureInput, type RetryBudget, type RetryRecord } from "./retry.js";
import { classifyFailure, retryUseful, FAILURE_SITE_ID, RETRY_SITE_ID, type FailureCategory } from "./sites.js";

/** The six §28 fields, and nothing else. */
export const EXECUTOR_TASK_KEYS = ["objective", "acceptanceCriteria", "context", "capabilities", "budget", "retryLimit"] as const;

/** The row that records which identity PRD-020's router chose for the turn. */
export const ROUTE_SITE_ID = "routing.select_route";

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
	/** Whether the reviewer differed from the executor; `null` when no reviewer ran. */
	independence: Independence | null;
}

export interface ExecutorOutcome {
	status: "completed" | "blocked";
	changedFiles: string[];
	/**
	 * The workspace hash PRD-009 stamped this turn's records with. A gate reading
	 * those records has to use this hash, not a fresh one: verification recomputes
	 * it after the verifiers ran, so an independently computed hash would make
	 * every record read as stale.
	 */
	workspaceHash?: string;
	evidence: EvidenceRecord[];
	/** The verification command lines this turn resolved, in execution order. */
	commands: string[];
	retryHistory: RetryRecord[];
	invocations: ExecutorInvocation[];
	review: ExecutorReviewOutcome;
	/**
	 * What the backend answered, when it answered rather than edited. A task that
	 * needed no patch — "explain this function" — used to be classified as a
	 * failed invocation and its text thrown away; now the transport reports the
	 * success and this is the only place the answer survives to a caller.
	 */
	summary?: string;
	blockedReason?: string;
	escalations: EscalationCategory[];
	/** One row per decision-site call this turn (FR-020, §56). */
	sites: ExecutorSiteRow[];
	/** Set when a `USER_INPUT` escalation cleared the clarification site. */
	question?: string;
	/** Recorded when the lane proceeded on a stated assumption instead of asking. */
	assumption?: string;
	/** PRD-020's pre-dispatch prediction, when the router decided this turn's identity. */
	route_cost?: RouteCostBlock;
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
	/**
	 * PRD-023's pre-generation selection, as the executor lane passes it: the
	 * excerpts of the files the governor chose, prepended to the worker prompt so
	 * the executor starts from a bounded selection rather than reading the
	 * repository itself.
	 */
	selection?: { excerpts: string };
	/** Test seam: PRD-020's clearing candidate source; defaults to the bundled ranking. */
	clearing?: ClearingSource;
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

/** The §44 tool vocabulary one executor attempt may use. */
const EXECUTOR_TOOLS = ["read", "search", "edit", "write", "execute"] as const;

/**
 * The concrete difference an escalation or a review round makes to the next
 * packet. The gate names the change; the lane fills in what only it knows —
 * which files moved, what the failure said, which backend's effort parameter is
 * in play — so no escalated attempt repeats the packet it just failed on.
 */
interface NextAttempt {
	/** Prompt lines naming what changed and what failed. */
	lines: string[];
	/** Extra files the next packet asks for. */
	files?: string[];
	/** Extra packet fields, e.g. the backend's own effort parameter. */
	fields?: Record<string, unknown>;
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
	/** The files the last attempt reported changing; `GET_MORE_CONTEXT` widens with them. */
	let lastChangedFiles: string[] = [];
	/** What the next attempt must do differently; consumed by the next packet. */
	let nextDirective: NextAttempt | null = null;
	/** Reviewers that returned a non-`PASS` verdict, against `limits.semantic_review_rounds`. */
	let reviewRounds = 0;
	/** The hash the verifier stamped its records with, carried on the outcome. */
	let verifiedHash: string | undefined;

	// PRD-020 (F1): the identity this turn dispatches at is the router's, decided
	// once from the frozen contract. Nothing below re-derives a model: the routed
	// candidate is pinned into the packet and every other backend is held out of
	// the chain until the turn burns or escalates off it.
	const route = await selectRoute({
		contract,
		config: deps.config,
		cwd: deps.cwd,
		...(deps.jev ? { client: deps.jev } : {}),
		...(deps.clearing ? { clearing: deps.clearing } : {}),
	});
	for (const row of route.telemetry) sites.push({ site: row.site_id, answer: row.answer, fallbackUsed: row.fallback_used });
	const routed = route.selected;
	// A capability gap is recorded, never silent: the pool's own role chain runs
	// the turn, and the row says the cost-aware choice did not decide it.
	sites.push({
		site: ROUTE_SITE_ID,
		answer: routed ? `${routed.candidate.backend}/${routed.candidate.model}` : route.reason,
		fallbackUsed: routed === null,
	});
	if (routed) {
		role = routed.candidate.roles.includes(role) ? role : (routed.candidate.roles[0] ?? role);
	}
	/** The routed identity, while it is still the one the chain must dispatch. */
	let routedIdentity: { backend: string; model: string } | null = routed ? { backend: routed.candidate.backend, model: routed.candidate.model } : null;
	/** Everything the routed backend is preferred over; dropped with the pin. */
	let routeExclusions: string[] = routed ? deps.registry.backends.filter((backend) => backend.name !== routed.candidate.backend).map((backend) => backend.name) : [];
	// A burned or escalated-away route is no longer this turn's identity, and
	// holding its exclusions would strand FR-046's fallback chain.
	const abandonRoute = (): void => {
		routedIdentity = null;
		routeExclusions = [];
	};

	const blocked = (reason: string, review?: ExecutorReviewOutcome): ExecutorOutcome => ({
		status: "blocked",
		changedFiles: [],
		...(verifiedHash ? { workspaceHash: verifiedHash } : {}),
		evidence,
		commands,
		retryHistory,
		invocations,
		review: review ?? { level: "NO_SEMANTIC_REVIEW", verdict: null, skipped: true, independence: null },
		blockedReason: reason,
		escalations,
		sites,
		...(question ? { question } : {}),
		...(assumption ? { assumption } : {}),
		...(route.route_cost ? { route_cost: route.route_cost } : {}),
	});

	for (;;) {
		if (budget.attemptsUsed >= budget.executionAttempts) {
			return blocked(`the attempt budget of ${budget.executionAttempts} is exhausted`);
		}
		budget.attemptsUsed += 1;

		// The directive belongs to exactly one attempt: whatever it widened or
		// raised applies to the invocation about to run, not to every later one.
		const carried = nextDirective;
		nextDirective = null;
		const widened = carried?.files ? [...new Set([...task.context.files, ...carried.files])] : task.context.files;
		const promptTask = widened === task.context.files ? task : { ...task, context: { ...task.context, files: widened } };

		// PRD-020 dispatches the identity the router named: the model is pinned on
		// the packet so `modelFor` cannot re-derive a different one, the effort the
		// router decided travels under the backend's own parameter name, and an
		// escalation's directive still wins over both.
		const packet = dispatchRequest(
			{
				objective: task.objective,
				role,
				prompt: [renderExecutorPrompt(promptTask), ...(deps.selection ? [deps.selection.excerpts] : []), ...(carried?.lines ?? [])].join("\n"),
				...(widened.length > 0 ? { files: [...widened] } : {}),
				allowedTools: [...EXECUTOR_TOOLS],
				budget: task.budget,
				...(routedIdentity ? { model: routedIdentity.model } : {}),
				// The effort the compiler decided for this turn. On a native backend
				// it arrives as the session thinking level; a vendor CLI has its own
				// setting — `xhigh` by default on the machine this was written on —
				// and only sees LeanPi's decision if the packet carries it.
				effort: contract.reasoning.effort,
			},
			route,
			deps.config,
		);
		const outcome = await worker(
			{ ...packet, ...(carried?.fields ?? {}) },
			{
				registry: deps.registry,
				cwd: deps.cwd,
				...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
				...(deps.spawn ? { spawn: deps.spawn } : {}),
				...(deps.env ? { env: deps.env } : {}),
				...(deps.now ? { now: deps.now } : {}),
				exclude: [...new Set([...excludeBackends, ...routeExclusions])],
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
			lastChangedFiles = [...outcome.result.changedFiles];
			const result = await verifyTask(contract, deps.cwd, {
				...(deps.store ? { store: deps.store } : {}),
				...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
				...(deps.jev ? { jev: deps.jev } : {}),
				config: deps.config,
				touchedPaths: outcome.result.changedFiles,
				// B4: the verifier can only widen the regression scope when it is told
				// what the diff touched; without it `regressionScopeRule(undefined)`
				// answers `TARGETED_SUFFICIENT` by construction.
				diff: { files: [...outcome.result.changedFiles], ...(outcome.result.changedFilesUnknown ? { unknown: true } : {}) },
				...(deps.verifyCommands ? { commands: deps.verifyCommands } : {}),
				...(deps.exec ? { exec: deps.exec } : {}),
			});
			evidence.push(...result.records);
			commands.push(...result.commands);
			verifiedHash = result.workspaceHash;

			if (result.status === "pass") {
				const ranBackend = outcome.backend ? deps.registry.byName(outcome.backend) : undefined;
				const reviewOutcome = await runReview(contract, deps, {
					changedFiles: outcome.result.changedFiles,
					changedFilesUnknown: outcome.result.changedFilesUnknown === true,
					evidence: result.records,
					failedAttempts: retryHistory.length,
					// F4: the identity that actually ran, so the reviewer lane can prefer
					// a different model and report independence rather than guess.
					...(ranBackend ? { executor: { backend: ranBackend.name, model: modelFor(ranBackend, role) } } : {}),
				});
				const verdict = reviewOutcome.verdict;
				if (reviewOutcome.skipped || !verdict || verdict.decision === "PASS") {
					return {
						status: "completed",
						changedFiles: outcome.result.changedFiles,
						...(verifiedHash ? { workspaceHash: verifiedHash } : {}),
						evidence,
						commands,
						retryHistory,
						invocations,
						review: reviewOutcome,
						...(outcome.result.summary ? { summary: outcome.result.summary } : {}),
						escalations,
						sites,
						...(assumption ? { assumption } : {}),
						...(route.route_cost ? { route_cost: route.route_cost } : {}),
					};
				}

				// F2: a reviewer that did not pass is a failure like any other, and it
				// is bounded by the contract's own round ceiling rather than by the
				// retry ladder the verifier failures use.
				const detail = `${verdict.decision}: ${findingsOf(verdict)}`;
				reviewRounds += 1;
				if (reviewRounds < contract.limits.semantic_review_rounds && budget.attemptsUsed < budget.executionAttempts) {
					// The round lands on the retry history so the next review sees an
					// attempt that failed and its floor can elevate the level.
					recordAttempt(retryHistory, { strategy: "reassess", failure: { kind: "review", detail }, newEvidence: true, model: role, backend: backendName });
					nextDirective = { lines: [`the reviewer will not pass this change — ${detail}`] };
					attemptStrategy = "reassess";
					strategyLabel = "review_fix";
					continue;
				}
				return blocked(`the reviewer requires a fix before this change can pass (${detail})`, reviewOutcome);
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
				if (burned && burned !== "none") {
					excludeBackends = [...excludeBackends, burned];
					// The routed identity is the burned one: holding its exclusions
					// would leave the chain with nothing to fall back to.
					if (burned === routedIdentity?.backend) abandonRoute();
				}
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
		// §34: an escalation moves the route. The router decided the identity for
		// the attempt that failed, so the escalated attempt re-enters the pool's
		// chain on the role the gate chose rather than re-dispatching the same pin.
		abandonRoute();
		attemptStrategy = "escalate";
		strategyLabel = action.category;

		// F7: every continuing category changes the next packet, not just its label.
		// The gate names the change; the attempt-specific detail — which files moved,
		// what failed, which backend's effort parameter is in play — is here.
		const directive = action.directive;
		if (directive) {
			const lines = [`escalation ${action.category}: ${directive.instruction}`, `the previous failure was: ${failure.detail}`];
			const next: NextAttempt = { lines };
			if (directive.widenContext) next.files = [...lastChangedFiles];
			if (directive.nameTools) lines.push(`tools this attempt may use: ${EXECUTOR_TOOLS.join(", ")}`);
			if (directive.raiseEffort) {
				const nextBackend = deps.registry.selectBackend(role, excludeBackends)[0];
				const parameter = nextBackend ? effortParameterOf(deps.config, nextBackend.name) : null;
				// A backend that declares no effort parameter still gets the instruction
				// above: it is told to reason harder, just not in a field of its own.
				if (parameter) next.fields = { [parameter]: "high" };
			}
			if (directive.strongReview) {
				// The change has not passed verification — the escalation gate is why
				// this review happens — so the reviewer is told that, not the pass claim.
				const strong = await runReviewAt(
					contract,
					deps,
					{
						changedFiles: lastChangedFiles,
						evidence,
						failedAttempts: retryHistory.length,
						summary: "the escalation gate asked for a strong review of the current state after a failed attempt",
					},
					"STRONG_REVIEW",
					"strong",
				);
				if (strong.verdict) lines.push(`strong review ${strong.verdict.decision}: ${findingsOf(strong.verdict)}`);
			}
			nextDirective = next;
		}
	}
}

/** A verdict's findings as one line, for a prompt or a blocked reason. */
function findingsOf(verdict: ReviewVerdict): string {
	return verdict.findings.map((finding) => `${finding.severity} ${finding.file}: ${finding.evidence}`).join("; ") || "no findings recorded";
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

/** The change a review reads, plus the identity that ran it when the pool knows it. */
interface ReviewChange {
	changedFiles: readonly string[];
	/** The change set could not be derived; the gate must not read it as "no diff". */
	changedFilesUnknown?: boolean;
	evidence: readonly EvidenceRecord[];
	failedAttempts: number;
	executor?: { backend: string; model: string | null };
	/** What the reviewer is told the executor claims; overridden when nothing passed. */
	summary?: string;
}

async function runReview(contract: ExecutionContract, deps: ExecutorDeps, change: ReviewChange): Promise<ExecutorReviewOutcome> {
	// The review decision is PRD-011's, and nothing here re-implements it: a local
	// `review_risk === 'low'` shortcut would route exactly the changes PRD-011's
	// deterministic floor protects.
	const gate = await classifyReview({
		changedFiles: change.changedFiles,
		...(change.changedFilesUnknown ? { changedFilesUnknown: true } : {}),
		executionComplexity: contract.task.execution_complexity,
		reviewRisk: contract.task.review_risk,
		reviewerClass: contract.routing.reviewer_class,
		failedAttempts: change.failedAttempts,
		securitySensitivePaths: securitySensitivePathsIn(change.changedFiles),
		proofStrength: change.evidence.some((record) => record.status === "pass") ? "strong" : "none",
		...(deps.jev ? { client: deps.jev } : {}),
	});
	if (gate.level === "NO_SEMANTIC_REVIEW") {
		return { level: gate.level, verdict: null, skipped: true, independence: null };
	}
	return runReviewAt(contract, deps, change, gate.level, "gate");
}

/**
 * One reviewer invocation at a fixed level. The gate's review and the
 * `STRONG_REVIEW` escalation's review both go through here, so they cannot
 * disagree about the packet, the deps or the executor identity.
 */
async function runReviewAt(
	contract: ExecutionContract,
	deps: ExecutorDeps,
	change: ReviewChange,
	level: ActiveReviewLevel,
	mode: ReviewMode,
): Promise<ExecutorReviewOutcome> {
	const built = buildPacket({
		objective: contract.task.objective,
		acceptanceCriteria: contract.task.acceptance_criteria,
		cwd: deps.cwd,
		// An unknown set is omitted so the packet falls back to git's own listing
		// instead of presenting an empty `changed_files` beside a real diff.
		changedFiles: change.changedFilesUnknown ? undefined : change.changedFiles,
		evidence: change.evidence,
		executorSummary: change.summary ?? "the executor reports the change is complete and deterministically verified",
		...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
	});
	const outcome = await review(built.packet, level, mode, {
		registry: deps.registry,
		cwd: deps.cwd,
		config: deps.config,
		...(change.executor ? { executor: change.executor } : {}),
		...(deps.agentDir ? { agentDir: deps.agentDir } : {}),
		...(deps.reviewRunner ? { runner: deps.reviewRunner } : {}),
		...(deps.spawn ? { spawn: deps.spawn } : {}),
		...(deps.env ? { env: deps.env } : {}),
	});
	return { level, verdict: outcome.verdict, skipped: false, independence: outcome.independence };
}
