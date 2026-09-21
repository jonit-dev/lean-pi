/**
 * The shared per-turn entry point (PRD-001).
 *
 * Every later lane (PRD-002's JEV sites, PRD-004's compiler, PRD-005's skill
 * disclosure, PRD-007's executor, PRD-009/010/011) hooks into the ordered lane
 * list here rather than each re-entering `activate()`. `runTurn()` is thin by
 * design: it holds no routing, no JEV and no verification logic.
 */
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assemble } from "../context/prompt.js";
import { buildWorkingState, stubSources, type WorkingStateSources } from "../context/working-state.js";
import { buildStaticPrefix } from "../core/instructions/prefix.js";
import { resolveRole } from "../core/roles.js";
import type { BackendRef, LeanPiConfig, ModelRole, SelectedSkill } from "../core/types.js";
import type { ExecutionContract } from "../compiler/contract.js";
import type { ExecutorOutcome } from "../executor/lane.js";
import type { ProofGateResult } from "../proof/gate.js";
import type { ContextSelection } from "../exploration/governor.js";
import type { GoalEvaluation } from "../goal/index.js";
import type { PrdManager } from "../prd/manager.js";
import type { TaskPacket } from "../scout/index.js";
import { itemsOf, withTodo, type TodoCarrier } from "../todo/index.js";
import { lspSelectionOf } from "../lsp/provider.js";
// The session's own level type, which includes `off`; pi-ai's `ThinkingLevel`
// is the subset a request can ask for and cannot express "do not think".
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { applyLspTools, type LspSessionTools } from "../lsp/tools.js";

export interface TurnInput {
	text: string;
	role?: ModelRole;
}

export interface TurnContext {
	turn: TurnInput;
	role: ModelRole;
	cwd: string;
	config: LeanPiConfig;
	modelRef: BackendRef;
	/** Filled by the capability lane (PRD-005) before the request is sent. */
	skills: SelectedSkill[];
	/** The compiled contract for this turn, when a compiler lane produced one (PRD-004). */
	contract?: ExecutionContract;
	/** What the executor lane (PRD-007) did with the contract, when it ran. */
	executor?: ExecutorOutcome;
	/** PRD-010's verdict for the contract's criteria, when the gate ran. */
	proof?: ProofGateResult;
	/** PRD-013's boundary verdict for the active goal, when one was active. */
	goal?: GoalEvaluation;
	/** PRD-012's lane, opened by the executor lane when the gate dispatched to it. */
	prd?: PrdManager;
	/** PRD-003's packet, kept so the exploration hook seeds from it (PRD-023). */
	packet?: TaskPacket;
	/** The turn's per-turn compile budget, set by `runLanes`; read by the compiler lane. */
	budget?: AbortSignal;
	/** PRD-023's selection: the files and excerpts that enter the executor's context. */
	exploration?: ContextSelection;
	/** The session's todo list (PRD-025); the prompt carries it when it has items. */
	todo?: TodoCarrier;
	/** Working-state sources (PRD-014); stubs when nothing is wired. */
	workingStateSources?: WorkingStateSources;
	/** STATIC prefix plus the SEMI-STABLE block for this turn. */
	prefix: string;
	/**
	 * Where a lane says what it is doing, for callers that have somewhere to put
	 * it. A vendor turn is tens of seconds long and, until this existed, the
	 * whole of it was a blank screen: the executor lane installed its status
	 * line only after the work it describes had finished.
	 */
	onProgress?: (phase: string) => void;
}

export interface Lane {
	name: string;
	run(turn: TurnInput, context: TurnContext): void | Promise<void>;
}

export interface TurnDeps {
	config: LeanPiConfig;
	cwd: string;
	session?: AgentSession;
	/** The session's model runtime, for resolving the turn's role to a concrete model. */
	runtime?: ModelRuntime;
	/** The session's todo list (PRD-025); the prompt carries it when it has items. */
	todo?: TodoCarrier;
	/** PRD-014's working-state sources; absent means the stub record. */
	workingStateSources?: WorkingStateSources;
	/**
	 * Called once the turn's context is complete — after the lanes, and after the
	 * model ran when one did. The activation uses it to fan the turn's compiled
	 * state out to the command surfaces and the todo gate.
	 */
	onContext?: (context: TurnContext) => void;
	/**
	 * Absolute epoch-ms deadline for the whole turn (PRD-021's per-attempt
	 * ceiling). Lane work counts against it: a ceiling that only aborts a stream
	 * cannot stop a turn whose compilation already overran it — the request would
	 * start anyway and run without any bound. When it has passed, the turn returns
	 * compiled but unspent, and the caller records what the lanes cost.
	 */
	deadlineMs?: number;
}

const lanes: Lane[] = [];

/** Lanes run in registration order. PRD-004/005 append here during `activate()`. */
export function registerLane(lane: Lane): void {
	lanes.push(lane);
}

/**
 * The set `registerOwnedLanes` installed last. A process that boots several
 * sessions — the bench boots one per task, and any long-lived process can boot
 * more — must have its second boot supersede the first rather than stack on it:
 * stacked, task N pays N compilations and the lanes of every earlier boot still
 * close over that boot's workspace. The same replace-not-stack rule the owned
 * twelve follow in `activate()`.
 */
let ownedLanes: readonly Lane[] = [];

/**
 * Install the lanes LeanPi owns, replacing the ones the previous call installed.
 * Lanes a caller registered by hand are left where they are.
 */
export function registerOwnedLanes(owned: readonly Lane[]): void {
	for (const lane of ownedLanes) {
		const index = lanes.indexOf(lane);
		if (index >= 0) lanes.splice(index, 1);
	}
	ownedLanes = [...owned];
	lanes.push(...ownedLanes);
}

export function listLanes(): readonly Lane[] {
	return lanes;
}

export function clearLanes(): void {
	lanes.length = 0;
	ownedLanes = [];
}

let activePrefix = "";
let turnInFlight = false;

/** Pi's own ladder, least to most thinking; `off` is below all of them. */
const THINKING_ORDER: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The lower of the compiled effort and the operator's declared level.
 *
 * The compiled effort is what the classification asked for; the declared level is
 * the operator's ceiling on it. `off` on either side wins, because that is the
 * only level that is a spending policy rather than a gradation, and an operator
 * who declared it must not have it raised by a classifier.
 */
function cappedThinkingLevel(effort: ThinkingLevel | undefined, declared: ThinkingLevel | undefined): ThinkingLevel | undefined {
	if (effort === undefined) return declared;
	if (declared === undefined) return effort;
	return THINKING_ORDER.indexOf(effort) <= THINKING_ORDER.indexOf(declared) ? effort : declared;
}

/**
 * The thinking level an operator declared for a backend. Read through the config
 * on every turn so a config edit is visible without restarting the session.
 */
function declaredThinkingLevel(config: LeanPiConfig, backend: string): ThinkingLevel | undefined {
	const declared = config.backends[backend]?.thinkingLevel;
	return typeof declared === "string" ? declared : undefined;
}

/**
 * The level a turn may run at on `backend`: the compiled effort under the
 * operator's ceiling. Exported because the interactive path (`activate()`'s
 * `before_agent_start`) sets the session's level itself and was passing the
 * compiled effort straight through — so `backends.<name>.thinkingLevel: off`,
 * the one spending switch an operator has, held on the programmatic path and
 * was ignored on the path every interactive user takes.
 */
export function thinkingLevelFor(config: LeanPiConfig, backend: string, effort: ThinkingLevel | undefined): ThinkingLevel | undefined {
	return cappedThinkingLevel(effort, declaredThinkingLevel(config, backend));
}

/** The prefix `activate()`'s request handler applies to the request in flight. */
export function getActivePrefix(): string {
	return activePrefix;
}

export function setActivePrefix(prefix: string): void {
	activePrefix = prefix;
}

export function isTurnInFlight(): boolean {
	return turnInFlight;
}

/**
 * Run the registered lanes and resolve the turn's prefix.
 *
 * A lane that built the prompt itself owns the prefix. Otherwise the context
 * engine (PRD-014) is the builder: `assemble()` places the STATIC Ponytail
 * bytes first, then the SEMI-STABLE block (selected skills, contract) and the
 * VOLATILE block (working state, active todo list) last, which is the §22 layout
 * the provider cache depends on.
 */
export const COMPILE_BUDGET_MS = 5_000;

export async function runLanes(turn: TurnInput, context: TurnContext): Promise<TurnContext> {
	// One budget per invocation, created here so every entry point — the native
	// `before_agent_start` path, the owned `input` path and the library `runTurn`
	// — bounds the same compile. It is never a module global: two turns in one
	// process cannot share it. Aborting it resolves each JEV site through the
	// fallback it declares; the lanes themselves still run to completion.
	const budget = new AbortController();
	const budgetTimer = setTimeout(() => budget.abort(), COMPILE_BUDGET_MS);
	context.budget = budget.signal;
	try {
		for (const lane of lanes) await lane.run(turn, context);
		// PRD-005's disclosure reaches the request through the contract slot the
		// provider filled; the lane that compiled the contract does not restate it.
		// A compiled slot wins over the native lane's own selection: both run the
		// same pipeline, and the contract's is the one the executor was routed on.
		if (context.contract && context.contract.capabilities.skills.length > 0) context.skills = context.contract.capabilities.skills;
		if (context.prefix.length === 0) {
			const assembled = assemble({
				config: context.config,
				skills: context.skills,
				...(context.contract ? { contract: context.contract } : {}),
				workingState: buildWorkingState(context.workingStateSources ?? stubSources(), { filesTouched: [] }),
			});
			// PRD-025's block is the last thing a prompt carries, and only when the
			// list has something to say.
			const items = context.todo ? itemsOf(context.todo) : [];
			context.prefix = items.length === 0 ? assembled.text : withTodo(assembled, items).text;
		}
		setActivePrefix(context.prefix);
		return context;
	} finally {
		clearTimeout(budgetTimer);
	}
}

/** Full turn: lanes, then the executor request through the resolved role's model. */
export async function runTurn(turn: TurnInput, deps: TurnDeps): Promise<TurnContext> {
	const role = turn.role ?? "balanced";
	const context: TurnContext = {
		turn,
		role,
		cwd: deps.cwd,
		config: deps.config,
		modelRef: resolveRole(deps.config, role),
		skills: [],
		prefix: "",
		...(deps.todo ? { todo: deps.todo } : {}),
		...(deps.workingStateSources ? { workingStateSources: deps.workingStateSources } : {}),
	};
	await runLanes(turn, context);
	// PRD-018 AC-10: the turn's compiled mode decides which LSP tool group the
	// session exposes, applied before the request so the worker's tool list is the
	// mode's. A turn that compiled nothing exposes none: the seven tools stay
	// registered and inactive, which is §15's "never on by default".
	//
	// The tool-set API is not part of the SDK's public `AgentSession` type
	// (`pi-coding-agent` carries `setActiveToolsByName` at runtime only), so a
	// session-shaped caller that does not expose it — the bench's stub session —
	// simply keeps its own tool list instead of failing the turn.
	const lspSession = deps.session as unknown as LspSessionTools | undefined;
	if (lspSession && typeof lspSession.getActiveToolNames === "function" && typeof lspSession.setActiveToolsByName === "function") {
		applyLspTools(lspSession, context.contract ? (lspSelectionOf(context.contract)?.mode ?? "LSP_OFF") : "LSP_OFF");
	}
	if (!deps.session) {
		deps.onContext?.(context);
		return context;
	}

	// The compiler's class is this turn's spend decision (§14). When Pi's own loop
	// is the executor there is no executor outcome to carry it, so the session runs
	// the model the class resolves to; a role that resolves to nothing falls down
	// its ladder, and a turn that compiled nothing keeps the role it was invoked
	// with. A caller that named a role asked for that role — `/model`, a bench row,
	// a spec — so the decision applies to the turns nobody pinned.
	if (turn.role === undefined && context.contract && context.executor === undefined) {
		const compiled = resolveRole(deps.config, context.contract.routing.executor_class);
		// The class is a request this loop can refuse: a mixed configuration — a
		// native `balanced` beside an external-harness `strong` — resolves the class
		// to a backend Pi's loop has no provider for. Adopting it would fail the turn
		// outright, so the role the turn was invoked with stands, which is what the
		// interactive path's `modelRegistry.find` guard does with the same class.
		// A class *and* an invoked role the runtime cannot serve still throws below.
		if (deps.runtime?.getModel(compiled.backend, compiled.model)) context.modelRef = compiled;
	}
	const model = deps.runtime?.getModel(context.modelRef.backend, context.modelRef.model);
	if (!model) {
		throw new Error(
			`Role "${role}" resolves to ${context.modelRef.backend}/${context.modelRef.model}, which is not registered.`,
		);
	}
	turnInFlight = true;
	try {
		// The attempt's ceiling is absolute and covers the lane work: if it passed
		// while this turn was being compiled, the request must not start — the loop
		// that would run it has no bound left, and the caller records what the lanes
		// spent instead of paying for an unbounded turn.
		if (deps.deadlineMs !== undefined && Date.now() >= deps.deadlineMs) {
			return context;
		}
		await deps.session.setModel(model);
		// After `setModel`, which resets the level: the compiler decides a reasoning
		// effort per complexity (`EFFORT_BY_COMPLEXITY`) and this is the only place
		// that decision reaches the session. The operator's declared level is a
		// *ceiling* on it rather than a default it replaces — otherwise the one
		// switch an operator has (`backends.<name>.thinkingLevel: off`, the only
		// value that changes the bill on a binary-thinking endpoint) would be
		// overridden by every turn that compiled an effort. With nothing compiled
		// and no declared level, the session's own level (Pi's or the user's)
		// stands: LeanPi does not invent one.
		const level = cappedThinkingLevel(context.contract?.reasoning.effort, declaredThinkingLevel(deps.config, context.modelRef.backend));
		const thinking = deps.session as unknown as { setThinkingLevel?: (level: ThinkingLevel) => void };
		if (level !== undefined && typeof thinking.setThinkingLevel === "function") thinking.setThinkingLevel(level);
		await deps.session.prompt(turn.text);
	} finally {
		turnInFlight = false;
	}
	deps.onContext?.(context);
	return context;
}
