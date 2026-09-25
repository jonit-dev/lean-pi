/**
 * The one line the user sees while a turn runs.
 *
 * "Tell me your goal, I figure out the rest" only works if the figuring is
 * visible: the harness silently picking a model, an effort and a lane is
 * indistinguishable from a harness doing nothing. This renders the decisions
 * the compiler made for the turn in flight — but only the ones an operator can
 * read at a glance and act on.
 *
 * What it deliberately does NOT say: which internal lane ran. "Pi loop" and
 * "Executor lane" name LeanPi's own plumbing, and an operator who cannot change
 * the lane cannot use the word.
 */
import type { ExecutionContract } from "../compiler/contract.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExecutionComplexity } from "../compiler/contract.js";
import type { LeanPiConfig, ModelRole, BackendRef } from "../core/types.js";
import { resolveRole } from "../core/roles.js";
import { roleStatus } from "../capability/index.js";

/** The footer slot LeanPi owns; one key, replaced each turn. */
export const LEANPI_STATUS_KEY = "leanpi";

/** The separator between chips; spaced so each chip reads as its own word. */
const SEP = "  \u00b7  ";

/**
 * SGR colour for the status slot.
 *
 * Pi's `setStatus` takes a plain string and passes it to the TUI verbatim —
 * measured, not assumed: a bold sequence written into the slot reaches the
 * terminal intact. The theme cannot reach here (it colours Pi's own chrome, not
 * an extension's status text), so these are ordinary escapes and the palette
 * they resolve against is the terminal's.
 */
const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const DIM = "\u001b[38;5;244m";
/** The one colour that means "act on this": the two warning chips and nothing else. */
const WARN = "\u001b[38;5;208m";
/**
 * `Manual` reads red because a hand-picked model is the operator's own doing:
 * the harness cannot re-route around it, and a silent pin is how a stale
 * `/model` choice keeps spending on the wrong model for a whole session.
 */
const MANUAL = "\u001b[38;5;196m";

/**
 * Effort as a temperature, matching the theme's `thinking*` ramp: cheap and safe
 * is green, costly is red. A scale is readable at a glance in a way that four
 * unrelated hues are not.
 */
const EFFORT_COLOR: Record<ThinkingLevel, string> = {
	off: DIM,
	minimal: "\u001b[38;5;247m",
	low: "\u001b[38;5;77m",
	medium: "\u001b[38;5;221m",
	high: "\u001b[38;5;208m",
	xhigh: "\u001b[38;5;203m",
	max: "\u001b[38;5;196m",
};

/** Pi's level names are already English; only the squashed one needs a hyphen. */
function effortLabel(level: ThinkingLevel): string {
	return level === "xhigh" ? "x-high" : level;
}

/**
 * The compiler's LOW/MEDIUM/HIGH, said the way an operator would say it. The
 * raw enum told the user the harness had an enum, not what it decided.
 */
const COMPLEXITY_LABEL: Record<ExecutionComplexity, string> = {
	LOW: "simple task",
	MEDIUM: "normal task",
	HIGH: "hard task",
};

/** Model ids are vendor strings; this is the name a human recognises. */
export function prettyModel(backend: string, model: string): string {
	if (model === "default" || model.length === 0) return backend;
	// `opencode-go/deepseek-v4.1-flash` → `deepseek-v4.1-flash`
	const bare = model.slice(model.lastIndexOf("/") + 1);
	// `opus[1m]` → `opus (1m)`: the bracket is the vendor's context-window alias.
	return bare.replace(/\[([^\]]+)\]$/, " ($1)");
}

/**
 * The footer while `/model` is pinned and no contract has run this turn
 * (PRD-048 Phase 2): just the pinned model and the mode, colour-matched to
 * `statusLine`'s own — no class, effort or cost to report, because none ran.
 */
export function manualStatusLine(pin: BackendRef, color = false, goal?: string): string {
	const model = prettyModel(pin.backend, pin.model);
	const chip = goalChip(goal);
	return [color === true ? `${BOLD}${model}${RESET}` : model, color === true ? `${MANUAL}Manual${RESET}` : "Manual", ...(chip ? [chip] : [])].join(SEP);
}

/** A running goal, under either mode: nothing else on screen says one is live. */
function goalChip(goal: string | undefined): string | undefined {
	return goal !== undefined && goal.length > 0 ? `goal: ${goal.length > 32 ? `${goal.slice(0, 31)}…` : goal}` : undefined;
}

export type Lane = "pi_loop" | "executor";

export interface StatusInput {
	config: LeanPiConfig;
	contract: ExecutionContract;
	/** The role actually dispatched, when it differs from the contract's class. */
	role?: ModelRole;
	/** The model actually running, when it is not the one the role resolves to. */
	model?: string;
	/**
	 * The session's manual model pick (`/model`, PRD-048): the pinned backend and
	 * model, or `null`/absent for Auto. A role's capability pin no longer decides
	 * this chip — that pin is what the routing index picks with, not an operator's
	 * hand-picked model.
	 */
	pin?: BackendRef | null;
	/**
	 * The level the session was actually set to, when it is not the compiled
	 * effort — an operator's `thinkingLevel` ceiling is applied before the turn
	 * runs, and the footer named the pre-ceiling number.
	 */
	effort?: ThinkingLevel;
	/** Accumulated session spend in USD. Omitted when nothing has been priced yet. */
	cost?: number;
	/**
	 * Pi's own context usage for the running model, 0–100. Omitted when Pi does
	 * not know it yet (right after a compaction it does not) — a measured number
	 * or nothing, never a plausible one.
	 */
	contextPercent?: number;
	/**
	 * A backend the last probe found unusable, as `codex signed-out`. The probe
	 * cache is `/doctor`'s and is only filled once something has probed, so this
	 * is absent on a session where nobody asked.
	 */
	degraded?: string;
	/** The active goal's text, when one is running. */
	goal?: string;
	/**
	 * Emit SGR escapes: the model bold, the effort on the green-to-red ramp.
	 * Off by default so a caller comparing the line as text gets text.
	 */
	color?: boolean;
}

/** `deepseek-v4.1-flash  ·  opencode-go  ·  auto  ·  thinking: medium  ·  hard task  ·  $0.42` */
export function statusLine({ config, contract, role, model: running, effort: applied, cost, goal, contextPercent, degraded, color, pin: manualPin }: StatusInput): string {
	const resolvedRole = role ?? contract.routing.executor_class;
	let model: string;
	// The same model id is served by several providers at different prices and
	// context windows, so the name alone does not say which one the turn is on.
	let provider: string | undefined;
	// Which model runs is the harness's call until the operator makes it theirs:
	// `/model`'s pin is the operator's, and it is the only one that means Manual
	// (PRD-048). A role's capability pin only stops the index re-picking that
	// role; it is not a pick the operator made this session, so it stays Auto.
	let pinned = false;
	// The role asked for a floor the running model does not clear. Reported once
	// to stderr at session start, which in the TUI is nowhere, so a hard task
	// quietly running on the cheap model looked exactly like one that was not.
	// Only a *measured* shortfall: an unmeasured model (every CLI model is one)
	// would fire this on every turn and the chip would stop meaning anything.
	let shortfall: string | undefined;
	if (manualPin) {
		model = prettyModel(manualPin.backend, manualPin.model);
		provider = manualPin.backend;
		pinned = true;
	} else if (running !== undefined) {
		// The caller knows what is executing and it is not the role's model — Pi
		// kept the session model because the class has no entry in its registry.
		const split = running.includes("/") ? (running.split("/", 2) as [string, string]) : undefined;
		model = split ? prettyModel(...split) : running;
		provider = split?.[0];
	} else {
		const status = roleStatus(config, resolvedRole);
		if (status.gap !== undefined && status.gap.best_available !== null) shortfall = `⚠ below ${resolvedRole} floor`;
		try {
			const ref = resolveRole(config, resolvedRole);
			model = prettyModel(ref.backend, ref.model);
			provider = ref.backend;
		} catch {
			// An unconfigured role is a real state (the config names fewer roles than
			// the compiler uses); the line says which role rather than throwing.
			model = resolvedRole;
		}
	}
	const level = applied ?? contract.reasoning.effort;
	const effort = `thinking: ${effortLabel(level)}`;
	const parts = [
		color === true ? `${BOLD}${model}${RESET}` : model,
		// `default` renders as the backend name already; a second copy of it is noise.
		...(provider !== undefined && provider !== model ? [color === true ? `${DIM}${provider}${RESET}` : provider] : []),
		...(pinned
			? [color === true ? `${MANUAL}Manual${RESET}` : "Manual"]
			: [color === true ? `${DIM}Auto${RESET}` : "Auto"]),
		color === true ? `${EFFORT_COLOR[level]}${effort}${RESET}` : effort,
		COMPLEXITY_LABEL[contract.task.execution_complexity],
	];
	// Spend is the one number an operator steers on, and a harness that routes
	// for cost without ever showing the bill is asking to be trusted on it.
	if (cost !== undefined) parts.push(`$${cost.toFixed(2)}`);
	// The number that decides whether to run `/compact-refs`, and the only one on
	// the line the user acts on *before* the turn goes wrong rather than after.
	if (contextPercent !== undefined) parts.push(`ctx ${Math.round(contextPercent)}%`);
	// A goal runs across turns, so nothing else on screen says one is live —
	// which is how a leftover goal gets mistaken for the harness acting on its own.
	const chip = goalChip(goal);
	if (chip) parts.push(chip);
	// Last, and only when true: both warnings are the operator's next action, and
	// a line that ends in one is read even when the rest of it is not.
	if (shortfall !== undefined) parts.push(color === true ? `${WARN}${shortfall}${RESET}` : shortfall);
	if (degraded !== undefined) parts.push(color === true ? `${WARN}⚠ ${degraded}${RESET}` : `⚠ ${degraded}`);
	return parts.join(SEP);
}
