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
import { createFileSearch } from "../exploration/gather.js";
import { explore, type ContextSelection } from "../exploration/governor.js";
import { createGoalStore, evaluateGoal, prdGoalSource } from "../goal/index.js";
import { readPrdState } from "../prd/state.js";
import { scoutTask } from "../scout/index.js";
import { itemsOf, remainingWork, type TodoCarrier } from "../todo/index.js";
import { workspaceHash } from "../verify/hash.js";
import { registerLane, type Lane, type TurnContext } from "./session.js";

export interface TurnLaneDeps {
	cwd: string;
	config: LeanPiConfig;
	jev?: Pick<JevClient, "ask" | "fallbackCount">;
	/** PRD-014's store: the executor writes diff and diagnostic artifacts against it. */
	artifacts?: ExecutorDeps["artifacts"];
	/** PRD-025's list, the "useful work remains" input PRD-013's boundary reads. */
	todos?: TodoCarrier;
	/** PRD-015's run identity, for the goal boundary's cost read. */
	sessionId?: string;
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
			// PRD-023's seed: the executor lane's pre-generation hook explores from
			// the packet the compiler already built rather than walking the repo twice.
			context.packet = packet;
			context.contract = await compileTask(turn.text, packet);
		},
	};
}

/** §28-§34: the only consumer of a compiled contract. */
export function executorLane(deps: TurnLaneDeps): Lane {
	return {
		name: "executor",
		async run(turn, context) {
			if (!context.contract || deps.execute === false) return;
			// PRD-023's pre-generation hook: the governor picks the files that enter
			// the executor's context, and the excerpts travel on the packet below.
			context.exploration = await exploreContext(deps, turn.text, context.packet);
			context.executor = await runExecutor(context.contract, {
				registry: new BackendRegistry(deps.config),
				cwd: deps.cwd,
				config: deps.config,
				...(deps.jev ? { jev: deps.jev } : {}),
				...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
				...(context.exploration ? { selection: { excerpts: excerptsOf(context.exploration) } } : {}),
				...(deps.worker ? { worker: deps.worker } : {}),
				...(deps.exec ? { exec: deps.exec } : {}),
				...(deps.verifyCommands ? { verifyCommands: deps.verifyCommands } : {}),
			});
			// PRD-013's boundary, after the executor's work: a session with no active
			// goal pays nothing, and one with a goal gets the stop condition decided
			// from the evidence this turn actually produced.
			const goals = createGoalStore(deps.cwd);
			const goal = goals.load();
			if (goal?.active && context.executor) {
				context.goal = await evaluateGoal(goal, {
					workspaceHash: workspaceHash(deps.cwd, context.executor.changedFiles),
					records: context.executor.evidence,
					config: deps.config,
					cwd: deps.cwd,
					...(deps.jev ? { jev: deps.jev } : {}),
					...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
					...(deps.todos ? { todos: { remainingWork: () => remainingWork(itemsOf(deps.todos!)) } } : {}),
					prd: prdGoalSource(() => readPrdState(deps.cwd)),
					goals,
				});
			}
		},
	};
}

/**
 * PRD-023's selection, or `undefined` when the turn cannot profit from it: the
 * governor needs a packet to seed from and PRD-014's store to reference dropped
 * content, and the compiler lane only runs before the executor.
 */
async function exploreContext(deps: TurnLaneDeps, objective: string, packet: TurnContext["packet"]): Promise<ContextSelection | undefined> {
	if (!packet || !deps.artifacts) return undefined;
	const result = await explore(
		{ objective, packet },
		{
			search: createFileSearch({ cwd: deps.cwd }),
			artifacts: deps.artifacts,
			config: deps.config,
			...(deps.jev ? { jev: deps.jev } : {}),
		},
	);
	return { files: result.files, snippets: result.snippets, bytes: result.bytes };
}

/** The excerpt block the executor's prompt carries: selected files, in rank order. */
function excerptsOf(selection: ContextSelection): string {
	return ["selected context (PRD-023):", ...selection.files.map((file) => `--- ${file.path} ---\n${file.excerpt}`)].join("\n");
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
