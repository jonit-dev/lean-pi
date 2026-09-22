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
 *
 * Shape matters as much as content here. Pi hands an extension `notify(string)`
 * with three levels and no markup, so a report written as prose arrives as one
 * flat block of body text — which is what made a proved turn and a blocked one
 * look identical at a glance. The glyph carries the verdict (the terminal
 * colours it, with no theme involved) and the aligned label column carries the
 * structure.
 */
import type { TurnContext } from "../commands/session.js";
import { aggregate } from "../verify/aggregate.js";

/** Verdict glyphs. The terminal renders these in colour regardless of the Pi theme. */
const PASS = "✅";
const WARN = "⚠️";
const FAIL = "❌";

/** Width of the label column, so every detail line starts at the same offset. */
const LABEL_WIDTH = 10;

/** `   verified   PASS · pnpm test` */
function detail(label: string, value: string): string {
	return `   ${label.padEnd(LABEL_WIDTH)}${value}`;
}

/** POSIX single-quote a displayed path, so a space in a checkout path survives a copy-paste. */
function shellPath(path: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll("'", () => "'\\''")}'`;
}

/** The headline: what the proof gate decided, or why no decision exists. */
function headline(context: TurnContext): string {
	const executor = context.executor;
	if (!executor) return `${WARN} nothing ran`;
	if (executor.status === "blocked") return `${FAIL} blocked — ${executor.blockedReason ?? "no backend completed the task"}`;
	const decision = context.proof?.decision;
	// "the proof gate did not run" named the machinery; what the user needs to
	// know is that the claim in front of them has nothing standing behind it.
	if (decision === undefined) return `${WARN} completed, but nothing verified it`;
	return decision === "PASS" ? `${PASS} completed and proved` : `${FAIL} completed, but the proof gate said ${decision}`;
}

/** What JEV did for this one turn: what it answered, and what fell back without it. */
export interface TurnJev {
	answered: number;
	fellBack: number;
	enabled: boolean;
}

/**
 * JEV is the one component a user has no way to observe. It is never a tool, it
 * prints nothing, and a turn it routed is indistinguishable from a turn that
 * took the hard-coded defaults — so "is this thing even on?" had no answer
 * anywhere on screen. One line per turn, in the report the user already reads.
 */
function describeJev({ answered, fellBack, enabled }: TurnJev): string {
	const decisions = (count: number): string => `${count} decision${count === 1 ? "" : "s"}`;
	if (!enabled) return "JEV off — routing and selection took their built-in defaults";
	if (answered === 0) return `JEV answered nothing${fellBack > 0 ? ` — ${decisions(fellBack)} took the built-in defaults` : ""}`;
	return `JEV answered ${decisions(answered)}${fellBack > 0 ? `, ${fellBack} took defaults` : ""}`;
}

const MAX_LISTED_FILES = 10;

/** `info` for a proved turn, `warning` for an unproved one, `error` for a blocked one. */
export function outcomeLevel(context: TurnContext): "info" | "warning" | "error" {
	const executor = context.executor;
	if (!executor || executor.status === "blocked") return "error";
	const decision = context.proof?.decision;
	if (decision === "PASS") return "info";
	return decision === undefined ? "warning" : "error";
}

/**
 * The turn's result as the user's only report of it. Every line is something
 * the turn produced: no line is rendered for a stage that did not run.
 */
export function renderTurnOutcome(context: TurnContext, jev?: TurnJev): string {
	const executor = context.executor;
	const lines = [headline(context)];
	if (jev) lines.push(detail("decided", describeJev(jev)));
	if (!executor) return lines.join("\n");

	if (executor.changedFiles.length > 0) {
		const listed = executor.changedFiles.slice(0, MAX_LISTED_FILES);
		const rest = executor.changedFiles.length - listed.length;
		lines.push(detail("changed", `${listed.join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`));
	} else if (executor.summary) {
		// A task that needed no patch — a question — and the vendor's answer is
		// the whole result. Before the transport stopped calling that a failure
		// this text was discarded and the chain paid a second provider for it.
		lines.push(executor.summary);
	}

	if (executor.evidence.length > 0) {
		const how = executor.commands.length > 0 ? executor.commands.join(" · ") : `${executor.evidence.length} record(s)`;
		lines.push(detail("verified", `${aggregate(executor.evidence)} · ${how}`));
	} else {
		lines.push(detail("verified", "nothing — no verifier ran for this task"));
	}

	const review = executor.review;
	if (!review.skipped && review.verdict) lines.push(detail("review", `${review.verdict.decision} (${review.level})`));

	// The gate's own answer, per criterion, for anything it would not pass: "not
	// proved" is only actionable when it says which criterion and why.
	const unproved = (context.proof?.criteria ?? []).filter((criterion) => criterion.decision !== "PASS");
	for (const criterion of unproved) {
		lines.push(detail("unproved", `${WARN} ${criterion.id} ${criterion.decision} — ${criterion.reasons.join("; ")}`));
	}

	if (context.goal?.decision === "stop") lines.push(detail("goal", `${context.goal.stop} — ${context.goal.reason}`));

	// PRD-022: an isolated run's edits are not in this checkout. Name where the
	// captured patch is and the explicit step that applies it; LeanPi never
	// auto-applies over the operator's own working tree.
	const isolation = context.isolation;
	if (isolation?.patchPath) {
		const apply = isolation.diffPath ? `git apply ${shellPath(isolation.diffPath)}` : `the patch manifest at ${shellPath(isolation.patchPath)}`;
		lines.push(detail("isolated", `${isolation.paths.length} change(s) saved; apply explicitly: ${apply}`));
	}
	if (isolation?.retained) {
		const extra = isolation.retained.paths.length > 0 ? `; it could not account for: ${isolation.retained.paths.join(", ")}` : "";
		lines.push(detail("kept", `${shellPath(isolation.retained.path)} was retained — ${isolation.retained.reason}${extra}`));
	}
	return lines.join("\n");
}
