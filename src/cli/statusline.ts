/**
 * The one line the user sees while a turn runs.
 *
 * "Tell me your goal, I figure out the rest" only works if the figuring is
 * visible: the harness silently picking a model, an effort and a lane is
 * indistinguishable from a harness doing nothing. This renders exactly the
 * decisions the compiler made for the turn in flight — what is executing, how
 * hard it was told to think, what the task was classified as, and which lane is
 * running — so an operator can see a cheap model on a mechanical task and a
 * strong one on a risky change.
 */
import type { ExecutionContract } from "../compiler/contract.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { LeanPiConfig, ModelRole } from "../core/types.js";
import { resolveRole } from "../core/roles.js";

/** The footer slot LeanPi owns; one key, replaced each turn. */
export const LEANPI_STATUS_KEY = "leanpi";

/** Every level Pi can be set to: the compiler decides three, an operator's ceiling can name any. */
const EFFORT_LABEL: Record<ThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "X-High",
	max: "Max",
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
	/** The compiler wants a PRD and none is open; the user opens one. */
	prdWanted?: boolean;
}

const LANE_LABEL: Record<Lane, string> = {
	// Who is actually running the turn. With subscription backends LeanPi's own
	// executor lane spawns the vendor; with a native provider Pi's loop does the
	// work and LeanPi has set its model and effort — saying "Executor lane" there
	// would name a lane that did not run.
	pi_loop: "Pi loop",
	executor: "Executor lane",
};

/** `Auto: claude opus (1m) (Medium) — MEDIUM complexity — Executor lane` */
export function statusLine({ config, contract, lane, role, model: running, effort: applied, prdWanted }: StatusInput): string {
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
	const effort = EFFORT_LABEL[applied ?? contract.reasoning.effort];
	const parts = [`Auto: ${model} (${effort}) — ${contract.task.execution_complexity} complexity — ${LANE_LABEL[lane]}`];
	// No "unverified — /verify" here any more. This line is drawn *before* the
	// turn runs, so it could only ever guess; the Pi loop now verifies itself
	// whenever the turn changed the workspace, and reports the gate's actual
	// decision afterwards. A footer telling the user to run a command the harness
	// already ran is worse than no footer.
	// The one decision LeanPi cannot make for the user: the PRD document itself.
	if (prdWanted === true) parts.push("/prd create to open the PRD lane");
	return parts.join(" — ");
}
