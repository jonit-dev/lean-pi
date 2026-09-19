/**
 * The decision-site registry (PRD-002 Phase 2, FR-020, ROADMAP §49).
 *
 * A site is declared once with `{ id, questions, returnType, consequence,
 * fallback, telemetryTag }`. Registration refuses a site whose fallback is
 * missing, and `ask()` refuses an unregistered id, so §49's "JEV is never a
 * single point of failure" is structural rather than remembered per call site.
 */
import { createHash } from "node:crypto";
import type { Consequence, JevQuestion, JevResult, JevUsage, QuestionKind } from "./types.js";

export interface FallbackContext {
	siteId: string;
	reason: string;
	state: unknown;
	questions: JevQuestion[];
}

/** Deterministic, non-null: the branch taken when JEV is off, unreachable or unconfident. */
export type SiteFallback = (context: FallbackContext) => JevResult[];

export interface DecisionSite {
	id: string;
	questions: JevQuestion[];
	returnType: QuestionKind[];
	consequence: Consequence;
	fallback: SiteFallback;
	telemetryTag: string;
}

export class DuplicateSiteError extends Error {
	constructor(id: string) {
		super(`Decision site "${id}" is already registered.`);
		this.name = "DuplicateSiteError";
	}
}

export class MissingFallbackError extends Error {
	constructor(id: string) {
		super(`Decision site "${id}" must declare a non-null deterministic fallback (§49).`);
		this.name = "MissingFallbackError";
	}
}

export class UnknownSiteError extends Error {
	constructor(id: string) {
		super(`Decision site "${id}" is not registered.`);
		this.name = "UnknownSiteError";
	}
}

const sites = new Map<string, DecisionSite>();

export function registerSite(site: DecisionSite): DecisionSite {
	if (!site.fallback || typeof site.fallback !== "function") throw new MissingFallbackError(site.id);
	if (sites.has(site.id)) throw new DuplicateSiteError(site.id);
	if (!site.telemetryTag) throw new Error(`Decision site "${site.id}" must declare a telemetryTag.`);
	if (site.questions.length !== site.returnType.length) {
		throw new Error(
			`Decision site "${site.id}" declares ${site.questions.length} questions but ${site.returnType.length} return types.`,
		);
	}
	site.questions.forEach((question, index) => {
		if (question.kind !== site.returnType[index]) {
			throw new Error(
				`Decision site "${site.id}" question "${question.id}" is ${question.kind} but its return type is ${site.returnType[index]}.`,
			);
		}
	});
	sites.set(site.id, site);
	return site;
}

/** Idempotent registration: a compiler may compile many tasks in one process. */
export function ensureSite(site: DecisionSite): DecisionSite {
	const existing = sites.get(site.id);
	if (existing) return existing;
	return registerSite(site);
}

export function getSite(id: string): DecisionSite {
	const site = sites.get(id);
	if (!site) throw new UnknownSiteError(id);
	return site;
}

export function listSites(): DecisionSite[] {
	return [...sites.values()];
}

/** Test seam: the registry is startup-scoped state, like LeanPi's own process. */
export function clearSites(): void {
	sites.clear();
}

/** Token counts are recorded so PRD-015 can aggregate cost without re-instrumenting call sites. */
export function emptyUsage(): JevUsage {
	return { inputTokens: 0, outputTokens: 0 };
}

/** Stable, salted path hash used by `metadata-only` mode. */
export function pathHash(value: string, salt: string): string {
	return createHash("sha256").update(`${salt}:${value}`).digest("hex").slice(0, 16);
}
