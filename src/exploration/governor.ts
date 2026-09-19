/**
 * The exploration governor (PRD-023 Phases 1–4, ROADMAP §6.3/§6.4/§15/§21/§49).
 *
 * Narrow contract: **candidates in, a bounded selection out**. Rounds are:
 * choose subsystem (site 3) → gather → rank and filter (sites 1, 4) → expand
 * siblings (site 5) → budget gate → stop? (site 2). The governor never names a
 * file: every selection is a prefix of a deterministically produced candidate
 * set, and every JEV answer it does not receive is answered by the site's
 * registered fallback, so the deterministic path is the shipped default and can
 * never be a single point of failure (§49).
 *
 * Reversibility is structural: a dropped snippet is written to PRD-014's
 * artifact store *before* it leaves the selection, so a wrong drop costs one
 * expansion instead of a lost fact (§21).
 */
import type { ArtifactStore } from "../context/artifacts.js";
import { buildExcerpt } from "../context/excerpt.js";
import type { LeanPiConfig } from "../core/types.js";
import type { JevClient } from "../jev/client.js";
import { accept } from "../jev/confidence.js";
import { getSite } from "../jev/registry.js";
import { answerValue, type JevQuestion, type JevResult } from "../jev/types.js";
import type { TaskPacket } from "../scout/index.js";
import { BudgetLedger, explorationSettingsOf, gateSelection, type ExploreBudget, type ExplorationSettings } from "./budget.js";
import { candidateLanguage, gatherCandidates, objectiveTerms, type Candidate, type SearchPort } from "./gather.js";
import { buildSnippet, capSnippet, candidateQuestionId, levelToScore, overlayScores, rankCandidates, snippetVerdict, type RankedCandidate, type Snippet } from "./rank.js";
import { discoverTests, overlayTestScores, rankTests, testQuestionId, type TestCandidate } from "./tests.js";
import {
	EXPLORATION_CANDIDATE_SITE_ID,
	EXPLORATION_FALLBACK_NAMES,
	EXPLORATION_SITE_IDS,
	EXPLORATION_SNIPPET_SITE_ID,
	EXPLORATION_SIBLING_SITE_ID,
	SUBSYSTEM_IMPLICATED_QUESTION_ID,
	SUBSYSTEM_ROOT_QUESTION_ID,
	EXPLORATION_SUBSYSTEM_SITE_ID,
	SUFFICIENCY_QUESTION_ID,
	EXPLORATION_SUFFICIENCY_SITE_ID,
	EXPLORATION_TEST_SITE_ID,
	candidateQuestions,
	registerExplorationSites,
	siblingQuestionId,
	siblingQuestions,
	siblingVerdict,
	siteFallbackAnswers,
	snippetQuestions,
	subsystemQuestions,
	sufficiencyQuestions,
	testQuestions,
	type ExplorationSiteId,
	type SiblingCandidate,
	type SiblingClass,
} from "./sites.js";

export type StopReason = "enough_evidence" | "budget_exhausted" | "no_new_file";

export interface ExploreRequest {
	objective: string;
	/** The PRD-003 packet: this module's seed, never re-derived. */
	packet: TaskPacket;
	/** Overrides the packet's changed files when the caller has fresher diff facts. */
	changedFiles?: readonly string[];
	/** Explicit subsystem roots; defaults to the packet's own modules and directories. */
	roots?: readonly string[];
}

export interface ExploreDeps {
	search: SearchPort;
	artifacts: ArtifactStore;
	/** The JEV control plane. Absent, or `jevEnabled: false`, means the fallbacks answer everything. */
	jev?: Pick<JevClient, "ask" | "fallbackCount"> & Partial<Pick<JevClient, "getMode">>;
	jevEnabled?: boolean;
	config?: LeanPiConfig | null;
	budget?: Partial<ExploreBudget>;
	settings?: Partial<ExplorationSettings>;
	/**
	 * Symbol queries backed by PRD-018's LSP navigation, used only when the scout
	 * packet says a server is available. A failing port costs evidence, never the run.
	 */
	symbols?: (terms: readonly string[]) => Array<{ path: string; count: number }>;
	/** PRD-014 handoff: the excerpts and `artifact://` refs a consumer writes into `WorkingState`. */
	writeContext?: (selection: ContextSelection) => void;
}

export interface SelectedFile {
	path: string;
	language: string;
	/** The file's own size. */
	bytes: number;
	/** What this file costs the context budget. */
	contextBytes: number;
	score: number;
	matchCount: number;
	symbolHits: number;
	/** The compact representation handed to the executor, ending in the expandable ref. */
	excerpt: string;
	/** `artifact://` ref of the full file, so the excerpt is expandable. */
	artifact: string;
	source: "jev" | "fallback";
	/** Set when the file entered through site 5 rather than as a candidate. */
	siblingOf?: string;
	siblingClass?: SiblingClass;
}

export interface ContextSnippet {
	id: string;
	path: string;
	text: string;
	contextBytes: number;
	artifact: string;
	sourceRef: string;
	score: number;
	source: "jev" | "fallback";
}

export interface DroppedRef {
	/** `artifact://` ref that resolves to the dropped bytes, byte for byte. */
	ref: string;
	path: string;
	/** Where the bytes came from, e.g. `grep:src/app.ts`. */
	sourceRef: string;
	bytes: number;
	kind: "snippet" | "snippet-overflow";
	reason: string;
}

export interface SiteDecision {
	site: ExplorationSiteId;
	questionId: string;
	source: "jev" | "fallback";
	value: string | number | null;
	reason: string;
}

export interface Degradation {
	site: ExplorationSiteId;
	/** The deterministic branch this site took instead. */
	fallback: string;
	reason: string;
}

export interface RoundRecord {
	round: number;
	subsystem: string;
	/** Deterministic candidates this round produced. */
	candidates: number;
	accepted: number;
	/** Files this round added to context, siblings included. */
	added: number;
	siblingFiles: number;
	bytes: number;
}

export interface ContextSelection {
	files: SelectedFile[];
	snippets: ContextSnippet[];
	bytes: number;
}

export interface ExploreResult {
	files: SelectedFile[];
	snippets: ContextSnippet[];
	/** Everything the governor dropped, stored and referenced before it was dropped. */
	droppedRefs: DroppedRef[];
	/** Ranked candidate tests for PRD-009's verifier selection — candidates only, no scope. */
	candidateTests: TestCandidate[];
	rounds: number;
	roundLog: RoundRecord[];
	/** The subsystem each round targeted, in order. */
	roundTargets: string[];
	subsystemOrder: { deterministic: string[]; chosen: string[] };
	filesRead: number;
	/** Every deterministic candidate the run produced; the naive path would read all of them. */
	unfilteredCandidateCount: number;
	bytes: number;
	stopReason: StopReason;
	decisions: SiteDecision[];
	degradations: Degradation[];
}

interface ResolvedAnswer {
	result: JevResult;
	source: "jev" | "fallback";
	reason: string;
}

interface SiteLedgerEntry {
	source: "jev" | "fallback";
	reason: string;
}

type ResolveSite = (siteId: ExplorationSiteId, questions: JevQuestion[], state: unknown) => Promise<Map<string, ResolvedAnswer>>;

/** The excerpt ceiling for one accepted file; the full bytes stay behind the ref. */
const EXCERPT_MAX_BYTES = 768;

/** The share of the remaining byte budget a deterministic sibling expansion may spend. */
const SIBLING_BUDGET_SHARE = 0.5;

function unique(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (value.length === 0 || seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

/** Two-segment subsystem roots: `packages/gamma/src/engine.ts` → `packages/gamma`. */
function collapsedRoot(path: string): string {
	const segments = path.split("/");
	if (segments.length <= 2) return ".";
	return segments.length > 3 ? segments.slice(0, 2).join("/") : segments.slice(0, -1).join("/");
}

/**
 * The deterministic breadth order: the packet's `likely_modules`, then the
 * changed files' directories, then the directories that actually matched the
 * objective, most matches first. Site 3 chooses only among these.
 */
export function enumerateSubsystems(input: {
	objective: string;
	search: SearchPort;
	likelyModules: readonly string[];
	changedFiles: readonly string[];
	settings: ExplorationSettings;
	symbolHits?: ReadonlyMap<string, number>;
}): string[] {
	const scan = gatherCandidates({
		objective: input.objective,
		root: ".",
		search: input.search,
		changedFiles: input.changedFiles,
		symbolHits: input.symbolHits,
		ignore: input.settings.ignore,
		maxCandidates: input.settings.maxCandidates,
		maxMatchesPerFile: input.settings.maxMatchesPerFile,
	});
	const counts = new Map<string, number>();
	for (const candidate of scan) {
		const root = collapsedRoot(candidate.path);
		counts.set(root, (counts.get(root) ?? 0) + candidate.matchCount);
	}
	const byMatches = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([root]) => root);
	const changedDirs = input.changedFiles.map((file) => file.split("/").slice(0, -1).join("/")).filter((dir) => dir.length > 0);
	const roots = unique([...input.likelyModules, ...changedDirs, ...byMatches]).filter((root) => root !== ".");
	return roots.length > 0 ? roots : ["."];
}

/** One exploration, bounded and reversible. */
export async function explore(request: ExploreRequest, deps: ExploreDeps): Promise<ExploreResult> {
	registerExplorationSites();
	const settings = explorationSettingsOf(deps.config, { ...deps.budget, ...deps.settings });
	const ledger = new BudgetLedger(settings);
	const jevEnabled = (deps.jevEnabled ?? true) && deps.config?.jev?.mode !== "disabled";

	const likelyModules = [...request.packet.workspace.likely_modules];
	const changedFiles = [...(request.changedFiles ?? request.packet.workspace.changed_files)];
	const symbolHits = symbolHitsOf(request, deps);
	const deterministicOrder =
		request.roots !== undefined && request.roots.length > 0
			? unique(request.roots)
			: enumerateSubsystems({ objective: request.objective, search: deps.search, likelyModules, changedFiles, settings, symbolHits });

	const decisions: SiteDecision[] = [];
	const siteLedger = new Map<ExplorationSiteId, SiteLedgerEntry>();
	const unreachedReason = deps.jev === undefined ? (jevEnabled ? "no-jev-client" : "jev-disabled") : jevEnabled ? "not-reached" : "jev-disabled";
	for (const site of EXPLORATION_SITE_IDS) {
		siteLedger.set(site, { source: "fallback", reason: unreachedReason });
	}
	const record = (site: ExplorationSiteId, answers: Map<string, ResolvedAnswer>): void => {
		if (answers.size === 0) return;
		for (const [questionId, answer] of answers) {
			decisions.push({ site, questionId, source: answer.source, value: answerValue(answer.result), reason: answer.reason });
		}
		const fellBack = [...answers.values()].find((answer) => answer.source === "fallback");
		siteLedger.set(site, fellBack ? { source: "fallback", reason: fellBack.reason } : { source: "jev", reason: "" });
	};

	const resolveSite: ResolveSite = async (siteId, questions, state) => {
		if (questions.length === 0) {
			if (siteLedger.get(siteId)?.reason === "not-reached") siteLedger.set(siteId, { source: "fallback", reason: "no-candidates" });
			return new Map();
		}
		const fallbackFor = (reason: string): Map<string, ResolvedAnswer> => {
			const results = siteFallbackAnswers(siteId, questions, state, reason);
			return new Map(questions.map((question, index) => [question.id, { result: results[index]!, source: "fallback" as const, reason }]));
		};
		if (!jevEnabled || deps.jev === undefined) return fallbackFor(jevEnabled ? "no-jev-client" : "jev-disabled");
		const consequence = getSite(siteId).consequence;
		const before = deps.jev.fallbackCount?.() ?? 0;
		let results: JevResult[];
		try {
			results = await deps.jev.ask(siteId, questions, state);
		} catch {
			return fallbackFor("ask-failed");
		}
		if ((deps.jev.fallbackCount?.() ?? 0) > before) return fallbackFor("client-fallback");

		const byId = new Map(results.map((result) => [result.questionId, result]));
		const answers = new Map<string, ResolvedAnswer>();
		for (const question of questions) {
			const result = byId.get(question.id);
			if (!result) {
				answers.set(question.id, { result: siteFallbackAnswers(siteId, [question], state, "no-answer")[0]!, source: "fallback", reason: "no-answer" });
				continue;
			}
			// §50 asymmetry is applied where the answer is used: an unconfident answer
			// is the fallback, and the fallback keeps what a confidant answer might drop.
			if (!accept(result, consequence)) {
				answers.set(question.id, { result: siteFallbackAnswers(siteId, [question], state, "below-threshold")[0]!, source: "fallback", reason: "below-threshold" });
				continue;
			}
			answers.set(question.id, { result, source: "jev", reason: "" });
		}
		// An answer to a question this site never asked is kept in the map so the
		// caller can see and log it; it never reaches a selection.
		const asked = new Set(questions.map((question) => question.id));
		for (const result of results) {
			if (asked.has(result.questionId)) continue;
			answers.set(result.questionId, { result, source: "fallback", reason: "malformed-path" });
		}
		return answers;
	};

	// Site 3 runs before the first gather: which subsystem is searched first.
	const subsystemAnswers = await resolveSite(EXPLORATION_SUBSYSTEM_SITE_ID, subsystemQuestions(request.objective, deterministicOrder), {
		objective: request.objective,
		roots: deterministicOrder,
		deterministicOrder,
	});
	record(EXPLORATION_SUBSYSTEM_SITE_ID, subsystemAnswers);
	let chosenOrder = deterministicOrder;
	const implicated = subsystemAnswers.get(SUBSYSTEM_IMPLICATED_QUESTION_ID)?.result;
	const rootAnswered = subsystemAnswers.get(SUBSYSTEM_ROOT_QUESTION_ID);
	const chosenRoot = rootAnswered?.result.kind === "Choice" ? rootAnswered.result.choice : undefined;
	if (
		subsystemAnswers.get(SUBSYSTEM_IMPLICATED_QUESTION_ID)?.source === "jev" &&
		implicated?.kind === "Noul" &&
		implicated.value >= 0.5 &&
		chosenRoot !== undefined &&
		deterministicOrder.includes(chosenRoot)
	) {
		chosenOrder = [chosenRoot, ...deterministicOrder.filter((entry) => entry !== chosenRoot)];
	}

	const files: SelectedFile[] = [];
	const snippets: ContextSnippet[] = [];
	const droppedRefs: DroppedRef[] = [];
	const acceptedPaths = new Set<string>();
	const candidatePaths = new Set<string>();
	const candidateFacts = new Map<string, Candidate>();
	const roundLog: RoundRecord[] = [];
	const roundTargets: string[] = [];
	let stopReason: StopReason = "no_new_file";
	// True only while the loop is still running: the rounds ceiling, not a break,
	// is what ended it, and an exhausted round budget is a budget outcome.
	let endedOnRounds = true;

	while (ledger.roundsRemaining() > 0) {
		const round = ledger.startRound();
		const subsystem = chosenOrder[(round - 1) % chosenOrder.length]!;
		roundTargets.push(subsystem);

		const candidates = gatherCandidates({
			objective: request.objective,
			root: subsystem,
			search: deps.search,
			changedFiles,
			symbolHits,
			ignore: settings.ignore,
			maxCandidates: settings.maxCandidates,
			maxMatchesPerFile: settings.maxMatchesPerFile,
		});
		for (const candidate of candidates) {
			candidatePaths.add(candidate.path);
			candidateFacts.set(candidate.path, candidate);
		}
		const fresh = candidates.filter((candidate) => !acceptedPaths.has(candidate.path));

		// An empty root is the wrong root, not evidence that exploration is done.
		if (fresh.length === 0) {
			roundLog.push({ round, subsystem, candidates: candidates.length, accepted: 0, added: 0, siblingFiles: 0, bytes: ledger.bytes });
			continue;
		}

		const ranked = rankCandidates(fresh, { likelyModules, changedFiles });
		const candidateQuestions_ = candidateQuestions(request.objective, fresh);
		const candidateAnswers = await resolveSite(EXPLORATION_CANDIDATE_SITE_ID, candidateQuestions_, {
			objective: request.objective,
			threshold: settings.snippetScoreThreshold,
			candidates: ranked.map((entry) => ({ path: entry.candidate.path, deterministicScore: entry.deterministicScore })),
		});
		record(EXPLORATION_CANDIDATE_SITE_ID, candidateAnswers);
		const jevScores = new Map<string, number>();
		for (const [questionId, answer] of candidateAnswers) {
			if (answer.source === "jev" && answer.result.kind === "Score") jevScores.set(questionId.slice("candidate:".length), levelToScore(answer.result.score));
		}
		const overlaid = overlayScores(ranked, jevScores);
		// Anything the ranking returned for a path outside the deterministic set is
		// discarded and logged: it is not in the candidate list, so it cannot be read.
		const askedIds = new Set(candidateQuestions_.map((question) => question.id));
		const malformed = unique([
			...[...candidateAnswers.keys()].filter((questionId) => !askedIds.has(questionId)),
			...overlaid.malformed.map((path) => candidateQuestionId(path)),
		]);
		for (const questionId of malformed) {
			decisions.push({ site: EXPLORATION_CANDIDATE_SITE_ID, questionId, source: "fallback", value: null, reason: "malformed-path" });
		}

		const gated = gateSelection(
			overlaid.ranked.map((entry) => ({ entry, contextBytes: Math.min(entry.candidate.bytes, EXCERPT_MAX_BYTES) + 96 })),
			ledger,
		);
		const added: SelectedFile[] = [];
		const roundSnippets: Snippet[] = [];
		for (const { entry } of gated) {
			const file = readSelectedFile(entry, deps, ledger);
			if (!file) break;
			files.push(file);
			acceptedPaths.add(file.path);
			added.push(file);
			roundSnippets.push(buildSnippet({ path: file.path, lines: entry.candidate.matchedLines }, entry.score));
		}

		// Site 4: per-snippet keep/drop, before anything enters context. A drop is
		// stored first, so reversing the decision costs one expansion.
		if (roundSnippets.length > 0) {
			const snippetAnswers = await resolveSite(EXPLORATION_SNIPPET_SITE_ID, snippetQuestions(roundSnippets), {
				objective: request.objective,
				threshold: settings.snippetScoreThreshold,
				snippets: roundSnippets.map((snippet) => ({ id: snippet.id, path: snippet.path, fileScore: snippet.fileScore, bytes: snippet.bytes })),
			});
			record(EXPLORATION_SNIPPET_SITE_ID, snippetAnswers);
			for (const questionId of [...snippetAnswers.keys()].filter((id) => !roundSnippets.some((snippet) => snippet.id === id))) {
				decisions.push({ site: EXPLORATION_SNIPPET_SITE_ID, questionId, source: "fallback", value: null, reason: "malformed-path" });
			}
			for (const snippet of roundSnippets) {
				const answer = snippetAnswers.get(snippet.id);
				const verdict = answer?.result.kind === "Choice" ? answer.result.choice : snippetVerdict(snippet.fileScore, settings.snippetScoreThreshold);
				if (verdict === "DROP") {
					droppedRefs.push(storeDrop(deps.artifacts, snippet, "snippet", "site4-drop"));
					continue;
				}
				const artifact = deps.artifacts.store(snippet.text, "explore-snippet", snippet.sourceRef);
				const { head, tail } = capSnippet(snippet.text, settings.snippetBytesPerFile);
				if (tail.length > 0) droppedRefs.push(storeDrop(deps.artifacts, { ...snippet, text: tail }, "snippet-overflow", "byte-cap"));
				const refLine = `\n[full block: ${artifact}]`;
				const contextBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(refLine, "utf8");
				if (head.length === 0 || contextBytes > ledger.remainingBytes()) {
					droppedRefs.push(storeDrop(deps.artifacts, snippet, "snippet", "budget-gate"));
					continue;
				}
				snippets.push({
					id: snippet.id,
					path: snippet.path,
					text: `${head}${refLine}`,
					contextBytes,
					artifact,
					sourceRef: snippet.sourceRef,
					score: snippet.fileScore,
					source: answer?.source ?? "fallback",
				});
				ledger.chargeBytes(contextBytes);
			}
		}

		// Site 5: sibling expansion, still subject to the byte budget.
		const siblingFiles = await expandSiblings(added, {
			deps,
			settings,
			ledger,
			objective: request.objective,
			files,
			acceptedPaths,
			resolveSite,
			record,
		});
		const addedThisRound = added.length + siblingFiles.length;
		roundLog.push({ round, subsystem, candidates: candidates.length, accepted: added.length, added: addedThisRound, siblingFiles: siblingFiles.length, bytes: ledger.bytes });

		// The budget gate is authoritative: checked before any semantic answer, so an
		// exhausted ceiling terminates the loop regardless of what JEV said. A gate
		// that admitted none of this round's fresh candidates is the same fact.
		if (ledger.exhausted() || (fresh.length > 0 && gated.length === 0)) {
			stopReason = "budget_exhausted";
			endedOnRounds = false;
			break;
		}
		const sufficient = await resolveSite(EXPLORATION_SUFFICIENCY_SITE_ID, sufficiencyQuestions(request.objective), {
			objective: request.objective,
			acceptedFiles: files.map((file) => file.path),
			resolvedSymbols: resolvedSymbolsOf(files, candidateFacts),
			openQuestions: openQuestionsOf(request.objective, files, candidateFacts),
			rounds: ledger.rounds,
			maxRounds: settings.maxRounds,
			addedThisRound,
		});
		record(EXPLORATION_SUFFICIENCY_SITE_ID, sufficient);
		const stop = sufficient.get(SUFFICIENCY_QUESTION_ID);
		if (stop?.result.kind === "Choice" && stop.result.choice === "ENOUGH_EVIDENCE") {
			stopReason = "enough_evidence";
			endedOnRounds = false;
			break;
		}
		if (addedThisRound === 0) {
			stopReason = "no_new_file";
			endedOnRounds = false;
			break;
		}
	}
	if (endedOnRounds && ledger.filesRead > 0) stopReason = "budget_exhausted";

	// Site 6: a ranked candidate test set for PRD-009. Candidates only — no scope,
	// no expected pass/fail, no verification claim.
	const testInput = {
		discovered: discoverTests({
			search: deps.search,
			roots: ["."],
			runners: request.packet.workspace.test_runners,
			fallbackGlobs: settings.testGlobs,
			maxTests: settings.maxTests,
		}),
		acceptedFiles: files.map((file) => file.path),
		declaredRunners: request.packet.workspace.test_runners,
		readContent: (path: string) => {
			try {
				return deps.search.read(path);
			} catch {
				return "";
			}
		},
	};
	const rankedTests = rankTests(testInput);
	const testAnswers = await resolveSite(EXPLORATION_TEST_SITE_ID, testQuestions(request.objective, rankedTests), {
		objective: request.objective,
		acceptedFiles: testInput.acceptedFiles,
		tests: rankedTests.map((test) => ({ path: test.path, deterministicScore: test.deterministicScore })),
	});
	record(EXPLORATION_TEST_SITE_ID, testAnswers);
	const testScores = new Map<string, number>();
	for (const [questionId, answer] of testAnswers) {
		if (answer.source === "jev" && answer.result.kind === "Score") testScores.set(questionId.slice("test:".length), levelToScore(answer.result.score));
	}
	const scoredTests = overlayTestScores(rankedTests, testScores);
	for (const questionId of [...testAnswers.keys()].filter((id) => !rankedTests.some((test) => testQuestionId(test.path) === id))) {
		decisions.push({ site: EXPLORATION_TEST_SITE_ID, questionId, source: "fallback", value: null, reason: "malformed-path" });
	}

	const degradations: Degradation[] = EXPLORATION_SITE_IDS.filter((site) => siteLedger.get(site)?.source === "fallback").map((site) => ({
		site,
		fallback: EXPLORATION_FALLBACK_NAMES[site],
		reason: siteLedger.get(site)?.reason ?? "jev-disabled",
	}));

	const selection: ContextSelection = { files, snippets, bytes: ledger.bytes };
	deps.writeContext?.(selection);

	return {
		files,
		snippets,
		droppedRefs,
		candidateTests: scoredTests.candidates,
		rounds: ledger.rounds,
		roundLog,
		roundTargets,
		subsystemOrder: { deterministic: deterministicOrder, chosen: chosenOrder },
		filesRead: ledger.filesRead,
		unfilteredCandidateCount: candidatePaths.size,
		bytes: ledger.bytes,
		stopReason,
		decisions,
		degradations,
	};
}

/**
 * PRD-018's symbol queries, when the packet reports a server: a port failure is
 * absorbed here, because losing symbol evidence must not lose the exploration.
 */
function symbolHitsOf(request: ExploreRequest, deps: ExploreDeps): ReadonlyMap<string, number> | undefined {
	if (!request.packet.workspace.lsp_available || deps.symbols === undefined) return undefined;
	try {
		const hits = deps.symbols(objectiveTerms(request.objective));
		return new Map(hits.filter((hit) => hit.count > 0).map((hit) => [hit.path, hit.count]));
	} catch {
		return undefined;
	}
}

function storeDrop(artifacts: ArtifactStore, snippet: Snippet, kind: DroppedRef["kind"], reason: string): DroppedRef {
	const ref = artifacts.store(snippet.text, "explore-snippet", snippet.sourceRef);
	return { ref, path: snippet.path, sourceRef: snippet.sourceRef, bytes: Buffer.byteLength(snippet.text, "utf8"), kind, reason };
}

/** Read one accepted candidate: store the full bytes, hand the excerpt, charge the budget. */
function readSelectedFile(entry: RankedCandidate, deps: ExploreDeps, ledger: BudgetLedger): SelectedFile | undefined {
	let content: string;
	try {
		content = deps.search.read(entry.candidate.path);
	} catch {
		return undefined;
	}
	const artifact = deps.artifacts.store(content, "explore-file", entry.candidate.path);
	const excerpt = buildExcerpt(content, { maxBytes: EXCERPT_MAX_BYTES });
	const refLine = `[full file: ${artifact}]`;
	const contextBytes = Buffer.byteLength(excerpt, "utf8") + Buffer.byteLength(refLine, "utf8");
	if (contextBytes > ledger.remainingBytes()) return undefined;
	ledger.chargeFile(contextBytes);
	return {
		path: entry.candidate.path,
		language: entry.candidate.language,
		bytes: entry.candidate.bytes,
		contextBytes,
		score: entry.score,
		matchCount: entry.candidate.matchCount,
		symbolHits: entry.candidate.symbolHits,
		excerpt: `${excerpt}\n${refLine}`,
		artifact,
		source: entry.source,
	};
}

interface SiblingContext {
	deps: ExploreDeps;
	settings: ExplorationSettings;
	ledger: BudgetLedger;
	objective: string;
	files: SelectedFile[];
	acceptedPaths: Set<string>;
	resolveSite: ResolveSite;
	record: (site: ExplorationSiteId, answers: Map<string, ResolvedAnswer>) => void;
}

/** The same-basename test/type siblings of a file, plus its callers, all bounded. */
function siblingCandidatesOf(file: SelectedFile, context: SiblingContext): SiblingCandidate[] {
	const segments = file.path.split("/");
	const base = (segments.pop() ?? file.path).replace(/\.[A-Za-z0-9]+$/, "");
	const dir = segments.length > 0 ? `${segments.join("/")}/` : "";
	const extension = /\.[A-Za-z0-9]+$/.exec(file.path)?.[0] ?? ".ts";
	const candidates: SiblingCandidate[] = [];
	const push = (siblingClass: SiblingClass, paths: string[]): void => {
		const existing = unique(paths.filter((path) => context.deps.search.size(path) > 0 && !context.acceptedPaths.has(path)));
		candidates.push({
			id: siblingQuestionId(file.path, siblingClass),
			file: file.path,
			class: siblingClass,
			paths: existing,
			bytes: existing.reduce((total, path) => total + Math.min(context.deps.search.size(path), EXCERPT_MAX_BYTES), 0),
		});
	};
	push("test", [`${dir}${base}.test${extension}`, `${dir}${base}.spec${extension}`, `${dir}__tests__/${base}.test${extension}`]);
	push("type", extension === ".ts" ? [`${dir}${base}.d.ts`] : []);
	// ponytail: callers are found by grepping the file's basename, capped at eight
	// hits; PRD-018's references query is the precise replacement when a server is up.
	const callers =
		base.length > 2
			? context.deps.search
					.grep({
						pattern: `\\b${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
						root: ".",
						ignore: context.settings.ignore,
						maxFiles: 8,
						maxMatchesPerFile: 2,
					})
					.map((hit) => hit.path)
					.filter((path) => path !== file.path)
			: [];
	push("caller", callers);
	return candidates;
}

/** Site 5's round: ask per sibling class, then read what it answered to expand. */
async function expandSiblings(newlyAccepted: readonly SelectedFile[], context: SiblingContext): Promise<SelectedFile[]> {
	if (newlyAccepted.length === 0) return [];
	const siblings = newlyAccepted.flatMap((file) => siblingCandidatesOf(file, context));
	const answered = await context.resolveSite(EXPLORATION_SIBLING_SITE_ID, siblingQuestions(context.objective, siblings), {
		objective: context.objective,
		remainingBytes: context.ledger.remainingBytes(),
		shareOfBudget: SIBLING_BUDGET_SHARE,
		siblings,
	});
	context.record(EXPLORATION_SIBLING_SITE_ID, answered);
	const read: SelectedFile[] = [];
	for (const sibling of siblings) {
		if (context.ledger.remainingFiles() === 0) break;
		const answer = answered.get(sibling.id);
		const verdict = answer?.result.kind === "Choice" ? answer.result.choice : siblingVerdict(sibling, context.ledger.remainingBytes(), SIBLING_BUDGET_SHARE);
		if (verdict !== "EXPAND") continue;
		for (const path of sibling.paths) {
			if (context.acceptedPaths.has(path) || context.ledger.remainingFiles() === 0) continue;
			let content: string;
			try {
				content = context.deps.search.read(path);
			} catch {
				continue;
			}
			const artifact = context.deps.artifacts.store(content, "explore-file", path);
			const excerpt = buildExcerpt(content, { maxBytes: EXCERPT_MAX_BYTES });
			const refLine = `[full file: ${artifact}]`;
			const contextBytes = Buffer.byteLength(excerpt, "utf8") + Buffer.byteLength(refLine, "utf8");
			if (contextBytes > context.ledger.remainingBytes()) continue;
			context.ledger.chargeFile(contextBytes);
			context.acceptedPaths.add(path);
			const selected: SelectedFile = {
				path,
				language: candidateLanguage(path) ?? "other",
				bytes: context.deps.search.size(path),
				contextBytes,
				score: 1,
				matchCount: 0,
				symbolHits: 0,
				excerpt: `${excerpt}\n${refLine}`,
				artifact,
				source: answer?.source ?? "fallback",
				siblingOf: sibling.file,
				siblingClass: sibling.class,
			};
			context.files.push(selected);
			read.push(selected);
		}
	}
	return read;
}

/** Declaration-shaped identifiers in the accepted files' matched lines — the evidence summary. */
function resolvedSymbolsOf(files: readonly SelectedFile[], candidateFacts: ReadonlyMap<string, Candidate>): string[] {
	const symbols: string[] = [];
	for (const file of files) {
		for (const line of candidateFacts.get(file.path)?.matchedLines ?? []) {
			const match = /(?:function|class|interface|type|const|let|var|def|fn|struct|impl)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line.text);
			if (match) symbols.push(match[1]!);
		}
	}
	return unique(symbols).slice(0, 8);
}

/** Objective terms no accepted evidence mentions — the compact "still unanswered" summary. */
function openQuestionsOf(objective: string, files: readonly SelectedFile[], candidateFacts: ReadonlyMap<string, Candidate>): string[] {
	const terms = unique(objective.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []);
	const haystack = files
		.flatMap((file) => [file.path, ...(candidateFacts.get(file.path)?.matchedLines ?? []).map((line) => line.text)])
		.join(" ")
		.toLowerCase();
	return terms.filter((term) => !haystack.includes(term)).slice(0, 5);
}

/** The programmatic path: `session.explore(request)` returns the same `ExploreResult`. */
export interface ExplorationSession {
	explore(request: ExploreRequest): Promise<ExploreResult>;
}

export function createExplorationSession(deps: ExploreDeps): ExplorationSession {
	return { explore: (request) => explore(request, deps) };
}
