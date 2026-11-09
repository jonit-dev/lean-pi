/**
 * Goal continuation: what keeps a `/goal` running after the model stops.
 *
 * Pi's loop ends a run when the model stops calling tools. With a goal active,
 * that is not the end: the settled turn is followed by a prompt to keep going,
 * until the model confirms `GOAL_MET` or `BLOCKED: <reason>` on a check turn (a
 * first claim of either only starts that turn), a cap is hit, `/goal stop`
 * clears it, or a continuation turn makes no tool call (the guard that keeps a
 * talking-only model from spinning). A confirmed `BLOCKED` waits for the user:
 * their next message in the session resumes the goal. "Done" is the model's
 * own report here — the owner chose that over an evidence-only judge, which
 * cannot decide a free-text goal such as "execute PRD-828".
 */
import { checkBudget } from "./limits.js";
import { isRunningHere, type GoalState, type GoalStore } from "./state.js";

export const GOAL_CONTINUE_PREFIX = "↻ goal still active:";
/** Starts the turn that must confirm a GOAL_MET claim before the goal stops. */
export const GOAL_VERIFY_PREFIX = "↻ goal claimed met, verify it:";
/** Starts the turn that must confirm a BLOCKED claim before the goal waits for the user. */
export const GOAL_BLOCKED_PREFIX = "↻ goal claimed blocked, check it:";

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
	const stored = store.load();
	// The user answering a goal that waited on them is what unblocks it.
	const resumed = stored?.blocked === true && turn.ask !== undefined && !turn.ask.startsWith("↻ goal");
	const goal = resumed ? { ...(stored as GoalState), active: true, blocked: false } : stored;
	if (!isRunningHere(goal, sessionId) || !turn.completed) return undefined;
	const next: GoalState = { ...(goal as GoalState), turns_used: (goal as GoalState).turns_used + 1 };
	const stop = (reason: string, blocked = false): GoalNext => {
		store.save({ ...next, active: false, ...(blocked ? { blocked: true } : {}) });
		return { stopped: reason };
	};

	const last = lastLine(turn.answer);
	// One GOAL_MET is a claim, not proof: models call a goal met while their own
	// reply lists open work. Only a GOAL_MET that answers the verify turn stops.
	const verified = turn.ask?.startsWith(GOAL_VERIFY_PREFIX) === true;
	if (last === "GOAL_MET" && verified) return stop(`GOAL_MET: "${next.text}"`);
	// BLOCKED is a claim too: a model blocked on one part stopped a roadmap with
	// independent parts still open. Only a BLOCKED that answers the check turn stops.
	const blocked = /^BLOCKED:\s*(.+)$/.exec(last);
	if (blocked && turn.ask?.startsWith(GOAL_BLOCKED_PREFIX)) return stop(`BLOCKED: ${blocked[1]} — your next message resumes the goal`, true);
	if (turn.ask?.startsWith(GOAL_CONTINUE_PREFIX) && !turn.usedTools) {
		return stop("BLOCKED: a goal turn made no tool call — your next message resumes the goal", true);
	}
	const budget = checkBudget(next, costSoFar());
	if (budget.exceeded) return stop(`BUDGET_EXCEEDED: ${budget.reason}`);

	store.save(next);
	if (blocked) {
		return {
			continue: `${GOAL_BLOCKED_PREFIX} "${next.text}"\nYou ended with BLOCKED: ${blocked[1]}. That blocks one part, not the goal. Work now on every other part that does not need the user. Decide open questions yourself: when you offered options, take the recommended one. End with the line BLOCKED: <reason> only if no part of the goal can move without the user.`,
		};
	}
	if (last === "GOAL_MET") {
		return {
			continue: `${GOAL_VERIFY_PREFIX} "${next.text}"\nYou ended with GOAL_MET. Check it before the goal stops. Re-read the goal and list every part it asks for, each with the evidence that it is done. Any open part, a PARTIAL item, a PRD still in active/, or a step you handed to the user that you can run yourself (tests, laptop runs, e2e, builds) means the goal is not met: keep working on it now. End with the line GOAL_MET only if nothing is left. If only the user can unblock it, end with the line BLOCKED: <reason>.`,
		};
	}
	return {
		continue: `${GOAL_CONTINUE_PREFIX} "${next.text}"\nKeep working toward it now. Decide open questions yourself. When the goal is fully done and verified, end your reply with the line GOAL_MET. If only the user can unblock it, end with the line BLOCKED: <reason>.`,
	};
}
