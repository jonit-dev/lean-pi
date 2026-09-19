/**
 * PRD authoring (PRD-012 Phase 1, FR-030/FR-031).
 *
 * The authoring *contract* is the operator's installed `prd-creator` skill, read
 * through PRD-005's registry so PRD-017's trust filtering applies; LeanPi keeps
 * no inline copy of its rules. When the skill is absent every load reports
 * `builtin-fallback` and the minimal contract below stands in — a degradation
 * that is recorded, never silent.
 *
 * The one hard validation is the machine-verifiable rule: a criterion without a
 * runnable verification command is re-asked once, then surfaced as a named gap
 * instead of being written as prose.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSkillRoots, loadSkillBody, scanSkills, type SkillRecord, type SkillRoot } from "../capabilities/skills.js";
import type { LeanPiConfig } from "../core/types.js";
import { isProjectLocal } from "../permissions/trust.js";
import { noteLaneModuleLoad } from "./dispatch.js";
import {
	REQUIREMENT_SECTIONS,
	parseAcceptanceCriteria,
	sectionsOf,
	type ParsedCriterion,
	type PrdSkillSource,
	type RequirementSection,
} from "./state.js";

noteLaneModuleLoad("creator");

export interface InstalledSkill {
	name: string;
	path: string;
	body: string;
	root: string;
}

export interface SkillResolutionInput {
	cwd: string;
	config: LeanPiConfig;
	name: string;
}

/**
 * `capabilities.skillRoots` when the operator declared them, otherwise PRD-005's
 * default order (project → user global → plugin). No private path setting.
 */
export function skillRootsFor(cwd: string, config: LeanPiConfig): SkillRoot[] {
	const declared = config.capabilities.skillRoots;
	if (declared.length > 0) {
		return declared.map((path): SkillRoot => ({ path, class: isProjectLocal(cwd, path) ? "project" : "user" }));
	}
	return defaultSkillRoots(cwd);
}

function recordOf(input: SkillResolutionInput): SkillRecord | undefined {
	const roots = skillRootsFor(input.cwd, input.config);
	return scanSkills(input.cwd, { roots }).find((record) => record.name === input.name && record.status === "ok");
}

/** Resolve one installed skill's body, or `null` when it is not installed. */
export function resolveInstalledSkill(input: SkillResolutionInput): InstalledSkill | null {
	const record = recordOf(input);
	if (!record) return null;
	try {
		return { name: record.name, path: record.source.path, body: loadSkillBody(record), root: record.source.root };
	} catch {
		return null;
	}
}

/** The path of a skill's bundled script, or `null` when the skill is not installed. */
export function resolveSkillScript(input: SkillResolutionInput & { script: string }): string | null {
	const record = recordOf(input);
	if (!record) return null;
	const path = join(record.source.path, "..", input.script);
	return existsSync(path) ? path : null;
}

/** Covers the nine §11.1 sections only — it is a floor, not a copy of the skill. */
export const BUILTIN_AUTHORING_CONTRACT = [
	"Author a PRD for the objective below.",
	"",
	"Produce exactly these nine level-2 sections, in this order, each with a non-empty body:",
	...REQUIREMENT_SECTIONS.map((section, index) => `${index + 1}. ${section}`),
	"",
	"Under Acceptance Criteria, list one item per criterion as `- [ ] AC-1 <text> — Verify: `<command>``.",
	"Every criterion MUST carry a runnable verification command; a criterion without one is not a criterion.",
	"Prefer machine-verifiable criteria over prose promises.",
].join("\n");

export interface AuthoringContract {
	contract: string;
	source: PrdSkillSource;
	skillPath: string | null;
}

export function loadAuthoringContract(input: { cwd: string; config: LeanPiConfig }): AuthoringContract {
	const skill = resolveInstalledSkill({ ...input, name: "prd-creator" });
	if (skill && skill.body.trim().length > 0) {
		return { contract: skill.body, source: "installed", skillPath: skill.path };
	}
	return { contract: BUILTIN_AUTHORING_CONTRACT, source: "builtin-fallback", skillPath: null };
}

export interface AuthoringRequest {
	objective: string;
	/** The authoring contract text handed to the model; observable in the request. */
	contract: string;
	contractSource: PrdSkillSource;
	sections: readonly RequirementSection[];
	/** Present only on the single targeted re-ask. */
	reask?: {
		missingSections: RequirementSection[];
		commandless: Array<{ id: string; text: string }>;
	};
}

export type AuthoringModel = (request: AuthoringRequest) => Promise<string>;

export interface AuthoredPrd {
	objective: string;
	sections: Partial<Record<RequirementSection, string>>;
	/** Validated criteria only — each carries a runnable verification command. */
	criteria: ParsedCriterion[];
	missingSections: RequirementSection[];
	/** Criteria the model could not make verifiable, named by id. */
	gaps: Array<{ id: string; reason: string }>;
	contractSource: PrdSkillSource;
	skillPath: string | null;
}

interface ValidatedAuthoring {
	sections: Partial<Record<RequirementSection, string>>;
	missingSections: RequirementSection[];
	criteria: ParsedCriterion[];
	commandless: Array<{ id: string; text: string }>;
}

function validateAuthored(markdown: string): ValidatedAuthoring {
	const found = sectionsOf(markdown);
	const sections: Partial<Record<RequirementSection, string>> = {};
	const missingSections: RequirementSection[] = [];
	for (const section of REQUIREMENT_SECTIONS) {
		const body = found.get(section)?.trim() ?? "";
		if (body.length === 0) missingSections.push(section);
		else sections[section] = body;
	}
	const parsed = parseAcceptanceCriteria(markdown);
	return {
		sections,
		missingSections,
		criteria: parsed.filter((criterion) => criterion.verifyCommand.length > 0),
		commandless: parsed
			.filter((criterion) => criterion.verifyCommand.length === 0)
			.map((criterion) => ({ id: criterion.id, text: criterion.text })),
	};
}

/** One authoring pass, then one targeted re-ask for what failed validation. */
export async function authorPrd(input: {
	objective: string;
	cwd: string;
	config: LeanPiConfig;
	author: AuthoringModel;
}): Promise<AuthoredPrd> {
	const loaded = loadAuthoringContract(input);
	const request: AuthoringRequest = {
		objective: input.objective,
		contract: loaded.contract,
		contractSource: loaded.source,
		sections: REQUIREMENT_SECTIONS,
	};

	let validated = validateAuthored(await input.author(request));
	if (validated.missingSections.length > 0 || validated.commandless.length > 0) {
		validated = validateAuthored(
			await input.author({
				...request,
				reask: { missingSections: validated.missingSections, commandless: validated.commandless },
			}),
		);
	}

	return {
		objective: input.objective,
		sections: validated.sections,
		criteria: validated.criteria,
		missingSections: validated.missingSections,
		gaps: validated.commandless.map((criterion) => ({
			id: criterion.id,
			reason: "no runnable verification command",
		})),
		contractSource: loaded.source,
		skillPath: loaded.skillPath,
	};
}

// ---------------------------------------------------------------------------
// Writing the repository's PRD convention
// ---------------------------------------------------------------------------

export function prdDirectory(cwd: string): string {
	return join(cwd, "docs", "PRDs", "v1");
}

/** The next free `PRD-NNN` for this repository; an existing id is never reused. */
export function allocatePrdId(cwd: string): string {
	const directory = prdDirectory(cwd);
	let highest = 0;
	if (existsSync(directory)) {
		for (const entry of readdirSync(directory)) {
			const match = /^PRD-(\d+)/.exec(entry);
			if (match) highest = Math.max(highest, Number.parseInt(match[1]!, 10));
		}
	}
	return `PRD-${String(highest + 1).padStart(3, "0")}`;
}

function slug(objective: string): string {
	return (
		objective
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48)
			.replace(/-+$/, "") || "objective"
	);
}

/** The path for a new PRD; a collision gains a suffix rather than overwriting. */
export function prdFilePath(cwd: string, id: string, objective: string): string {
	const directory = prdDirectory(cwd);
	const base = `${id}-${slug(objective)}`;
	let path = join(directory, `${base}.md`);
	let attempt = 2;
	while (existsSync(path)) {
		path = join(directory, `${base}-${attempt}.md`);
		attempt += 1;
	}
	return path;
}

/** The file body: the nine sections, with the criteria section normalized to machine-checkable items. */
export function renderPrdFile(input: { id: string; objective: string; authored: AuthoredPrd }): string {
	const contract = input.authored.contractSource === "installed" ? "prd-creator (installed)" : "prd-creator (builtin-fallback)";
	const lines = [`# ${input.id} — ${input.objective}`, "", "**Status:** NOT STARTED", `**Authoring contract:** ${contract}`, ""];
	for (const section of REQUIREMENT_SECTIONS) {
		lines.push(`## ${section}`, "");
		if (section === "Acceptance Criteria") {
			lines.push(...input.authored.criteria.map((criterion) => `- [ ] ${criterion.id} ${criterion.text} — Verify: \`${criterion.verifyCommand}\``));
		} else {
			lines.push(input.authored.sections[section]!.trim());
		}
		lines.push("");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

export interface WrittenPrd {
	id: string;
	path: string;
	body: string;
}

export function writePrdFile(cwd: string, authored: AuthoredPrd): WrittenPrd {
	const id = allocatePrdId(cwd);
	const path = prdFilePath(cwd, id, authored.objective);
	const body = renderPrdFile({ id, objective: authored.objective, authored });
	mkdirSync(prdDirectory(cwd), { recursive: true });
	writeFileSync(path, body);
	return { id, path, body };
}
