/**
 * Executor lane barrel (PRD-007). `src/index.ts` re-exports this module.
 */
export {
	EXECUTOR_TASK_KEYS,
	renderExecutorPrompt,
	runExecutor,
	toExecutorTask,
} from "./lane.js";
export {
	classifyFailure,
	FAILURE_CATEGORIES,
	FAILURE_SITE_ID,
	failureCategoryRule,
	registerRetrySites,
	RETRY_SITE_ID,
	RETRY_USEFULNESS_THRESHOLD,
	retryUseful,
} from "./sites.js";
export type { FailureCategory } from "./sites.js";
export { strategyFor } from "./lane.js";
export type { ExecutorSiteRow, ExecutorWorker, ExecutorReviewOutcome, ExecutorDeps, ExecutorInvocation, ExecutorOutcome, ExecutorTask } from "./lane.js";
export {
	failureSignature,
	normalizeDiagnostic,
	nextAttempt,
	recordAttempt,
	ROLE_LADDER,
	spendAttempt,
	spendEscalation,
	stepRole,
} from "./retry.js";
export type { AttemptStrategy, FailureInput, RetryBudget, RetryDecision, RetryRecord } from "./retry.js";
export {
	classifyEscalation,
	CLARIFICATION_QUESTION,
	CLARIFICATION_SITE_ID,
	CONTINUING_CATEGORIES,
	ESCALATION_CATEGORIES,
	ESCALATION_QUESTION,
	ESCALATION_SITE_ID,
	escalate,
	fallbackCategory,
	needsClarification,
	registerExecutorSites,
} from "./escalation.js";
export type { EscalationAction, EscalationCategory, EscalationDecision, EscalationInput } from "./escalation.js";
