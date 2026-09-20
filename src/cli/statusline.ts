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
import type { LeanPiConfig, ModelRole } from "../core/types.js";
import { resolveRole } from "../core/roles.js";

/** The footer slot LeanPi owns; one key, replaced each turn. */
export const LEANPI_STATUS_KEY = "leanpi";

const EFFORT_LABEL = { low: "Low", medium: "Medium", high: "High" } as const;

/** Model ids are vendor strings; this is the name a human recognises. */
export function prettyModel(backend: string, model: string): string {
	if (model === "default" || model.length === 0) return backend;
	// `opencode-go/deepseek-v4.1-flash` → `deepseek-v4.1-flash`
	const bare = model.slice(model.lastIndexOf("/") + 1);
	// `opus[1m]` → `opus (1m)`: the bracket is the vendor's context-window alias.
	return bare.replace(/\[([^\]]+)\]$/, " ($1)");
}

export type Lane = "compiler" | "executor" | "review" | "proof";

export interface StatusInput {
	config: LeanPiConfig;
	contract: ExecutionContract;
	lane: Lane;
	/** The role actually dispatched, when it differs from the contract's class. */
	role?: ModelRole;
	/** The compiler wants a PRD and none is open; the user opens one. */
	prdWanted?: boolean;
}

const LANE_LABEL: Record<Lane, string> = {
	compiler: "Compiler",
	executor: "Executor lane",
	review: "Reviewer lane",
	proof: "Proof gate",
};

/** `Auto: claude opus (1m) (Medium) — MEDIUM complexity — Executor lane` */
export function statusLine({ config, contract, lane, role, prdWanted }: StatusInput): string {
	const resolvedRole = role ?? contract.routing.executor_class;
	let model: string;
	try {
		const ref = resolveRole(config, resolvedRole);
		model = prettyModel(ref.backend, ref.model);
	} catch {
		// An unconfigured role is a real state (the config names fewer roles than
		// the compiler uses); the line says which role rather than throwing.
		model = resolvedRole;
	}
	const effort = EFFORT_LABEL[contract.reasoning.effort];
	const line = `Auto: ${model} (${effort}) — ${contract.task.execution_complexity} complexity — ${LANE_LABEL[lane]}`;
	// The one decision LeanPi cannot make for the user: the PRD document itself.
	return prdWanted === true ? `${line} — /prd create to open the PRD lane` : line;
}
