/**
 * Disclosure pipeline: rank → verify → load (PRD-005 Phase 2, ROADMAP §16).
 *
 * The full lightweight registry goes to one JEV request; only the top-K
 * candidates' full frontmatter goes to a second; only confirmed skills' bodies
 * are read. JEV may answer *no skill required*, which is the normal, cheapest
 * outcome — and when JEV is off the same pipeline degrades to lexical/tag
 * routing with pins still honored (§49).
 */
import type { LeanPiConfig, SelectedSkill } from "../core/types.js";
import type { JevClient } from "../jev/client.js";
import { accept } from "../jev/confidence.js";
import { ensureSite } from "../jev/registry.js";
import type { JevQuestion, JevResult } from "../jev/types.js";
import { loadSkillBody, type SkillControl, type SkillRecord } from "./skills.js";

export const SKILL_SITE_ID = "skill.disclosure";
export const DEFAULT_TOP_K = 5;

export interface SkillDisclosureDecision {
	topK: string[];
	loaded: string[];
	pinned: string[];
	fallbackUsed: boolean;
	reason: string;
}

export interface SelectSkillsInput {
	records: SkillRecord[];
	control: SkillControl;
	request: string;
	config: LeanPiConfig;
	client?: Pick<JevClient, "ask" | "fallbackCount"> & Partial<Pick<JevClient, "getMode">>;
	topK?: number;
	/**
	 * The body loader. The native turn lane passes a pointer loader instead —
	 * inside Pi's own loop a body is re-sent on every provider call — and a spec
	 * passes one to assert what was read.
	 */
	loadBody?: (record: SkillRecord) => string;
}

export interface SelectSkillsResult {
	skills: SelectedSkill[];
	decision: SkillDisclosureDecision;
}

/** Registered once per process; the fallback answers "no skill", which is the safe direction. */
export function registerSkillSite(): void {
	ensureSite({
		id: SKILL_SITE_ID,
		// A template: the real batch carries one relevance question per candidate.
		questions: [
			{ id: "any_skill", kind: "Choice", text: "Does this task require any skill from the library?", options: { yes: "yes", no: "no" } },
			{ id: "relevance", kind: "Score", text: "How relevant is this skill to the task?", levels: ["irrelevant", "tangential", "relevant", "essential"] },
		],
		returnType: ["Choice", "Score"],
		consequence: "normal",
		telemetryTag: SKILL_SITE_ID,
		fallback: ({ questions }): JevResult[] =>
			questions.map((question): JevResult =>
				question.kind === "Choice"
					? { kind: "Choice", questionId: question.id, choice: "no", probabilities: {}, confidence: 0 }
					: { kind: "Score", questionId: question.id, score: 0, legend: {}, confidence: 0 },
			),
	});
}

const STOP_WORDS = new Set(["the", "a", "an", "to", "of", "and", "for", "with", "in", "on", "is", "it", "this", "that"]);

function tokens(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

/** Token overlap against name/description/tags — the §49 deterministic path. */
export function lexicalSelect(records: SkillRecord[], request: string, limit: number): SkillRecord[] {
	const wanted = new Set(tokens(request));
	const scored = records.map((record) => {
		const haystack = new Set(tokens([record.name, record.description, ...record.tags].join(" ")));
		let overlap = 0;
		for (const token of haystack) if (wanted.has(token)) overlap += 1;
		const nameHit = tokens(request).some((token) => record.name.toLowerCase().includes(token)) ? 2 : 0;
		return { record, score: overlap + nameHit };
	});
	return scored
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || left.record.name.localeCompare(right.record.name))
		.slice(0, limit)
		.map((entry) => entry.record);
}

function relevanceQuestions(records: SkillRecord[]): JevQuestion[] {
	return [
		{ id: "any_skill", kind: "Choice", text: "Does this task require any skill from the library?", options: { yes: "yes", no: "no" } },
		...records.map(
			(record): JevQuestion => ({
				id: `relevance:${record.name}`,
				kind: "Score",
				text: `How relevant is this skill to the task? ${record.name}: ${record.description}`.slice(0, 400),
				levels: ["irrelevant", "tangential", "relevant", "essential"],
			}),
		),
	];
}

function fitQuestions(records: SkillRecord[]): JevQuestion[] {
	return records.map(
		(record): JevQuestion => ({
			id: `fit:${record.name}`,
			kind: "Choice",
			text: `Does this skill actually fit the task? ${record.name}: ${record.description} [tag: ${record.tags.join(", ")}]`.slice(0, 400),
			options: { yes: "yes", no: "no" },
		}),
	);
}

/**
 * Run the pipeline. Pinned skills are injected unconditionally and never enter
 * ranking; disabled skills are dropped before stage 1 and disable wins over pin.
 */
export async function selectSkills(input: SelectSkillsInput): Promise<SelectSkillsResult> {
	registerSkillSite();
	const { records, control, request, config, client } = input;
	const maxLoaded = input.topK ?? config.skills.maxLoaded;
	const loadBody = input.loadBody ?? loadSkillBody;

	const pinnedRecords = control.pinnedRecords(records);
	const candidates = control.candidates(records);
	const decision: SkillDisclosureDecision = {
		topK: [],
		loaded: [],
		pinned: pinnedRecords.map((record) => record.name),
		fallbackUsed: false,
		reason: "",
	};

	const finish = (confirmed: SkillRecord[]): SelectSkillsResult => {
		const chosen = [...pinnedRecords, ...confirmed].slice(0, Math.max(maxLoaded, pinnedRecords.length));
		const skills = chosen.map((record) => ({
			name: record.name,
			source: `${record.source.class}:${record.source.path}`,
			body: loadBody(record),
		}));
		decision.loaded = chosen.map((record) => record.name);
		return { skills, decision };
	};

	if (candidates.length === 0) {
		decision.reason = "no enabled, unpinned candidates";
		return finish([]);
	}

	// Even with JEV disabled the call goes through the client: it short-circuits
	// without a request, resolves the site through its fallback and writes the
	// telemetry row the decision log owes. No second code path to drift.
	if (client) {
		const before = client.fallbackCount();
		let results: JevResult[] | undefined;
		try {
			results = await client.ask(SKILL_SITE_ID, relevanceQuestions(candidates), {
				request,
				registry: candidates.map((record) => `${record.name}: ${record.description.slice(0, 120)}`),
			});
		} catch {
			results = undefined;
		}
		const fellBack = results === undefined || client.fallbackCount() > before;
		if (!fellBack) {
			const anySkill = results!.find((result) => result.questionId === "any_skill");
			const asked = anySkill && anySkill.kind === "Choice" && anySkill.choice === "yes" && accept(anySkill, "normal");
			if (!anySkill || !asked) {
				decision.reason = "JEV answered: no skill required";
				return finish([]);
			}
			const scored = candidates
				.map((record) => {
					const answer = results!.find((result) => result.questionId === `relevance:${record.name}`);
					const score = answer && answer.kind === "Score" && accept(answer, "normal") ? answer.score : -1;
					return { record, score };
				})
				.filter((entry) => entry.score >= 0)
				.sort((left, right) => right.score - left.score || left.record.name.localeCompare(right.record.name));
			const topK = scored.slice(0, DEFAULT_TOP_K).map((entry) => entry.record);
			decision.topK = topK.map((record) => record.name);

			const beforeFit = client.fallbackCount();
			let fit: JevResult[] | undefined;
			try {
				fit = await client.ask(SKILL_SITE_ID, fitQuestions(topK), { request });
			} catch {
				fit = undefined;
			}
			if (fit === undefined || client.fallbackCount() > beforeFit) {
				decision.fallbackUsed = true;
				decision.reason = "fit verification fell back";
				return finish(lexicalSelect(candidates, request, maxLoaded - pinnedRecords.length));
			}
			const confirmed = topK.filter((record) => {
				const answer = fit!.find((result) => result.questionId === `fit:${record.name}`);
				return answer?.kind === "Choice" && answer.choice === "yes" && accept(answer, "normal");
			});
			decision.reason = confirmed.length > 0 ? "JEV confirmed" : "JEV rejected every candidate";
			return finish(confirmed.slice(0, Math.max(maxLoaded - pinnedRecords.length, 0)));
		}
		decision.fallbackUsed = true;
		decision.reason = client.getMode !== undefined && client.getMode() === "disabled" ? "JEV disabled" : "JEV unavailable";
	} else {
		decision.fallbackUsed = true;
		decision.reason = "no JEV client";
	}

	// §49: lexical/tag routing over the same registry, same cap, pins still honored.
	const lexical = lexicalSelect(candidates, request, Math.max(maxLoaded - pinnedRecords.length, 0));
	decision.topK = lexical.map((record) => record.name);
	return finish(lexical);
}
