/**
 * The goal engine (PRD-013, FR-130–FR-136, ROADMAP §42/§43/§51).
 *
 * `src/index.ts` re-exports this module. Nothing here schedules, polls or spins:
 * the engine is one pure evaluation function the executor calls at a boundary,
 * plus the record it reads and the `/goal` command that sets it.
 */
export { splitClauses, type GoalClause, type GoalClauseKind } from "./clauses.js";
export {
	createGoalStore,
	DEFAULT_MAX_COST,
	DEFAULT_MAX_TURNS,
	defaultGoalLimits,
	GOAL_STATE_PATH_DEFAULT,
	GOAL_USAGE,
	goalStatePath,
	goalTextSource,
	newGoalState,
	parseGoalArgs,
	type GoalArgs,
	type GoalState,
	type GoalStore,
} from "./state.js";
export {
	checkBudget,
	costReader,
	formatGoal,
	sessionCost,
	STOP_PRECEDENCE,
	type BudgetCheck,
	type GoalStop,
} from "./limits.js";
export {
	DERIVED_GOAL_SENTENCE,
	derivedCriterionClauses,
	derivedGoalText,
	prdGoalSource,
	resolveCriterionText,
	type CriterionResolution,
	type PrdGoalSource,
} from "./from-prd.js";
export {
	evaluateGoal,
	GOAL_SEMANTIC_FALLBACK,
	GOAL_SEMANTIC_QUESTION_ID,
	GOAL_SEMANTIC_SITE_ID,
	GOAL_SEMANTIC_TELEMETRY_TAG,
	registerGoalSites,
	runGoalLoop,
	semanticQuestion,
	type ClauseOutcome,
	type GoalBoundaryDeps,
	type GoalEvaluation,
	type GoalJev,
	type GoalLoopDeps,
	type GoalLoopResult,
	type RemainingWork as GoalRemainingWork,
	type RemainingWorkItem,
	type RemainingWorkSource,
} from "./boundary.js";
export { createGoalHandler, registerGoalCommands, type GoalCommandDeps } from "./command.js";
