/**
 * What the user is shown when LeanPi ran the turn itself.
 *
 * On an external-harness configuration LeanPi's own executor lane does the
 * work: it spawns the vendor, runs the verifiers, asks the reviewer and puts
 * the result through the proof gate. None of that reached the screen — the
 * lane ran inside `before_agent_start` and the user then watched Pi's loop
 * answer the same prompt a second time. This renders the turn LeanPi actually
 * ran, and it is deliberately the *claim plus its evidence*: the decision, the
 * verifiers that produced it, and what remains unproved.
 */
import type { TurnContext } from "../commands/session.js";
import { aggregate } from "../verify/aggregate.js";

/** The one-word headline: what the proof gate decided, or why no decision exists. */
function headline(context: TurnContext): string {
	const executor = context.executor;
	if (!executor) return "LeanPi: nothing ran";
	if (executor.status === "blocked") return `LeanPi: blocked — ${executor.blockedReason ?? "no backend completed the task"}`;
	const decision = context.proof?.decision;
	if (decision === undefined) return "LeanPi: completed — unverified (the proof gate did not run)";
	return `LeanPi: ${decision === "PASS" ? "completed and proved" : `completed — proof ${decision}`}`;
}

const MAX_LISTED_FILES = 10;

/**
 * The turn's result as the user's only report of it. Every line is something
 * the turn produced: no line is rendered for a stage that did not run.
 */
export function renderTurnOutcome(context: TurnContext): string {
	const executor = context.executor;
	const lines = [headline(context)];
	if (!executor) return lines.join("\n");

	if (executor.changedFiles.length > 0) {
		const listed = executor.changedFiles.slice(0, MAX_LISTED_FILES);
		const rest = executor.changedFiles.length - listed.length;
		lines.push(`changed: ${listed.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`);
	} else if (executor.summary) {
		// A task that needed no patch — a question — and the vendor's answer is
		// the whole result. Before the transport stopped calling that a failure
		// this text was discarded and the chain paid a second provider for it.
		lines.push(executor.summary);
	}

	if (executor.evidence.length > 0) {
		lines.push(`verification: ${aggregate(executor.evidence)} — ${executor.commands.length > 0 ? executor.commands.join(" · ") : `${executor.evidence.length} record(s)`}`);
	} else {
		lines.push("verification: no verifier ran for this task");
	}

	const review = executor.review;
	if (!review.skipped && review.verdict) lines.push(`review (${review.level}): ${review.verdict.decision}`);

	// The gate's own answer, per criterion, for anything it would not pass: "not
	// proved" is only actionable when it says which criterion and why.
	const unproved = (context.proof?.criteria ?? []).filter((criterion) => criterion.decision !== "PASS");
	for (const criterion of unproved) lines.push(`unproved ${criterion.id}: ${criterion.decision} — ${criterion.reasons.join("; ")}`);

	if (context.goal?.decision === "stop") lines.push(`goal: ${context.goal.stop} — ${context.goal.reason}`);
	return lines.join("\n");
}
