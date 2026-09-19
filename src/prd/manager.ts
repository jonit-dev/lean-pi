/**
 * Work units, dependency gating and dispatch (PRD-012 Phases 2–4, FR-033/FR-034).
 *
 * `nextUnit()` decides when the next unit may begin ("all dependencies
 * `VERIFIED`", never a generative judgement); `unitContext()` builds the
 * executor payload from the unit's own fields plus the PRD's `artifact://`
 * reference, with no parameter through which the PRD body, a sibling unit or a
 * routing field could be passed, so context scoping is structural rather than a
 * prompt-writing convention.
 *
 * `applyEvidence()` owns the `prd.criterion_satisfied` decision site: one
 * question per criterion, never batched, with the deterministic freshness rule
 * as its non-null fallback.
 */
import type { CapabilitySlots, ExecutionContract, ExecutorClass, RequiredCapability } from "../compiler/contract.js";
import type { ArtifactStore } from "../context/artifacts.js";
import { resolveRole } from "../core/roles.js";
import type { LeanPiConfig } from "../core/types.js";
import type { JevClient } from "../jev/client.js";
import { ensureSite } from "../jev/registry.js";
import type { ChoiceQuestion, JevQuestion, JevResult } from "../jev/types.js";
import type { EvidenceRecord } from "../verify/evidence.js";
import { resolveInstalledSkill } from "./creator.js";
import { noteLaneModuleLoad } from "./dispatch.js";
import { deriveGoal, type GoalCriterion } from "./goal.js";
import {
	criterionContext,
	criterionOf,
	failingRecord,
	freshPassingRecord,
	readPrdState,
	setRequiredCapability,
	transitionCriterion,
	UnknownCriterionError,
	writePrdState,
	type CriterionRecord,
	type PrdRoutingDecision,
	type PrdSkillSource,
	type PrdState,
	type WorkUnit,
} from "./state.js";

noteLaneModuleLoad("manager");

export const PRD_CRITERION_SITE_ID = "prd.criterion_satisfied";
export const PRD_CRITERION_QUESTION_ID = "criterion_satisfied";

/** The site's three-valued verdict; nothing else is accepted from an answer. */
export type CriterionVerdict = "SATISFIED" | "NOT_SATISFIED" | "INSUFFICIENT_EVIDENCE";

/** Which rule produced the verdict — JEV's answer or the deterministic fallback. */
interface Decision {
	verdict: CriterionVerdict;
	source: "jev" | "deterministic";
}

const CRITERION_OPTIONS: Record<CriterionVerdict, string> = {
	SATISFIED: "The evidence satisfies the criterion.",
	NOT_SATISFIED: "The evidence disproves the criterion.",
	INSUFFICIENT_EVIDENCE: "There is not enough evidence to decide.",
};

function criterionQuestion(criterion: CriterionRecord, records: readonly EvidenceRecord[]): ChoiceQuestion {
	const evidence =
		records.length === 0
			? "none"
			: records.map((record) => `${record.kind}:${record.status}@${record.workspaceHash}`).join(", ");
	return {
		id: PRD_CRITERION_QUESTION_ID,
		kind: "Choice",
		text: `Criterion ${criterion.id} states ${criterion.text}. The collected evidence is ${evidence}. Does this evidence satisfy the criterion?`,
		options: { ...CRITERION_OPTIONS },
	};
}

/**
 * Registered by the manager, never at module load: importing the lane must not
 * add rows to PRD-002's process-wide site registry (a `/route` or registry
 * inventory would see them), and `ensureSite` keeps repeated calls idempotent
 * even after a `clearSites()`.
 */
export function registerPrdCriterionSite(): void {
	ensureSite({
		id: PRD_CRITERION_SITE_ID,
		questions: [{ id: PRD_CRITERION_QUESTION_ID, kind: "Choice", text: "Does the collected evidence satisfy the criterion?", options: { ...CRITERION_OPTIONS } }],
		returnType: ["Choice"],
		// A wrong SATISFIED closes a criterion on insufficient evidence (§50: high).
		consequence: "high",
		telemetryTag: PRD_CRITERION_SITE_ID,
		fallback: ({ state, questions }): JevResult[] => {
			const freshPassing = Boolean((state as { freshPassing?: boolean } | undefined)?.freshPassing);
			return questions.map((question): JevResult => ({
				kind: "Choice",
				questionId: question.id,
				choice: freshPassing ? "SATISFIED" : "INSUFFICIENT_EVIDENCE",
				probabilities: {},
				confidence: 1,
			}));
		},
	});
}

// ---------------------------------------------------------------------------
// The executor packet — exactly PRD-007's six §28 fields
// ---------------------------------------------------------------------------

/** The unit shape the executor lane expects, from the installed `prd-executor` skill. */
export interface ExecutorUnitContract {
	source: PrdSkillSource;
	skillPath: string | null;
	contract: string;
}

/** Floor when the skill is absent: the unit shape, and nothing about the PRD at large. */
export const BUILTIN_EXECUTOR_UNIT_CONTRACT = [
	"One unit, one objective: the unit's own acceptance criteria with their verification commands,",
	"selected context, selected capabilities, budget and retry limit — plus the PRD artifact reference.",
	"No sibling unit, no PRD section body, no routing key.",
].join("\n");

/** Read shape from the installed executor conventions; record the degraded path by name. */
export function loadExecutorUnitContract(cwd: string, config: LeanPiConfig): ExecutorUnitContract {
	const skill = resolveInstalledSkill({ cwd, config, name: "prd-executor" });
	if (skill && skill.body.trim().length > 0) {
		return { source: "installed", skillPath: skill.path, contract: skill.body };
	}
	return { source: "builtin-fallback", skillPath: null, contract: BUILTIN_EXECUTOR_UNIT_CONTRACT };
}

export const EXECUTOR_PACKET_KEYS = ["objective", "acceptanceCriteria", "context", "capabilities", "budget", "retryLimit"] as const;

export interface ExecutorUnitPacket {
	objective: string;
	acceptanceCriteria: Array<{ id: string; text: string; verifyCommand: string }>;
	/** The `artifact://` reference is the only door to the PRD body. */
	context: { prd: string; selected?: unknown };
	capabilities: CapabilitySlots;
	budget: number;
	retryLimit: number;
}

// ---------------------------------------------------------------------------
// Routing annotation (PRD-020 reads it; the packet never carries it)
// ---------------------------------------------------------------------------

export type ModelSelection = Pick<PrdRoutingDecision, "executor_class" | "backend" | "model">;

export type ModelSelector = (capability: RequiredCapability, config: LeanPiConfig) => ModelSelection;

/** The deterministic default until PRD-020's capability index lands. */
export const CAPABILITY_FLOORS: Array<{ min: number; role: ExecutorClass }> = [
	{ min: 80, role: "specialist" },
	{ min: 60, role: "strong" },
	{ min: 40, role: "balanced" },
	{ min: 0, role: "quick" },
];

export function defaultModelSelector(capability: RequiredCapability, config: LeanPiConfig): ModelSelection {
	const executor_class = CAPABILITY_FLOORS.find((floor) => capability.min_coding_index >= floor.min)?.role ?? "quick";
	try {
		const resolved = resolveRole(config, executor_class);
		return { executor_class, backend: resolved.backend, model: resolved.model };
	} catch {
		// No configured role is a routing fact, not a reason to fail the unit.
		return { executor_class, backend: null, model: null };
	}
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

export interface PrdManagerOptions {
	contract: ExecutionContract;
	config: LeanPiConfig;
	cwd: string;
	artifactStore: ArtifactStore;
	/** Explicit state wins; otherwise the active PRD is read from `.leanpi/prd/`. */
	state?: PrdState;
	/** The JEV seam this lane asks through; it never manages credentials. */
	jev?: Pick<JevClient, "ask" | "getMode">;
	/** PRD-009's workspace hash; without it nothing can be fresh, so nothing verifies. */
	hashWorkspace?: () => string;
	selectModel?: ModelSelector;
	now?: () => Date;
}

export interface PrdDispatch {
	unit: WorkUnit;
	packet: ExecutorUnitPacket;
	routing: PrdRoutingDecision;
}

export interface PrdManager {
	readonly state: PrdState;
	/** Read once per manager: the installed `prd-executor` conventions, or the built-in floor. */
	readonly executorUnitContract: ExecutorUnitContract;
	/** The single ready unit, preferring one whose criterion was reopened. */
	nextUnit(): WorkUnit | null;
	unitContext(unitId: string, selected?: unknown): ExecutorUnitPacket;
	routingFor(unitId: string): PrdRoutingDecision;
	dispatch(selected?: unknown): PrdDispatch | null;
	/** Evidence in, status out: PRD-009's records plus the commands that attempt ran. */
	applyEvidence(criterionId: string, records: readonly EvidenceRecord[], commands?: readonly string[]): Promise<CriterionRecord>;
	/** PRD-013's handoff, recomputed from this state on every read. */
	deriveGoal(): GoalCriterion[];
	setRequiredCapability(capability: RequiredCapability): void;
	save(): void;
}

export class NoActivePrdError extends Error {
	constructor(cwd: string) {
		super(`No active PRD state under ${cwd}/.leanpi/prd — create one with /prd create.`);
		this.name = "NoActivePrdError";
	}
}

export class UnknownUnitError extends Error {
	constructor(unitId: string) {
		super(`No work unit "${unitId}" in the active PRD.`);
		this.name = "UnknownUnitError";
	}
}

export function createPrdManager(options: PrdManagerOptions): PrdManager {
	const state = options.state ?? readPrdState(options.cwd);
	if (!state) throw new NoActivePrdError(options.cwd);
	registerPrdCriterionSite();

	const { contract, config } = options;
	const jev = options.jev;
	const hashWorkspace = options.hashWorkspace ?? (() => "");
	const now = options.now ?? (() => new Date());
	const select = options.selectModel ?? defaultModelSelector;

	const save = () => {
		writePrdState(options.cwd, state);
	};

	const unitOf = (unitId: string): WorkUnit => {
		const unit = state.units.find((candidate) => candidate.id === unitId);
		if (!unit) throw new UnknownUnitError(unitId);
		return unit;
	};

	const criteriaOf = (unit: WorkUnit): CriterionRecord[] =>
		unit.criterionIds.map((id) => criterionOf(state, id)).filter((record): record is CriterionRecord => record !== undefined);

	const complete = (unit: WorkUnit): boolean => criteriaOf(unit).every((criterion) => criterion.status === "VERIFIED");

	const ready = (unit: WorkUnit): boolean =>
		unit.dependsOn.every((dependency) => {
			const resolved = state.units.find((candidate) => candidate.id === dependency);
			// A dependency that names no unit is unsatisfiable, never an excuse to dispatch.
			return resolved !== undefined && complete(resolved);
		});

	const dispatchable = (unit: WorkUnit): boolean => !complete(unit) && ready(unit);

	async function decide(
		criterion: CriterionRecord,
		records: readonly EvidenceRecord[],
		deterministic: CriterionVerdict,
	): Promise<Decision> {
		if (!jev || jev.getMode() !== "enabled") return { verdict: deterministic, source: "deterministic" };
		const questions: JevQuestion[] = [criterionQuestion(criterion, records)];
		try {
			const results = await jev.ask(PRD_CRITERION_SITE_ID, questions, {
				criterionId: criterion.id,
				verifyCommand: criterion.verifyCommand,
				freshPassing: deterministic === "SATISFIED",
				records: records.map((record) => ({ kind: record.kind, status: record.status, artifactRef: record.artifactRef ?? null })),
			});
			const answer = results[0];
			if (!answer || answer.kind !== "Choice") return { verdict: "INSUFFICIENT_EVIDENCE", source: "jev" };
			const verdict =
				answer.choice === "SATISFIED" || answer.choice === "NOT_SATISFIED" ? answer.choice : "INSUFFICIENT_EVIDENCE";
			return { verdict, source: "jev" };
		} catch {
			return { verdict: deterministic, source: "deterministic" };
		}
	}

	return {
		state,
		executorUnitContract: loadExecutorUnitContract(options.cwd, config),

		nextUnit() {
			// A reopened criterion re-queues its unit; it wins over fresh work so a
			// disproved claim is repaired before anything is built on top of it.
			const requeued = state.units.find(
				(unit) => dispatchable(unit) && criteriaOf(unit).some((criterion) => criterion.status === "REOPENED"),
			);
			return requeued ?? state.units.find(dispatchable) ?? null;
		},

		unitContext(unitId, selected) {
			const unit = unitOf(unitId);
			const packet: ExecutorUnitPacket = {
				objective: unit.objective,
				acceptanceCriteria: criteriaOf(unit).map((criterion) => ({
					id: criterion.id,
					text: criterion.text,
					verifyCommand: criterion.verifyCommand,
				})),
				context: { prd: state.artifactRef, ...(selected === undefined ? {} : { selected }) },
				capabilities: contract.capabilities,
				budget: contract.context.budget_tokens,
				retryLimit: contract.limits.execution_attempts,
			};
			const keys = Object.keys(packet);
			const unexpected = keys.filter((key) => !(EXECUTOR_PACKET_KEYS as readonly string[]).includes(key));
			if (unexpected.length > 0 || keys.length !== EXECUTOR_PACKET_KEYS.length) {
				throw new Error(`executor packet key set is not the §28 six: ${keys.join(", ")}`);
			}
			return packet;
		},

		routingFor(unitId) {
			const unit = unitOf(unitId);
			const selection = select({ ...unit.requiredCapability }, config);
			const decision: PrdRoutingDecision = {
				unitId: unit.id,
				required_capability: { ...unit.requiredCapability },
				executor_class: selection.executor_class,
				backend: selection.backend,
				model: selection.model,
				recordedAt: now().toISOString(),
			};
			state.routing = [...state.routing.filter((row) => row.unitId !== unit.id), decision];
			save();
			return decision;
		},

		dispatch(selected) {
			const unit = this.nextUnit();
			if (!unit) return null;
			return { unit, packet: this.unitContext(unit.id, selected), routing: this.routingFor(unit.id) };
		},

		async applyEvidence(criterionId, records, commands = []) {
			const criterion = criterionOf(state, criterionId);
			if (!criterion) throw new UnknownCriterionError(criterionId);

			const failed = failingRecord(records, criterionId);
			if (failed) {
				const record = transitionCriterion(state, criterionId, {
					status: "REOPENED",
					evidenceRef: failed.artifactRef ?? null,
					reason: `failing ${failed.kind} evidence`,
				});
				save();
				return record;
			}

			const context = criterionContext(criterion, hashWorkspace(), commands);
			const fresh = freshPassingRecord(records, context);
			const deterministic: CriterionVerdict = fresh
				? "SATISFIED"
				: records.length === 0
					? "INSUFFICIENT_EVIDENCE"
					: "NOT_SATISFIED";
			const { verdict, source } = await decide(criterion, records, deterministic);

			const reason =
				source === "jev"
					? `jev: ${verdict}`
					: verdict === "NOT_SATISFIED"
						? "records present but none fresh and passing for the criterion's command"
						: criterion.verifyCommand.length === 0
							? "criterion declares no verification command"
							: "no evidence submitted";

			const record =
				verdict === "SATISFIED"
					? transitionCriterion(state, criterionId, { status: "VERIFIED", evidenceRef: fresh?.artifactRef ?? null })
					: transitionCriterion(state, criterionId, { status: "PENDING", evidenceRef: null, reason });
			save();
			return record;
		},

		deriveGoal: () => deriveGoal(state),

		setRequiredCapability(capability) {
			setRequiredCapability(state, capability);
			save();
		},

		save,
	};
}
