/**
 * LSP mode selection (PRD-018 Phase 1, FR-090–FR-094, ROADMAP §18).
 *
 * A deterministic table over four cheap inputs, in strict precedence order:
 * project configuration → changed-language/server availability → task type →
 * FR-094's typecheck override. Only a genuine tie reaches the `lsp.usefulness`
 * JEV site, and that site's deterministic fallback is the cheapest tied
 * candidate, so LSP never depends on JEV. `LSP_FULL` is reachable *only* through
 * explicit `lsp: full` configuration.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LspConfigMode } from "./config.js";

export const LSP_MODES = ["LSP_OFF", "LSP_DIAGNOSTICS", "LSP_NAVIGATION", "LSP_FULL"] as const;

export type LspMode = (typeof LSP_MODES)[number];

/** Cheapest-first; the tie-break fallback takes the earliest of the tied set. */
export const LSP_MODE_ORDER: readonly LspMode[] = LSP_MODES;

export function cheapestMode(candidates: readonly LspMode[]): LspMode {
	for (const mode of LSP_MODE_ORDER) if (candidates.includes(mode)) return mode;
	return "LSP_OFF";
}

/** The configured modes that are final. `auto` is absent on purpose. */
const EXPLICIT_MODES: Record<Exclude<LspConfigMode, "auto">, LspMode> = {
	off: "LSP_OFF",
	diagnostics: "LSP_DIAGNOSTICS",
	navigation: "LSP_NAVIGATION",
	full: "LSP_FULL",
};

/** Symbol-level work: navigation is the whole point (PRD-018's second anchor case). */
const NAVIGATION_TASK_TYPES: Record<string, true> = {
	refactor: true,
	rename: true,
	codemod: true,
	migration: true,
	"api-change": true,
	"find-callers": true,
};

/** Correctness work: type errors are the signal, and FR-094 may replace the server entirely. */
const DIAGNOSTICS_TASK_TYPES: Record<string, true> = { bugfix: true, feature: true, fix: true, correctness: true, test: true };

/** The candidates an ambiguous task may resolve to; `LSP_FULL` is never a table outcome. */
export const LSP_TIE_CANDIDATES: readonly LspMode[] = ["LSP_OFF", "LSP_DIAGNOSTICS", "LSP_NAVIGATION"];

const NO_TOKENS: LspTokenUsage = { inputTokens: 0, outputTokens: 0 };

/** A cheaper one-shot type check, when the repository exposes one. */
export interface TargetedCheck {
	kind: "typecheck";
	/** The command as the repository declares it; PRD-009 resolves it. */
	command: string;
	source: "config" | "package.json" | "cargo" | "go";
}

export interface LspUsefulnessContext {
	taskType: string;
	taskSummary: string;
	changedLanguages: readonly string[];
	candidates: readonly LspMode[];
}

export interface LspTokenUsage {
	inputTokens: number;
	outputTokens: number;
}

/** The `lsp.usefulness` seam: one candidate, or `null` when JEV is off/unconfident. */
export interface LspUsefulnessAsker {
	choose(context: LspUsefulnessContext, signal?: AbortSignal): Promise<{ mode: LspMode; confidence: number; tokens?: LspTokenUsage } | null>;
}

export interface LspModeInput {
	configMode: LspConfigMode;
	/** Languages of the task's target paths plus the repository manifest. */
	changedLanguages: readonly string[];
	/** Languages whose server resolved right now (`detectServers`). */
	availableServers: readonly string[];
	taskType: string;
	targetedCheck?: TargetedCheck;
	taskSummary?: string;
	asker?: LspUsefulnessAsker;
	/** The per-turn compile budget, so a hung `lsp.usefulness` ask cannot outlive it. */
	signal?: AbortSignal;
}

export interface LspSelection {
	mode: LspMode;
	/** Why this mode won — the precedence step that decided it. */
	reason: string;
	targetedCheck?: TargetedCheck;
	/** Candidates the deterministic table could not separate; empty when it could. */
	tied: LspMode[];
	/** True when the `lsp.usefulness` site was consulted. */
	jevSiteUsed: boolean;
	/** True when the site's deterministic fallback, not a JEV answer, decided. */
	fallbackUsed: boolean;
	confidence: number;
	/** Tokens the site consumed; zero whenever the deterministic path decided. */
	tokens: LspTokenUsage;
}

/** Script names that are a type check by definition. */
const TYPE_CHECK_SCRIPTS = ["typecheck", "type-check", "check", "types", "tsc"];

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * FR-094's cheaper alternative to a resident diagnostics stream: a one-shot
 * *type-checking* command only. A `lint` script never qualifies — style output
 * cannot stand in for type feedback.
 */
export function preferTargetedCheck(root: string, configured?: string): TargetedCheck | undefined {
	if (typeof configured === "string" && configured.trim().length > 0) {
		return { kind: "typecheck", command: configured.trim(), source: "config" };
	}
	const manifest = readJson(join(root, "package.json"));
	const scripts = manifest?.scripts;
	if (scripts !== undefined && scripts !== null && typeof scripts === "object") {
		const entries = scripts as Record<string, unknown>;
		for (const name of TYPE_CHECK_SCRIPTS) {
			if (typeof entries[name] === "string") return { kind: "typecheck", command: `npm run ${name}`, source: "package.json" };
		}
		for (const [name, command] of Object.entries(entries)) {
			if (typeof command === "string" && /^(npx\s+)?tsc(\s|$)/.test(command.trim())) {
				return { kind: "typecheck", command: `npm run ${name}`, source: "package.json" };
			}
		}
	}
	if (existsSync(join(root, "Cargo.toml"))) return { kind: "typecheck", command: "cargo check", source: "cargo" };
	if (existsSync(join(root, "go.mod"))) return { kind: "typecheck", command: "go vet ./...", source: "go" };
	return undefined;
}

export function changedLanguagesWithServers(changedLanguages: readonly string[], availableServers: readonly string[]): string[] {
	const available = new Set(availableServers);
	const served: string[] = [];
	for (const language of changedLanguages) if (available.has(language) && !served.includes(language)) served.push(language);
	return served;
}

/**
 * The deterministic table, then the tie-break. Pure apart from the injected
 * asker, which is consulted nowhere else.
 */
export async function selectLspMode(input: LspModeInput): Promise<LspSelection> {
	// 1. Project configuration is final; `auto` is the only non-final value.
	if (input.configMode !== "auto") {
		return {
			mode: EXPLICIT_MODES[input.configMode],
			reason: `project-config:${input.configMode}`,
			tied: [],
			jevSiteUsed: false,
			fallbackUsed: false,
			confidence: 1,
			tokens: NO_TOKENS,
		};
	}

	// 2. No server for any changed language: off, never an error. A Markdown-only
	//    change lands here — ROADMAP §18's first anchor case.
	const served = changedLanguagesWithServers(input.changedLanguages, input.availableServers);
	if (served.length === 0) {
		return { mode: "LSP_OFF", reason: "no-server-for-changed-language", tied: [], jevSiteUsed: false, fallbackUsed: false, confidence: 1, tokens: NO_TOKENS };
	}

	// 3. Task type × language availability.
	if (NAVIGATION_TASK_TYPES[input.taskType] === true) {
		return { mode: "LSP_NAVIGATION", reason: `task-type:${input.taskType}`, tied: [], jevSiteUsed: false, fallbackUsed: false, confidence: 1, tokens: NO_TOKENS };
	}
	if (DIAGNOSTICS_TASK_TYPES[input.taskType] === true) {
		// 4. FR-094: a one-shot type check beats holding a server for one poll.
		if (input.targetedCheck) {
			return {
				mode: "LSP_OFF",
				reason: "fr-094-targeted-typecheck",
				targetedCheck: input.targetedCheck,
				tied: [],
				jevSiteUsed: false,
				fallbackUsed: false,
				confidence: 1,
				tokens: NO_TOKENS,
			};
		}
		return { mode: "LSP_DIAGNOSTICS", reason: `task-type:${input.taskType}`, tied: [], jevSiteUsed: false, fallbackUsed: false, confidence: 1, tokens: NO_TOKENS };
	}

	// 5. Genuine tie: an unclassified task type with a server-backed language in
	//    scope. The site may answer; its absence, failure or low confidence leaves
	//    the cheapest candidate.
	const tied = [...LSP_TIE_CANDIDATES];
	const context: LspUsefulnessContext = {
		taskType: input.taskType,
		taskSummary: input.taskSummary ?? "",
		changedLanguages: [...input.changedLanguages],
		candidates: tied,
	};
	const answer = input.asker ? await input.asker.choose(context, input.signal) : null;
	if (answer && tied.includes(answer.mode)) {
		return {
			mode: answer.mode,
			reason: "jev:lsp.usefulness",
			tied,
			jevSiteUsed: true,
			fallbackUsed: false,
			confidence: answer.confidence,
			tokens: answer.tokens ?? NO_TOKENS,
		};
	}
	return { mode: cheapestMode(tied), reason: "jev-fallback:cheapest-tied", tied, jevSiteUsed: true, fallbackUsed: true, confidence: 0, tokens: NO_TOKENS };
}
