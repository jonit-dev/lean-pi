/**
 * `/goal` — set, show, derive and stop (PRD-013 Phase 1 and 4, ROADMAP §51).
 *
 * Registered through PRD-016's command registry; the handler owns no grammar
 * beyond the two flags and no state beyond `state.ts`. `/goal <text>` sets an
 * explicit goal and `/goal` with an active PRD derives one from PRD-012's
 * remaining criteria — a session with neither gets usage rather than an inert
 * goal, because a goal that can never be evaluated is worse than no goal.
 */
import type { CommandContext, CommandHandler, CommandRegistry, CommandResult } from "../commands/registry.js";
import type { LeanPiConfig } from "../core/types.js";
import type { PrdState } from "../prd/state.js";
import { derivedCriterionClauses, derivedGoalText, prdGoalSource } from "./from-prd.js";
import { costReader, formatGoal } from "./limits.js";
import {
	GOAL_USAGE,
	createGoalStore,
	defaultGoalLimits,
	newGoalState,
	parseGoalArgs,
	type GoalStore,
} from "./state.js";

export interface GoalCommandDeps {
	/** Project root; `CommandContext.cwd` wins when the dispatcher supplies one. */
	cwd: string;
	config?: LeanPiConfig;
	store?: GoalStore;
	/** PRD-012's active state. Absent means bare `/goal` has nothing to derive from. */
	prd?: () => PrdState | null;
	/** Cost the echo reports; defaults to the project's PRD-015 run store. */
	costSoFar?: () => number;
	sessionId?: string;
	now?: () => Date;
}

export function createGoalHandler(deps: GoalCommandDeps): CommandHandler {
	return (args: string, context: CommandContext): CommandResult | Promise<CommandResult> => {
		const cwd = context.cwd || deps.cwd;
		const store = deps.store ?? createGoalStore(cwd);
		const parsed = parseGoalArgs(args);
		if (parsed.error) return { ok: false, text: parsed.error };
		const costSoFar = deps.costSoFar ?? costReader(cwd, deps.sessionId, deps.config);
		const now = deps.now ?? (() => new Date());

		if (parsed.stop) {
			const goal = store.load();
			if (!goal || !goal.active) return { ok: false, text: "no active goal to stop" };
			store.save({ ...goal, active: false });
			return { ok: true, text: `USER_STOPPED: ${formatGoal({ ...goal, active: false }, costSoFar())}` };
		}

		if (parsed.text.length > 0) {
			const limits = defaultGoalLimits(deps.config);
			const goal = newGoalState(
				parsed.text,
				{
					max_turns: parsed.maxTurns ?? limits.max_turns,
					max_cost: parsed.maxCost ?? limits.max_cost,
				},
				now().toISOString(),
			);
			store.save(goal);
			return { ok: true, text: `goal set: ${formatGoal(goal, costSoFar())}` };
		}

		const prd = deps.prd?.() ?? null;
		if (!prd) {
			return { ok: false, text: `no active PRD to derive a goal from; ${GOAL_USAGE}` };
		}
		const clauses = derivedCriterionClauses(prdGoalSource(() => prd));
		if (clauses.length === 0) {
			return {
				ok: false,
				text: `the active PRD ${prd.prdId} has no remaining acceptance criteria; ${GOAL_USAGE}`,
			};
		}
		const goal = newGoalState(derivedGoalText(clauses), defaultGoalLimits(deps.config), now().toISOString());
		store.save(goal);
		return {
			ok: true,
			text: `derived goal from ${prd.prdId}: ${clauses.map((clause) => clause.criterion).join(", ")} — ${formatGoal(goal, costSoFar())}`,
		};
	};
}

/** Registers `/goal`; a later session supersedes the earlier handler, like `/skills` and `/prd`. */
export function registerGoalCommands(registry: CommandRegistry, deps: GoalCommandDeps): void {
	if (registry.has("goal")) registry.unregister("goal");
	registry.register("goal", createGoalHandler(deps));
}
