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
 * the lane cannot use the word. The one consequence of the lane that *does*
 * matter — that the Pi loop leaves the turn unverified — is said in those
 * words instead.
 */
import type { ExecutionContract } from "../compiler/contract.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExecutionComplexity } from "../compiler/contract.js";
import type { LeanPiConfig, ModelRole } from "../core/types.js";
import { resolveRole } from "../core/roles.js";

/** The footer slot LeanPi owns; one key, replaced each turn. */
export const LEANPI_STATUS_KEY = "leanpi";

/** The separator between chips; spaced so each chip reads as its own word. */
const SEP = "  ·  ";

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

export type Lane = "pi_loop" | "executor";

export interface StatusInput {
	config: LeanPiConfig;
	contract: ExecutionContract;
	lane: Lane;
	/** The role actually dispatched, when it differs from the contract's class. */
	role?: ModelRole;
	/** The model actually running, when it is not the one the role resolves to. */
	model?: string;
	/**
	 * The level the session was actually set to, when it is not the compiled
	 * effort — an operator's `thinkingLevel` ceiling is applied before the turn
	 * runs, and the footer named the pre-ceiling number.
	 */
	effort?: ThinkingLevel;
	/** Accumulated session spend in USD. Omitted when nothing has been priced yet. */
	cost?: number;
	/** The active goal's text, when one is running. */
	goal?: string;
	/** The compiler wants a PRD and none is open; the user opens one. */
	prdWanted?: boolean;
}

/** `deepseek-v4.1-flash  ·  thinking: medium  ·  hard task  ·  $0.42` */
export function statusLine({ config, contract, lane, role, model: running, effort: applied, cost, goal, prdWanted }: StatusInput): string {
	const resolvedRole = role ?? contract.routing.executor_class;
	let model: string;
	if (running !== undefined) {
		// The caller knows what is executing and it is not the role's model — Pi
		// kept the session model because the class has no entry in its registry.
		model = running.includes("/") ? prettyModel(...(running.split("/", 2) as [string, string])) : running;
	} else {
		try {
			const ref = resolveRole(config, resolvedRole);
			model = prettyModel(ref.backend, ref.model);
		} catch {
			// An unconfigured role is a real state (the config names fewer roles than
			// the compiler uses); the line says which role rather than throwing.
			model = resolvedRole;
		}
	}
	const parts = [model, `thinking: ${effortLabel(applied ?? contract.reasoning.effort)}`, COMPLEXITY_LABEL[contract.task.execution_complexity]];
	// Spend is the one number an operator steers on, and a harness that routes
	// for cost without ever showing the bill is asking to be trusted on it.
	if (cost !== undefined) parts.push(`$${cost.toFixed(2)}`);
	// A goal runs across turns, so nothing else on screen says one is live —
	// which is how a leftover goal gets mistaken for the harness acting on its own.
	if (goal !== undefined && goal.length > 0) parts.push(`goal: ${goal.length > 32 ? `${goal.slice(0, 31)}…` : goal}`);
	// The turn the user is about to get is unverified, and saying so is the
	// difference between "evidence-driven completion" and a slogan: on the Pi
	// loop LeanPi's executor lane never runs, so PRD-009's verification and
	// PRD-010's gate never run either. `/verify` is where the user can ask for
	// them against the workspace the turn leaves behind.
	if (lane === "pi_loop" && contract.verification.required.length > 0) parts.push("⚠ unverified → /verify");
	// The one decision LeanPi cannot make for the user: the PRD document itself.
	if (prdWanted === true) parts.push("needs a PRD → /prd create");
	return parts.join(SEP);
}
