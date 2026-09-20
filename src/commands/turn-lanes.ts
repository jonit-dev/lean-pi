/**
 * The two turn lanes that connect the compiler to the executor (PRD-004 →
 * PRD-007). They live here rather than inline in `activate()` so the chain a
 * real session runs is the chain a spec can register and drive.
 *
 * Order is load-bearing: `compiler` puts the contract on the turn context and
 * `executor` is the only thing that consumes it.
 */
import { BackendRegistry } from "../backends/index.js";
import { compileRecordOf, compileTask } from "../compiler/index.js";
import type { JevClient } from "../jev/client.js";
import type { LeanPiConfig, ModelRole } from "../core/types.js";
import { runExecutor, type ExecutorDeps } from "../executor/index.js";
import { selectSkills } from "../capabilities/skill-select.js";
import type { SkillControl, SkillRecord } from "../capabilities/skills.js";
import { createFileSearch } from "../exploration/gather.js";
import { explore, type ContextSelection } from "../exploration/governor.js";
import { createGoalStore, evaluateGoal, prdGoalSource } from "../goal/index.js";
import { openPrdLane } from "../prd/dispatch.js";
import { readPrdState } from "../prd/state.js";
import { evaluateProofGate } from "../proof/gate.js";
import { criteriaOf } from "../proof/packet.js";
import { scoutTask } from "../scout/index.js";
import { itemsOf, remainingWork, type TodoCarrier } from "../todo/index.js";
import { workspaceHash } from "../verify/hash.js";
import { registerOwnedLanes, type Lane, type TurnContext } from "./session.js";
import { feedInvocation, type RunCollector } from "../telemetry/index.js";

/**
 * The accumulator the registered lanes feed while a run is in flight. The lanes
 * are registered once at activation and the collector is per run, so the run's
 * owner sets this for the duration: an unset holder means the lanes bill nobody
 * (a caller that has no record to write, e.g. the bench's own attempt rows).
 */
let currentCollector: RunCollector | undefined;

/** Set for the duration of one run; `undefined` once its record is written. */
export function setLaneCollector(collector: RunCollector | undefined): void {
	currentCollector = collector;
}

export interface TurnLaneDeps {
	cwd: string;
	config: LeanPiConfig;
	/**
	 * The JEV seam every consumer here needs: `ask` plus the mode and the fallback
	 * counter. A caller that has not built a client omits it and every site answers
	 * deterministically.
	 */
	jev?: Pick<JevClient, "ask" | "getMode" | "fallbackCount">;
	/** PRD-014's store: the executor writes diff and diagnostic artifacts against it. */
	artifacts?: ExecutorDeps["artifacts"];
	/** PRD-005's registry and enable/pin state, for the disclosure a native turn runs itself. */
	skills?: { records: () => SkillRecord[]; control: SkillControl };
	/** PRD-025's list, the "useful work remains" input PRD-013's boundary reads. */
	todos?: TodoCarrier;
	/** PRD-015's run identity, for the goal boundary's cost read. */
	sessionId?: string;
	/** Test seam: replaces the PRD-008 backend invocation. */
	worker?: ExecutorDeps["worker"];
	exec?: ExecutorDeps["exec"];
	verifyCommands?: ExecutorDeps["verifyCommands"];
	/** Test seam: replaces the PRD-011 reviewer worker. */
	reviewRunner?: ExecutorDeps["reviewRunner"];
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

/**
 * PRD-005's disclosure on a backend LeanPi does not own the loop for.
 *
 * The selection is registered as a capability provider, which only `compileTask`
 * consumes — so on a native backend, where no contract is compiled, it never
 * ran and Pi disclosed its entire library instead. This lane runs the same JEV
 * pipeline against the turn's text and puts the result on `context.skills`,
 * which is the channel `runLanes` already assembles into the prompt. JEV
 * answering "no skill required" — and JEV being unreachable, which is what the
 * documented fallback is for — discloses nothing.
 */
export function skillLane(deps: TurnLaneDeps): Lane {
	return {
		name: "skills",
		async run(turn, context) {
			const skills = deps.skills;
			if (!skills) return;
			const selection = await selectSkills({
				records: skills.records(),
				control: skills.control,
				request: turn.text,
				config: deps.config,
				...(deps.jev ? { client: deps.jev } : {}),
				// Pointer, not body. A body belongs in the one-shot executor prompt the
				// contract path builds; here it would sit in the cacheable prefix of
				// every provider call Pi's loop makes. Measured on the validated suite:
				// three bodies cost about as much as Pi's whole 199-skill catalog did.
				// The name, what it is for and where to read it is the affordance.
				loadBody: (record) => `${record.description}\nFull skill: ${record.source.path}`,
			});
			context.skills = selection.skills;
		},
	};
}

/** §28-§34: the only consumer of a compiled contract. */
export function executorLane(deps: TurnLaneDeps): Lane {
	return {
		name: "executor",
		async run(turn, context) {
			const contract = context.contract;
			if (!contract || deps.execute === false) return;
			// PRD-023's pre-generation hook: the governor picks the files that enter
			// the executor's context, and the excerpts travel on the packet below.
			context.exploration = await exploreContext(deps, turn.text, context.packet);
			// PRD-012's dispatch: the compiler's `next_stage` is the decision, and the
			// lane is opened only when it says `prd_lane` — `openPrdLane` reads the
			// record before its dynamic import, so the quick path never loads the PRD
			// machinery (FR-032/AC-7), and `laneLoads` is where that is observable.
			const record = compileRecordOf(contract);
			if (record && deps.artifacts) {
				context.prd =
					(await openPrdLane(record, {
						config: deps.config,
						cwd: deps.cwd,
						artifactStore: deps.artifacts,
						...(deps.jev ? { jev: deps.jev } : {}),
						hashWorkspace: () => workspaceHash(deps.cwd),
					})) ?? undefined;
			}
			// PRD-015's accumulator, when the run's owner set one: every backend
			// invocation this executor makes is billed into the same record, so a
			// compiled run's `/cost` is what the run actually spent.
			const collector = currentCollector;
			context.executor = await runExecutor(contract, {
				registry: new BackendRegistry(deps.config, collector ? { onInvocation: (record) => feedInvocation(collector, record) } : {}),
				cwd: deps.cwd,
				config: deps.config,
				...(deps.jev ? { jev: deps.jev } : {}),
				...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
				...(context.exploration ? { selection: { excerpts: excerptsOf(context.exploration) } } : {}),
				...(deps.worker ? { worker: deps.worker } : {}),
				...(deps.exec ? { exec: deps.exec } : {}),
				...(deps.verifyCommands ? { verifyCommands: deps.verifyCommands } : {}),
				...(deps.reviewRunner ? { reviewRunner: deps.reviewRunner } : {}),
			});
			// PRD-010's gate: the contract's criteria against the evidence this turn
			// actually produced. The decision is what "done" means from here on; a turn
			// whose executor was blocked is gated like any other, because the gate's
			// question is what the evidence proves, not what the executor claimed.
			//
			// The contract carries per-criterion attribution when the compiler could
			// name a surface; a direct task has none, and its single criterion is the
			// request itself (PRD-004), so the gate's criteria fall back to that with
			// the kinds the contract declares required.
			const review = context.executor.review;
			const attributed = criteriaOf(contract);
			const criteria =
				attributed.length > 0
					? attributed
					: contract.task.acceptance_criteria.map((criterion) => ({ id: criterion.id, text: criterion.text, required: [...contract.verification.required] }));
			context.proof = await evaluateProofGate(criteria, {
				// The hash the verifier stamped the records with, not a fresh one: a
				// recomputed hash would read every record as stale and the gate could
				// never be satisfied.
				workspaceHash: context.executor.workspaceHash ?? workspaceHash(deps.cwd, context.executor.changedFiles),
				evidence: context.executor.evidence,
				changedFiles: context.executor.changedFiles,
				summary: context.executor.blockedReason ?? null,
			}, {
				contract,
				config: deps.config,
				...(deps.jev ? { jev: deps.jev } : {}),
				// PRD-011's verdict for this turn is the review the gate asks for;
				// without it a reviewer that already passed still reads as
				// "the required review has not passed".
				...(review.verdict
					? {
							reviewVerdicts: [
								{
									level: review.level,
									verdict: { decision: review.verdict.decision },
									...(review.independence ? { independence: review.independence } : {}),
								},
							],
						}
					: {}),
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
	registerOwnedLanes([compilerLane(deps), executorLane(deps)]);
}

/**
 * What `activate()` calls. The compiler always runs: who executes is a separate
 * question from who decides. The compiler is what classifies the task (JEV), and
 * its route is what picks the model class and the reasoning budget the turn is
 * billed for — with Pi's own loop as the executor, `runTurn` applies those
 * decisions to the session, so a native backend costs what the classification
 * says it should. Only the executor lane is conditional, because a lane that ran
 * a second worker on Pi's own loop would run the task twice.
 */
export function registerTurnLanesIfOwned(deps: TurnLaneDeps): boolean {
	const owned = ownsExecutionLoop(deps.config);
	registerOwnedLanes(owned ? [compilerLane(deps), executorLane(deps)] : [compilerLane(deps)]);
	return owned;
}
