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
	/** Working-state sources (PRD-009/013/007); stubs when nothing is wired yet. */
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
 * Render the SEMI-STABLE skill block. PRD-014's `assemble()` becomes the single
 * prompt builder; until it lands this is the seam that puts selected bodies —
 * and only those — in front of the executor.
 */
export function renderSkillBlock(skills: SelectedSkill[]): string {
	if (skills.length === 0) return "";
	const blocks = skills.map((skill) => `### skill: ${skill.name} (${skill.source})\n\n${skill.body.trim()}`);
	return `<!-- SEMI-STABLE: selected skills -->\n${blocks.join("\n\n")}\n`;
}

/**
 * Run the registered lanes and resolve the turn's prefix.
 *
 * A lane that built the prompt itself owns the prefix. Otherwise the context
 * engine (PRD-014) is the builder: `assemble()` places the STATIC Ponytail
 * bytes first, then the SEMI-STABLE block (selected skills, contract) and the
 * VOLATILE block (working state) last, which is the §22 layout the provider
 * cache depends on.
 */
export async function runLanes(turn: TurnInput, context: TurnContext): Promise<TurnContext> {
	for (const lane of lanes) await lane.run(turn, context);
	if (context.prefix.length === 0) {
		context.prefix = assemble({
			config: context.config,
			skills: context.skills,
			...(context.contract ? { contract: context.contract } : {}),
			workingState: buildWorkingState(context.workingStateSources ?? stubSources(), { filesTouched: [] }),
		}).text;
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
	};
	await runLanes(turn, context);
	if (!deps.session) return context;

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
	return context;
}
