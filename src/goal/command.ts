/**
 * `/goal` — set, show, derive and stop (PRD-013 Phase 1 and 4, ROADMAP §51).
 *
 * Registered through PRD-016's command registry; the handler owns no grammar
 * beyond the two flags and no state beyond `state.ts`. `/goal <text>` sets an
 * explicit goal, bare `/goal` shows the running one, and bare `/goal` with no
 * goal but an active PRD derives one from PRD-012's remaining criteria — a
 * session with neither gets usage rather than an inert goal, because a goal
 * that can never be evaluated is worse than no goal.
 */
import type { CommandContext, CommandHandler, CommandRegistry, CommandResult } from "../commands/registry.js";
import type { LeanPiConfig } from "../core/types.js";
import type { PrdState } from "../prd/state.js";
import { derivedCriterionClauses, derivedGoalText, prdGoalSource } from "./from-prd.js";
import { costReader, formatGoal, money } from "./limits.js";
import {
	GOAL_USAGE,
	createGoalStore,
	defaultGoalLimits,
	isRunningHere,
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
			// A goal left active by an earlier session is still stoppable — clearing
			// the record is exactly how a user gets rid of one they no longer want.
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
				deps.sessionId,
			);
			store.save(goal);
			// Setting a goal starts it. `/goal execute PRD-021` is a task, not a
			// setting: the echo used to say "send a task to begin" and the session
			// then sat idle until the user typed again, which read as a hang.
			const caps = [
				goal.max_turns > 0 ? `${goal.max_turns} turns` : null,
				goal.max_cost > 0 ? money(goal.max_cost) : null,
			].filter((cap) => cap !== null);
			return {
				ok: true,
				text: `✅ goal set — "${goal.text}"\n   starting now${caps.length > 0 ? `, up to ${caps.join(" or ")}` : " — no turn or cost cap"}\n   /goal to check it · /goal stop to drop it`,
				start: goal.text,
			};
		}

		// Inspection must not write. A bare `/goal` while a goal is running echoes
		// it, so the limits and `turns_used` it is judged against survive the look;
		// deriving from the PRD is the empty-state path only.
		const running = store.load();
		if (isRunningHere(running, deps.sessionId)) return { ok: true, text: formatGoal(running as NonNullable<typeof running>, costSoFar()) };
		// An active record from an earlier session is reported, never resumed: it no
		// longer reaches any prompt, and the user is the one who decides it is still
		// wanted. Without this line its disappearance would look like data loss.
		if (running?.active === true) {
			return { ok: true, text: `⚠️ a goal from an earlier session is not running here: "${running.text}"\n   /goal ${running.text} to set it again · /goal stop to drop it` };
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
		const goal = newGoalState(derivedGoalText(clauses), defaultGoalLimits(deps.config), now().toISOString(), deps.sessionId);
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
