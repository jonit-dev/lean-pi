/**
 * Limits and stop conditions (PRD-013 Phase 3, FR-133/FR-135).
 *
 * The budget is read *before* any evidence refresh or JEV call, so an exhausted
 * goal costs zero inference — that ordering, not the arithmetic, is what this
 * module exists to make explicit. Cost is PRD-015's accumulated `effective_cost`
 * read off the run store; this module computes no pricing.
 */
import { resolveCostConfig, type CostConfig } from "../telemetry/pricing.js";
import { readRuns } from "../telemetry/store.js";
import type { LeanPiConfig } from "../core/types.js";
import { DEFAULT_MAX_COST, DEFAULT_MAX_TURNS, type GoalState } from "./state.js";

/** The five stop conditions of ROADMAP §42 (FR-136). */
export type GoalStop = "GOAL_MET" | "GOAL_IMPOSSIBLE" | "BLOCKED" | "BUDGET_EXCEEDED" | "USER_STOPPED";

/**
 * Fixed precedence: the user's own stop outranks the budget, the budget outranks
 * everything the evaluator could spend, an impossible clause outranks a plain
 * gap, and `GOAL_MET` is only ever reached when nothing above it fired.
 */
export const STOP_PRECEDENCE: readonly GoalStop[] = [
	"USER_STOPPED",
	"BUDGET_EXCEEDED",
	"GOAL_IMPOSSIBLE",
	"BLOCKED",
	"GOAL_MET",
];

export function money(usd: number): string {
	return `$${usd.toFixed(2)}`;
}

export interface BudgetCheck {
	exceeded: boolean;
	reason: string;
}

/** `turns_used` is already incremented for this boundary, so the cap is `>=`. */
export function checkBudget(state: GoalState, costSoFar: number): BudgetCheck {
	const maxTurns = state.max_turns > 0 && Number.isFinite(state.max_turns) ? state.max_turns : DEFAULT_MAX_TURNS;
	const maxCost = state.max_cost > 0 && Number.isFinite(state.max_cost) ? state.max_cost : DEFAULT_MAX_COST;
	// A counter that is not a finite number is a corrupt record, and the safe
	// reading of one is "this goal has had its turns": never an unbounded loop.
	const used = Number.isFinite(state.turns_used) ? state.turns_used : maxTurns;
	if (used >= maxTurns) {
		return { exceeded: true, reason: `turns ${used}/${maxTurns}` };
	}
	if (costSoFar >= maxCost) {
		return { exceeded: true, reason: `cost ${money(costSoFar)}/${money(maxCost)}` };
	}
	return { exceeded: false, reason: `turns ${used}/${maxTurns}, cost ${money(costSoFar)}/${money(maxCost)}` };
}

/** PRD-015's accumulated cost for the session, summed from the stored records. */
export function sessionCost(cwd: string, sessionId?: string, cost?: CostConfig): number {
	const runs = readRuns(cwd, sessionId === undefined ? {} : { sessionId }, cost);
	return runs.reduce((total, run) => total + (run.cost?.effective_cost ?? 0), 0);
}

/** The default `costSoFar` a boundary uses; a caller with a live collector injects its own. */
export function costReader(cwd: string, sessionId?: string, config?: LeanPiConfig): () => number {
	const cost = resolveCostConfig(config);
	return () => sessionCost(cwd, sessionId, cost);
}

/** The active goal as `/goal` echoes it: text plus both axes of the budget. */
export function formatGoal(state: GoalState, costSoFar: number): string {
	const verb = state.active ? "active" : "stopped";
	return `goal "${state.text}" is ${verb} (turns ${state.turns_used}/${state.max_turns}, cost ${money(costSoFar)}/${money(state.max_cost)})`;
}
