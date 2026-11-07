/**
 * Goal continuation: what keeps a `/goal` running after the model stops.
 *
 * Pi's loop ends a run when the model stops calling tools. With a goal active,
 * that is not the end: the settled turn is followed by a prompt to keep going,
 * until the model's last line says `GOAL_MET` or `BLOCKED: <reason>`, a cap is
 * hit, `/goal stop` clears it, or a continuation turn makes no tool call (the
 * guard that keeps a talking-only model from spinning). "Done" is the model's
 * own report here — the owner chose that over an evidence-only judge, which
 * cannot decide a free-text goal such as "execute PRD-828".
 */
import { checkBudget } from "./limits.js";
import { isRunningHere, type GoalState, type GoalStore } from "./state.js";

export const GOAL_CONTINUE_PREFIX = "↻ goal still active:";

export interface SettledTurn {
	/** The last reply ended normally: not aborted, not a provider error. */
	completed: boolean;
	/** The run made at least one tool call. */
	usedTools: boolean;
	/** The user message that started the run, when there was one. */
	ask: string | undefined;
	/** The last assistant reply's text. */
	answer: string;
}

export type GoalNext = { continue: string } | { stopped: string } | undefined;

/** The last non-empty line, with markdown emphasis and quote marks removed. */
function lastLine(text: string): string {
	const lines = text.split("\n").map((line) => line.replace(/[*`>#]/g, "").trim()).filter((line) => line.length > 0);
	return lines.at(-1) ?? "";
}

export function goalContinuation(store: GoalStore, sessionId: string | undefined, turn: SettledTurn, costSoFar: () => number): GoalNext {
	const goal = store.load();
	if (!isRunningHere(goal, sessionId) || !turn.completed) return undefined;
	const next: GoalState = { ...(goal as GoalState), turns_used: (goal as GoalState).turns_used + 1 };
	const stop = (reason: string): GoalNext => {
		store.save({ ...next, active: false });
		return { stopped: reason };
	};

	const last = lastLine(turn.answer);
	if (last === "GOAL_MET") return stop(`GOAL_MET: "${next.text}"`);
	const blocked = /^BLOCKED:\s*(.+)$/.exec(last);
	if (blocked) return stop(`BLOCKED: ${blocked[1]}`);
	if (turn.ask?.startsWith(GOAL_CONTINUE_PREFIX) && !turn.usedTools) {
		return stop("BLOCKED: a goal turn made no tool call and gave no GOAL_MET or BLOCKED line");
	}
	const budget = checkBudget(next, costSoFar());
	if (budget.exceeded) return stop(`BUDGET_EXCEEDED: ${budget.reason}`);

	store.save(next);
	return {
		continue: `${GOAL_CONTINUE_PREFIX} "${next.text}"\nKeep working toward it now. Decide open questions yourself. When the goal is fully done and verified, end your reply with the line GOAL_MET. If only the user can unblock it, end with the line BLOCKED: <reason>.`,
	};
}
