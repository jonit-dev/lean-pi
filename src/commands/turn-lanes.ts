/**
 * The two turn lanes that connect the compiler to the executor (PRD-004 →
 * PRD-007). They live here rather than inline in `activate()` so the chain a
 * real session runs is the chain a spec can register and drive.
 *
 * Order is load-bearing: `compiler` puts the contract on the turn context and
 * `executor` is the only thing that consumes it.
 */
import { BackendRegistry } from "../backends/index.js";
import { compileTask } from "../compiler/index.js";
import type { JevClient } from "../jev/client.js";
import type { LeanPiConfig, ModelRole } from "../core/types.js";
import { runExecutor, type ExecutorDeps } from "../executor/index.js";
import { scoutTask } from "../scout/index.js";
import { registerLane, type Lane } from "./session.js";

export interface TurnLaneDeps {
	cwd: string;
	config: LeanPiConfig;
	jev?: Pick<JevClient, "ask" | "fallbackCount">;
	/** Test seam: replaces the PRD-008 backend invocation. */
	worker?: ExecutorDeps["worker"];
	exec?: ExecutorDeps["exec"];
	verifyCommands?: ExecutorDeps["verifyCommands"];
	/** Skip the executor for turns the session only wants compiled (e.g. `/route`). */
	execute?: boolean;
}

/** Stage 0 + §8: the deterministic packet, then the compiled contract. */
export function compilerLane(deps: TurnLaneDeps): Lane {
	return {
		name: "compiler",
		async run(turn, context) {
			const packet = scoutTask(deps.cwd, turn.text);
			context.contract = await compileTask(turn.text, packet);
		},
	};
}

/** §28-§34: the only consumer of a compiled contract. */
export function executorLane(deps: TurnLaneDeps): Lane {
	return {
		name: "executor",
		async run(_turn, context) {
			if (!context.contract || deps.execute === false) return;
			context.executor = await runExecutor(context.contract, {
				registry: new BackendRegistry(deps.config),
				cwd: deps.cwd,
				config: deps.config,
				...(deps.jev ? { jev: deps.jev } : {}),
				...(deps.worker ? { worker: deps.worker } : {}),
				...(deps.exec ? { exec: deps.exec } : {}),
				...(deps.verifyCommands ? { verifyCommands: deps.verifyCommands } : {}),
			});
		},
	};
}

/**
 * Whether LeanPi owns the execution loop for this configuration (ROADMAP §23).
 *
 * On a native backend Pi's own agent loop *is* the executor: registering the
 * lane there would run the turn twice and re-verify a workspace Pi is still
 * editing. LeanPi owns the loop only when the executor roles resolve to an
 * external harness (Claude Code / Codex / OpenCode), which is the case the
 * executor lane exists for.
 */
export function ownsExecutionLoop(config: LeanPiConfig): boolean {
	const roles: ModelRole[] = ["quick", "balanced", "strong"];
	const backends = roles.map((role) => config.models[role]?.backend).filter((name): name is string => typeof name === "string");
	if (backends.length === 0) return false;
	return backends.every((name) => config.backends[name]?.type === "external_harness" && config.backends[name]?.enabled !== false);
}

/** Registers the chain when this configuration puts LeanPi in charge of the loop. */
export function registerTurnLanes(deps: TurnLaneDeps): void {
	registerLane(compilerLane(deps));
	registerLane(executorLane(deps));
}

/** What `activate()` calls: the chain, but only when LeanPi owns the loop. */
export function registerTurnLanesIfOwned(deps: TurnLaneDeps): boolean {
	if (!ownsExecutionLoop(deps.config)) return false;
	registerTurnLanes(deps);
	return true;
}
