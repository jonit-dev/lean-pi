/**
 * The two turn lanes that connect the compiler to the executor (PRD-004 →
 * PRD-007). They live here rather than inline in `activate()` so the chain a
 * real session runs is the chain a spec can register and drive.
 *
 * Order is load-bearing: `compiler` puts the contract on the turn context and
 * `executor` is the only thing that consumes it.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BackendRegistry, detectSubscriptions, subscriptionDeviations } from "../backends/index.js";
import type { BackendInvocation } from "../backends/worker.js";
import { compileRecordOf, compileTask } from "../compiler/index.js";
import type { JevClient } from "../jev/client.js";
import type { LeanPiConfig, ModelRole } from "../core/types.js";
import { runExecutor, type ExecutorDeps } from "../executor/index.js";
import { runIsolated, ensureGitIgnored, worktreePath, worktreeRootOf, type CleanupResult, type WorktreePatch } from "../runtime/index.js";
import type { WorktreePermissionRequest } from "../runtime/index.js";
import type { SkillControl, SkillRecord } from "../capabilities/skills.js";
import { createFileSearch } from "../exploration/gather.js";
import { explore, type ContextSelection } from "../exploration/governor.js";
import { createGoalStore, evaluateGoal, isRunningHere, prdGoalSource } from "../goal/index.js";
import { openPrdLane } from "../prd/dispatch.js";
import { readPrdState } from "../prd/state.js";
import { evaluateProofGate } from "../proof/gate.js";
import { criteriaOf } from "../proof/packet.js";
import { scoutTask } from "../scout/index.js";
import { itemsOf, remainingWork, type TodoCarrier } from "../todo/index.js";
import { EvidenceStore } from "../verify/evidence.js";
import { workspaceHash } from "../verify/hash.js";
import { registerOwnedLanes, type Lane, type TurnContext, type TurnInput } from "./session.js";
import { routePins } from "../compiler/pins.js";
import { feedInvocation, type RunCollector } from "../telemetry/index.js";
import { lspSelectionOf } from "../lsp/provider.js";
import type { ToolSurface } from "../mcp/tools.js";
import type { SelectedMcpTool } from "../mcp/select.js";

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
	/**
	 * Gate the executor lane's `run` on `ownsTurn`: a `/model` pin taken after
	 * activation hands the turn to Pi's loop (PRD-051) even on a configuration
	 * LeanPi owns, and a native config never runs it.
	 */
	requireOwnership?: boolean;
	/** The environment subscription detection reads (PATH and the vendors' keys). */
	env?: NodeJS.ProcessEnv;
	/** PRD-022's browser adapter, threaded to the runtime verifiers this turn selects. */
	browserFacility?: import("../runtime/browser.js").BrowserFacility | null;
	/** PRD-017's `ask` channel for an isolated worktree, so an `ask` decision can be confirmed. */
	worktreeConfirm?: (request: WorktreePermissionRequest) => boolean | Promise<boolean>;
	/** PRD-045: the per-turn tool surface (MCP + LSP) the tool-surface lane edits. */
	toolSurface?: ToolSurface;
	/** PRD-045: the selected MCP tools as vendor harness configs; only `allow` travels. */
	mcpResolver?: ExecutorDeps["mcpResolver"];
}

/** A fresh run id per isolated turn; matches PRD-022's single-safe-path-segment rule. */
let isolationCounter = 0;
function isolationRunId(): string {
	isolationCounter += 1;
	return `run-${Date.now().toString(36)}-${isolationCounter}`;
}

/**
 * Write a run's surfaced patch outside its disposable worktree, keyed by run id.
 * The `.patch` carries the whole captured patch (tracked diff plus untracked
 * manifest and hashes); the `.diff`, when there is a tracked diff, is a plain
 * unified diff the operator can apply by hand.
 */
function persistIsolationPatch(repoRoot: string, patch: WorktreePatch): { patchPath: string; diffPath?: string } {
	const dir = join(repoRoot, ".leanpi", "patches");
	mkdirSync(dir, { recursive: true });
	ensureGitIgnored(repoRoot, ".leanpi");
	const patchPath = join(dir, `${patch.runId}.patch`);
	writeFileSync(patchPath, `${JSON.stringify(patch, null, 2)}\n`);
	// The complete diff (tracked edits and new files) when available, so the one
	// displayed `git apply` command reproduces the whole run — including a
	// new-files-only outcome, which the tracked-only diff omitted entirely.
	const applyable = patch.completeDiff ?? patch.diff;
	if (applyable.trim().length === 0) return { patchPath };
	const diffPath = join(dir, `${patch.runId}.diff`);
	writeFileSync(diffPath, applyable);
	return { patchPath, diffPath };
}

/** A prompt already about a PRD (`execute docs/PRDs/…`, `write a PRD for X`) is planned. */
const PRD_MENTION = /\bPRDs?\b/i;

/** Stage 0 + §8: the deterministic packet, then the compiled contract. */
export function compilerLane(deps: TurnLaneDeps): Lane {
	return {
		name: "compiler",
		async run(turn, context) {
			// PRD-048 Phase 2: a `/model` pin is Manual — plain chat with the pinned
			// model, not LeanPi's pipeline. No contract is compiled, so every lane
			// that gates on `context.contract` (JEV, tool surface, verify, review,
			// the proof gate, the goal boundary) does nothing this turn.
			if (routePins().model) return;
			const packet = scoutTask(deps.cwd, turn.text);
			// PRD-023's seed: the executor lane's pre-generation hook explores from
			// the packet the compiler already built rather than walking the repo twice.
			context.packet = packet;
			// §14's `subscription_availability`: a class bound to a vendor CLI this
			// machine cannot use (missing, or signed out) is routed away from here,
			// rather than discovered by spending an attempt on it. Detection is two
			// file questions per backend, so it costs nothing on the turn that routes.
			const deviations = subscriptionDeviations(deps.config, detectSubscriptions(deps.config, deps.env ? { env: deps.env } : {}));
			// A PRD being executed (named, or the active one), or a goal running here,
			// already is the plan: gating it again offered a plan and told the model
			// to slice a second PRD.
			const planned = PRD_MENTION.test(turn.text) || readPrdState(deps.cwd) !== null || isRunningHere(createGoalStore(deps.cwd).load(), deps.sessionId);
			context.contract = await compileTask(turn.text, packet, deviations, planned);
		},
	};
}

/**
 * PRD-045's tool surface: the compiled contract's MCP selection and LSP mode
 * become the turn's active tool set. It runs after `compiler` (the contract is
 * its input) and before `executor` (the worker must see the set). One lane
 * serves both entry points — `before_agent_start` and `runTurn` — so the
 * interactive path gains the LSP mode `runTurn` used to apply alone.
 *
 * No surface is a no-op: a caller that registered the lanes without a Pi
 * session (a bench row, a spec) keeps its own tool list.
 */
export function toolSurfaceLane(deps: TurnLaneDeps): Lane {
	return {
		name: "tool-surface",
		async run(_turn, context) {
			const surface = deps.toolSurface;
			if (!surface) return;
			const contract = context.contract;
			surface.apply((contract?.capabilities.mcps ?? []) as SelectedMcpTool[], contract ? (lspSelectionOf(contract)?.mode ?? "LSP_OFF") : "LSP_OFF");
		},
	};
}

/**
 * The workspace state the gate reads, hashed now over the task's touched scope.
 * A fresh hash is not a stale one: `workspaceHash` is content-based, so the same
 * bytes reproduce the verifier's stamp exactly. It only differs when the bytes
 * actually changed after verification — which is exactly when the evidence must
 * read as stale. A hash failure (an unreadable or cyclic path) propagates: it
 * must never fall back to the verifier's stamp, which would let stale evidence
 * certify a workspace the gate could not read.
 */
function gateWorkspaceHash(cwd: string, executor: NonNullable<TurnContext["executor"]>): string {
	return workspaceHash(cwd, executor.changedFiles);
}

/** §28-§34: the only consumer of a compiled contract. */
export function executorLane(deps: TurnLaneDeps): Lane {
	// One pool for the lane's lifetime, which is the session's: a per-turn
	// registry starts with an empty cooldown map, so a vendor that is rate
	// limited or hanging is re-probed on every turn and the session pays that
	// failure again each time (PRD-008 AC-8). The collector is read per
	// invocation rather than captured, because it is the *run's* accumulator and
	// changes with every turn.
	const onInvocation = (record: BackendInvocation): void => {
		const collector = currentCollector;
		if (collector) feedInvocation(collector, record);
	};
	const registry = new BackendRegistry(deps.config, { onInvocation });
	return {
		name: "executor",
		async run(turn, context) {
			// Out whenever Pi's loop is the executor: a native config, or any pin.
			if (deps.requireOwnership && !ownsTurn(deps.config)) return;
			const contract = context.contract;
			if (!contract) return;
			if (deps.execute === false) return;
			// PRD-022's isolation wraps execution, verification, review and any gate
			// recovery as one unit: the gate must run before the isolated workspace is
			// reclaimed, or it would stamp that tree's hash on a main-checkout run.
			if (contract.limits.isolation === "worktree" && ownsExecutionLoop(deps.config)) {
				const runId = isolationRunId();
				const runRoot = worktreeRootOf(deps.config, deps.cwd);
				const runPath = worktreePath(deps.cwd, runId, runRoot);
				let patch: WorktreePatch | undefined;
				let patchPath: string | undefined;
				let diffPath: string | undefined;
				let cleanupResult: CleanupResult | undefined;
				/** The turn-context shape the outcome renderer reads; retention keeps the checkout's exact path and reason. */
				const isolationState = () => ({
					runId,
					...(patchPath ? { patchPath } : {}),
					...(diffPath ? { diffPath } : {}),
					paths: patch?.paths ?? [],
					removed: cleanupResult?.removed ?? false,
					...(cleanupResult && !cleanupResult.removed
						? { retained: { path: cleanupResult.path, reason: cleanupResult.reason, paths: cleanupResult.paths } }
						: {}),
				});
				// The per-turn host channel wins over the static lane dep: the UI's
				// `confirm` is only reachable while a turn is in flight.
				const worktreeConfirm = context.worktreeConfirm ?? deps.worktreeConfirm;
				try {
					await runIsolated(runId, {
						repoRoot: deps.cwd,
						root: runRoot,
						permissions: deps.config.permissions,
						...(worktreeConfirm ? { confirm: worktreeConfirm } : {}),
						// Persist on success *and* on failure, before reclamation.
						onPatch: (surfaced) => {
							patch = surfaced;
							const persisted = persistIsolationPatch(deps.cwd, surfaced);
							patchPath = persisted.patchPath;
							diffPath = persisted.diffPath;
						},
						// The actual cleanup outcome, not an assumption: a retained checkout
						// is surfaced with its path and the paths it could not account for.
						onCleanup: (result) => {
							cleanupResult = result;
						},
						run: (workCwd) => executeAndGate(context, turn, workCwd),
					});
					context.isolation = isolationState();
				} catch (error) {
					// A refusal (deny/declined) happens before any directory exists; a run
					// that threw still reports whatever it managed to persist or retain.
					if (patchPath || cleanupResult) {
						context.isolation = isolationState();
					} else if (existsSync(runPath)) {
						context.isolation = {
							runId,
							paths: [],
							removed: false,
							retained: { path: runPath, reason: "the run did not reach cleanup; its checkout was kept", paths: [] },
						};
					}
					throw error;
				}
				return;
			}
			await executeAndGate(context, turn, deps.cwd);
		},
	};

	/** The executor, the proof gate and the goal boundary, all in `workCwd`. */
	async function executeAndGate(context: TurnContext, turn: TurnInput, workCwd: string): Promise<void> {
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
			// One store per turn, shared by the executor's verification and the gate
			// below: PRD-009's records are what a recovery round writes into, and
			// without a store `recover()` had nowhere to put a result — every gap it
			// could actually have closed came back "blocked".
			const store = new EvidenceStore();
			context.onProgress?.(`running ${contract.routing.executor_class} on ${registry.selectBackend(contract.routing.executor_class)[0]?.name ?? "no available backend"}`);
			context.executor = await runExecutor(contract, {
				registry,
				cwd: workCwd,
				config: deps.config,
				store,
				...(deps.jev ? { jev: deps.jev } : {}),
				...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
				...(deps.browserFacility !== undefined ? { browserFacility: deps.browserFacility } : {}),
				...(context.exploration ? { selection: { excerpts: excerptsOf(context.exploration) } } : {}),
				...(deps.worker ? { worker: deps.worker } : {}),
				...(deps.exec ? { exec: deps.exec } : {}),
				...(deps.verifyCommands ? { verifyCommands: deps.verifyCommands } : {}),
				...(deps.reviewRunner ? { reviewRunner: deps.reviewRunner } : {}),
				...(deps.mcpResolver ? { mcpResolver: deps.mcpResolver } : {}),
			});
			context.onProgress?.("gating the evidence");
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
				// Re-hash the same touched scope now. `workspaceHash` is deterministic
				// and content-based, so an unchanged workspace reproduces the verifier's
				// stamp and its records stay fresh; if the external reviewer (or any
				// worker after verification) changed a byte, the hash moves and the gate
				// sees the evidence as stale instead of stamping old bytes as current.
				workspaceHash: gateWorkspaceHash(workCwd, context.executor),
				evidence: context.executor.evidence,
				changedFiles: context.executor.changedFiles,
				// A completed turn that answered instead of editing has its answer
				// here; a blocked one has its reason. Both are the summary the gate
				// reads, and the answer used to be dropped on the floor.
				summary: context.executor.blockedReason ?? context.executor.summary ?? null,
			}, {
				contract,
				config: deps.config,
				// What `recover()` needs to be able to run anything at all: the store
				// its record lands in, the directory a verifier command runs in, the
				// command overrides for this turn and the artifact store a gathered
				// result is captured into. Without them the gate could name a gap and
				// never close one, which is the state every blocked proof was in.
				store,
				cwd: workCwd,
				...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
				...(deps.verifyCommands ? { commands: deps.verifyCommands } : {}),
				...(deps.exec ? { exec: deps.exec } : {}),
				...(deps.browserFacility !== undefined ? { browserFacility: deps.browserFacility } : {}),
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
					workspaceHash: context.executor.workspaceHash ?? workspaceHash(workCwd, context.executor.changedFiles),
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
	}
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

/**
 * Whether LeanPi owns *this* turn. A `/model` pin (Manual, PRD-048) never does:
 * native or CLI, the pin is a model in Pi's own registry (PRD-051) and Pi's loop
 * runs it, installed by `before_agent_start`'s `setModel`.
 */
export function ownsTurn(config: LeanPiConfig): boolean {
	return ownsExecutionLoop(config) && routePins().model === undefined;
}

/** Registers the chain when this configuration puts LeanPi in charge of the loop. */
export function registerTurnLanes(deps: TurnLaneDeps): void {
	registerOwnedLanes([compilerLane(deps), toolSurfaceLane(deps), executorLane(deps)]);
}

/**
 * What `activate()` calls. The compiler always runs: who executes is a separate
 * question from who decides. The compiler is what classifies the task (JEV), and
 * its route is what picks the model class and the reasoning budget the turn is
 * billed for — with Pi's own loop as the executor, `runTurn` applies those
 * decisions to the session, so a native backend costs what the classification
 * says it should.
 *
 * The executor lane is always registered and gated on `ownsTurn`, which a
 * `/model` pin can change mid-session: on a CLI config a pin hands the turn to
 * Pi's loop (PRD-051), and on a native config the gate keeps the lane out, so
 * nothing runs twice.
 */
export function registerTurnLanesIfOwned(deps: TurnLaneDeps): boolean {
	const owned = ownsTurn(deps.config);
	registerOwnedLanes([compilerLane(deps), toolSurfaceLane(deps), executorLane({ ...deps, requireOwnership: true })]);
	return owned;
}
