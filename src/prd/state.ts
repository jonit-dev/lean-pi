/**
 * The structured PRD state (PRD-012 Phases 1–2, FR-033/FR-034).
 *
 * One record per acceptance criterion plus the work units derived from the PRD
 * body, persisted as a single JSON file under `.leanpi/prd/`. The PRD body
 * itself lives in PRD-014's `artifact://` store and only its reference is kept
 * here, so nothing in this module can hand a model the whole PRD.
 *
 * Status transitions are the only writer: evidence in, status out. Everything
 * else (units, routing annotations, the goal descriptor) is derived on read, so
 * no copy of a criterion's status exists that could drift from this one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutorClass, RequiredCapability } from "../compiler/contract.js";
import type { EvidenceRecord } from "../verify/evidence.js";
import { noteLaneModuleLoad } from "./dispatch.js";

noteLaneModuleLoad("state");

/** The nine §11.1 sections; no tenth section is invented here. */
export const REQUIREMENT_SECTIONS = [
	"Problem Statement",
	"Goals",
	"Non-Goals",
	"Functional Requirements",
	"Architecture Constraints",
	"Acceptance Criteria",
	"Verification Requirements",
	"Dependencies",
	"Unresolved Risks",
] as const;

export type RequirementSection = (typeof REQUIREMENT_SECTIONS)[number];

export type PrdSkillSource = "installed" | "builtin-fallback";

export type CriterionStatus = "PENDING" | "VERIFIED" | "REOPENED" | "BLOCKED";

export interface CriterionRecord {
	id: string;
	text: string;
	/** Runnable command this criterion is judged by; `""` when the PRD declared none. */
	verifyCommand: string;
	status: CriterionStatus;
	/** `artifact://` reference of the evidence that decided the current status. */
	evidenceRef: string | null;
	unitId: string;
	/** Why the status is not `VERIFIED`; absent when it is. */
	reason?: string;
}

export interface WorkUnit {
	id: string;
	objective: string;
	criterionIds: string[];
	/** Units whose criteria must all be `VERIFIED` before this unit may run. */
	dependsOn: string[];
	/**
	 * Routing annotation PRD-020 reads when it picks the model for this unit. It
	 * is deliberately *not* a field of the executor packet PRD-007 dispatches.
	 */
	requiredCapability: RequiredCapability;
}

export interface PrdRoutingDecision {
	unitId: string;
	required_capability: RequiredCapability;
	executor_class: ExecutorClass;
	backend: string | null;
	model: string | null;
	recordedAt: string;
}

export interface PrdClosureRecord {
	source: PrdSkillSource;
	detail: string;
	at: string;
}

export interface PrdState {
	prdId: string;
	prdPath: string;
	/** `artifact://` reference to the PRD body — the body itself never lives here. */
	artifactRef: string;
	skillSource: PrdSkillSource;
	requiredCapability: RequiredCapability;
	criteria: CriterionRecord[];
	units: WorkUnit[];
	routing: PrdRoutingDecision[];
	closure?: PrdClosureRecord;
}

// ---------------------------------------------------------------------------
// Parsing the repository's PRD convention
// ---------------------------------------------------------------------------

export interface ParsedCriterion {
	id: string;
	text: string;
	verifyCommand: string;
}

const CRITERION_LINE = /^\s*-\s*\[[ xX]\]\s+(.*)$/;
const CRITERION_ID = /\bAC-\d+(?:\.\d+)?\b/;
const VERIFY_CLAUSE = /\b(?:verification|verify|verifies|verification command)\b\s*:?\s*`([^`]+)`/i;
const SECTION_HEADING = /^##\s+(.+?)\s*$/;
const TITLE_HEADING = /^#\s+(.+?)\s*$/;
const PHASE_HEADING = /^####\s+Phase\s+(\d+)\s*:\s*(.+?)\s*$/;
const BLOCK_FIELD = /^\*\*(ACs|Depends on)\s*:\*\*\s*(.*)$/i;
const ANY_HEADING = /^#{1,4}\s/;

/** Level-2 section bodies, keyed by heading text, in document order. */
export function sectionsOf(body: string): Map<string, string> {
	const sections = new Map<string, string>();
	let current: string | null = null;
	let buffer: string[] = [];
	const flush = () => {
		if (current !== null) sections.set(current, buffer.join("\n").trim());
	};
	for (const line of body.split("\n")) {
		const heading = SECTION_HEADING.exec(line);
		if (heading) {
			flush();
			current = heading[1]!;
			buffer = [];
			continue;
		}
		if (current !== null) buffer.push(line);
	}
	flush();
	return sections;
}

/** Criterion items of the `Acceptance Criteria` section, in document order. */
export function parseAcceptanceCriteria(body: string): ParsedCriterion[] {
	const section = sectionsOf(body).get("Acceptance Criteria") ?? "";
	const lines = section.split("\n");
	const criteria: ParsedCriterion[] = [];
	let index = 0;
	for (let i = 0; i < lines.length; i += 1) {
		const match = CRITERION_LINE.exec(lines[i]!);
		if (!match) continue;
		// The block is the item line plus any wrapped continuation lines.
		const block = [match[1]!];
		while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!) && !CRITERION_LINE.test(lines[i + 1]!)) {
			block.push(lines[i + 1]!.trim());
			i += 1;
		}
		const joined = block.join(" ");
		index += 1;
		const declared = CRITERION_ID.exec(joined);
		const id = declared ? declared[0].toUpperCase() : `AC-${index}`;
		const verifyCommand = VERIFY_CLAUSE.exec(joined)?.[1]?.trim() ?? "";
		criteria.push({ id, text: criterionText(joined, id), verifyCommand });
	}
	return criteria;
}

/** The criterion's prose with its id prefix, verify clause and trailing dashes removed. */
function criterionText(joined: string, id: string): string {
	const withoutId = joined.replace(new RegExp(`^\\s*${id}\\b[\\s:.—-]*`, "i"), "");
	const withoutClause = withoutId.replace(VERIFY_CLAUSE, "").trim();
	return withoutClause.replace(/[\s—:-]+$/, "").trim();
}

/** Work units from the PRD's `Phase N` blocks, or a single unit covering every criterion. */
export function parseWorkUnits(body: string, criteria: ParsedCriterion[], capability: RequiredCapability): WorkUnit[] {
	const lines = body.split("\n");
	const units: WorkUnit[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const phase = PHASE_HEADING.exec(lines[i]!);
		if (!phase) continue;
		const declaredAc: string[] = [];
		const declaredDeps: string[] = [];
		for (let j = i + 1; j < lines.length && !ANY_HEADING.test(lines[j]!); j += 1) {
			const field = BLOCK_FIELD.exec(lines[j]!);
			if (!field) continue;
			if (field[1]!.toLowerCase() === "acs") declaredAc.push(...field[2]!.split(/[,\s]+/));
			else declaredDeps.push(...field[2]!.split(/[,\s]+/));
		}
		units.push({
			id: `unit-${phase[1]!}`,
			objective: `Phase ${phase[1]!}: ${phase[2]!}`,
			// A declared id with no matching criterion would make the unit vacuously
			// complete — the phase's `**ACs:**` line is only accepted as a reference.
			criterionIds: declaredAc
				.filter((value) => criteria.some((criterion) => criterion.id === value.toUpperCase()))
				.map((value) => value.toUpperCase()),
			dependsOn: declaredDeps.map((value) => normalizeUnitId(value)).filter((value): value is string => value !== null),
			requiredCapability: { ...capability },
		});
	}

	if (units.length === 0) {
		const title = lines.map((line) => TITLE_HEADING.exec(line)?.[1]).find((value) => value !== undefined) ?? "PRD criteria";
		units.push({
			id: "unit-1",
			objective: title,
			criterionIds: criteria.map((criterion) => criterion.id),
			dependsOn: [],
			requiredCapability: { ...capability },
		});
	}

	// A criterion no phase declares is still required work: it rides the first unit.
	const claimed = new Set(units.flatMap((unit) => unit.criterionIds));
	for (const criterion of criteria) {
		if (claimed.has(criterion.id)) continue;
		units[0]!.criterionIds.push(criterion.id);
		claimed.add(criterion.id);
	}
	// A dependency naming no unit is dropped here rather than left to stall a unit.
	const known = new Set(units.map((unit) => unit.id));
	for (const unit of units) unit.dependsOn = unit.dependsOn.filter((id) => known.has(id));
	return units;
}

function normalizeUnitId(value: string): string | null {
	if (/^(none|—|-|n\/a)$/i.test(value)) return null;
	const digits = /(\d+)/.exec(value);
	return digits ? `unit-${digits[1]!}` : null;
}

export interface PrdStateInput {
	prdId: string;
	prdPath: string;
	body: string;
	artifactRef: string;
	skillSource: PrdSkillSource;
	requiredCapability: RequiredCapability;
}

export function createPrdState(input: PrdStateInput): PrdState {
	const parsed = parseAcceptanceCriteria(input.body);
	const units = parseWorkUnits(input.body, parsed, input.requiredCapability);
	const unitIdFor = (criterionId: string) =>
		units.find((unit) => unit.criterionIds.includes(criterionId))?.id ?? units[0]!.id;
	return {
		prdId: input.prdId,
		prdPath: input.prdPath,
		artifactRef: input.artifactRef,
		skillSource: input.skillSource,
		requiredCapability: { ...input.requiredCapability },
		criteria: parsed.map((criterion) => ({
			id: criterion.id,
			text: criterion.text,
			verifyCommand: criterion.verifyCommand,
			status: "PENDING",
			evidenceRef: null,
			unitId: unitIdFor(criterion.id),
		})),
		units,
		routing: [],
	};
}

// ---------------------------------------------------------------------------
// Persistence — one JSON file per repository, one active PRD
// ---------------------------------------------------------------------------

export function prdStateDir(cwd: string): string {
	return join(cwd, ".leanpi", "prd");
}

export function prdStatePath(cwd: string): string {
	return join(prdStateDir(cwd), "state.json");
}

export function writePrdState(cwd: string, state: PrdState): string {
	const path = prdStatePath(cwd);
	mkdirSync(prdStateDir(cwd), { recursive: true });
	writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`);
	return path;
}

export function readPrdState(cwd: string): PrdState | null {
	const path = prdStatePath(cwd);
	if (!existsSync(path)) return null;
	// A crash between truncate and write leaves invalid JSON; the next status
	// write overwrites it, so a corrupt store degrades to "no PRD" instead of
	// throwing on every prompt assembly.
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PrdState;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export interface TransitionInput {
	status: CriterionStatus;
	evidenceRef?: string | null;
	reason?: string;
}

export function criterionOf(state: PrdState, criterionId: string): CriterionRecord | undefined {
	return state.criteria.find((criterion) => criterion.id === criterionId);
}

/** The only writer of `CriterionRecord.status`. */
export function transitionCriterion(state: PrdState, criterionId: string, input: TransitionInput): CriterionRecord {
	const criterion = criterionOf(state, criterionId);
	if (!criterion) throw new UnknownCriterionError(criterionId);
	criterion.status = input.status;
	criterion.evidenceRef = input.evidenceRef ?? null;
	if (input.reason === undefined) delete criterion.reason;
	else criterion.reason = input.reason;
	return criterion;
}

export class UnknownCriterionError extends Error {
	constructor(criterionId: string) {
		super(`No acceptance criterion "${criterionId}" in the active PRD.`);
		this.name = "UnknownCriterionError";
	}
}

/** The PRD-level capability copied onto every unit, so PRD-020 routes from state. */
export function setRequiredCapability(state: PrdState, capability: RequiredCapability): PrdState {
	state.requiredCapability = { ...capability };
	for (const unit of state.units) unit.requiredCapability = { ...capability };
	return state;
}

// ---------------------------------------------------------------------------
// PRD-009's evidence records
// ---------------------------------------------------------------------------

/**
 * PRD-009 (`src/verify/evidence.ts`) owns the record: `{ kind, status,
 * workspaceHash, startedAt, exitCode, artifactRef, criterion, scope }`. It
 * carries no command, so "the criterion's `verifyCommand` ran" is established
 * from `VerifyResult.commands` — the commands the attempt actually resolved.
 */
export interface CriterionEvidenceContext {
	criterionId: string;
	verifyCommand: string;
	/** The workspace hash computed now; a record stamped otherwise is stale. */
	workspaceHash: string;
	/** PRD-009's `VerifyResult.commands`, in execution order. */
	commands: readonly string[];
}

export function criterionContext(
	criterion: CriterionRecord,
	workspaceHash: string,
	commands: readonly string[] = [],
): CriterionEvidenceContext {
	return { criterionId: criterion.id, verifyCommand: criterion.verifyCommand, workspaceHash, commands };
}

/** A record attributed to other criteria only cannot speak for this one. */
function covers(record: EvidenceRecord, criterionId: string): boolean {
	return record.criterion.length === 0 || record.criterion.includes(criterionId);
}

/**
 * One entry per descriptor that ran, plus hash-failure and skipped records, so
 * records and commands are not index-paired: the run-level command list is the
 * truthful signal. With no command list the record's own criterion attribution
 * is required instead — never a looser rule than the one above.
 */
function commandRan(record: EvidenceRecord, context: CriterionEvidenceContext): boolean {
	const declared = context.verifyCommand.trim();
	if (declared.length === 0) return false;
	if (context.commands.length > 0) return context.commands.some((command) => command.trim() === declared);
	return record.criterion.includes(context.criterionId);
}

/** A fresh `pass` for this criterion's command, or nothing — the deterministic rule. */
export function freshPassingRecord(
	records: readonly EvidenceRecord[],
	context: CriterionEvidenceContext,
): EvidenceRecord | undefined {
	return records.find(
		(record) =>
			record.status === "pass" &&
			record.workspaceHash === context.workspaceHash &&
			covers(record, context.criterionId) &&
			commandRan(record, context),
	);
}

/** Any failing measurement for the criterion, fresh or not: a disproved claim reopens. */
export function failingRecord(records: readonly EvidenceRecord[], criterionId: string): EvidenceRecord | undefined {
	return records.find(
		(record) => (record.status === "fail" || record.status === "error") && covers(record, criterionId),
	);
}
