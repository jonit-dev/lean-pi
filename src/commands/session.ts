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
import type { TaskPacket } from "../scout/index.js";
import { itemsOf, withTodo, type TodoCarrier } from "../todo/index.js";
import { lspSelectionOf } from "../lsp/provider.js";
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
	/** PRD-003's packet, kept so the exploration hook seeds from it (PRD-023). */
	packet?: TaskPacket;
	/** PRD-023's selection: the files and excerpts that enter the executor's context. */
	exploration?: ContextSelection;
	/** The session's todo list (PRD-025); the prompt carries it when it has items. */
	todo?: TodoCarrier;
	/** Working-state sources (PRD-014); stubs when nothing is wired. */
	workingStateSources?: WorkingStateSources;
	/** STATIC prefix plus the SEMI-STABLE block for this turn. */
	prefix: string;
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
}

const lanes: Lane[] = [];

/** Lanes run in registration order. PRD-004/005 append here during `activate()`. */
export function registerLane(lane: Lane): void {
	lanes.push(lane);
}

export function listLanes(): readonly Lane[] {
	return lanes;
}

export function clearLanes(): void {
	lanes.length = 0;
}

let activePrefix = "";
let turnInFlight = false;

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
export async function runLanes(turn: TurnInput, context: TurnContext): Promise<TurnContext> {
	for (const lane of lanes) await lane.run(turn, context);
	// PRD-005's disclosure reaches the request through the contract slot the
	// provider filled; the lane that compiled the contract does not restate it.
	if (context.contract && context.skills.length === 0) context.skills = context.contract.capabilities.skills;
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

	const model = deps.runtime?.getModel(context.modelRef.backend, context.modelRef.model);
	if (!model) {
		throw new Error(
			`Role "${role}" resolves to ${context.modelRef.backend}/${context.modelRef.model}, which is not registered.`,
		);
	}
	turnInFlight = true;
	try {
		await deps.session.setModel(model);
		await deps.session.prompt(turn.text);
	} finally {
		turnInFlight = false;
	}
	deps.onContext?.(context);
	return context;
}
