/**
 * PRD-023 spec fixtures: real git repositories, a real artifact store, and the
 * real JEV client pointed at a stub endpoint.
 *
 * The exploration runs through `createExplorationSession()` — the same entry
 * point `session.explore(request)` is wired to — so the specs assert the path a
 * session takes, not a test-only one.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactStore } from "../../src/context/artifacts.js";
import type { LeanPiConfig, JevMode } from "../../src/core/types.js";
import type { JevClient } from "../../src/jev/client.js";
import type { JevQuestion, JevResult } from "../../src/jev/types.js";
import { createArtifactStore } from "../../src/context/artifacts.js";
import {
	createExplorationSession,
	createFileSearch,
	type ContextSelection,
	type ExploreResult,
	type ExplorationSession,
	type SearchPort,
} from "../../src/exploration/index.js";
import { createJevClient } from "../../src/jev/client.js";
import { loadConfig } from "../../src/core/config.js";
import { scoutTask, type TaskPacket } from "../../src/scout/index.js";
import { gitCommitAll, gitInit, tempDir } from "../helpers/fixtures.js";
import { startStubJev, type StubJev, type StubJevResponder } from "../helpers/stub-jev.js";

export function write(cwd: string, path: string, content: string): void {
	mkdirSync(dirname(join(cwd, path)), { recursive: true });
	writeFileSync(join(cwd, path), content);
}

/** Lines of filler so a fixture file is large enough for the byte budget to bite. */
function filler(seed: string, lines = 24): string {
	return Array.from({ length: lines }, (_, index) => `// ${seed} padding line ${index} ${"x".repeat(40)}`).join("\n");
}

function packageJson(name: string): string {
	return `${JSON.stringify({ name, private: true, type: "module", devDependencies: { typescript: "^5.9.0", vitest: "^3.0.0" } }, null, 2)}\n`;
}

export interface Fixture {
	cwd: string;
	objective: string;
	/** The declared answer set: a selection missing any of these is a wrong selection. */
	groundTruth: string[];
}

/** A repository where two files obviously bear on the objective and six barely mention it. */
export function groundTruthFixture(): Fixture {
	const cwd = tempDir("leanpi-explore-truth-");
	gitInit(cwd);
	write(cwd, "package.json", packageJson("explore-truth"));
	write(
		cwd,
		"src/game/torpedo.ts",
		[
			"export interface Torpedo { readonly selection: number; }",
			"// the torpedo selection crash: the selection index runs past the tube array",
			"export function selectTorpedo(selection: number): Torpedo | null {",
			"  // a crash here means the selection was never validated",
			"  const torpedo = selection >= 0 ? { selection } : null;",
			"  // torpedo selection: crash when the selection is out of range",
			"  return torpedo;",
			"}",
		].join("\n"),
	);
	write(
		cwd,
		"src/game/torpedo-selection.ts",
		[
			"// torpedo selection: the selection panel that crashes on an empty tube set",
			"export const SELECTION_LIMIT = 4;",
			"export function selectionLabel(selection: number): string {",
			"  // crash when the selection is negative",
			"  return `torpedo ${selection}`;",
			"}",
			"// torpedo selection crash regression guard",
			"export function selectionValid(selection: number): boolean {",
			"  return selection >= 0 && selection < SELECTION_LIMIT;",
			"}",
		].join("\n"),
	);
	// Six incidental matches in the same subsystem: enough candidates that the
	// governed read count has to be strictly lower than reading them all.
	for (const [index, name] of ["tube", "sonar", "weapons", "bearing", "salvo", "wake"].entries()) {
		write(
			cwd,
			`src/game/${name}.ts`,
			[
				`// ${name} module`,
				index % 2 === 0 ? "// mentions torpedo in passing" : "// mentions selection in passing",
				`export const ${name.toUpperCase()}_VERSION = ${index};`,
			].join("\n"),
		);
	}
	write(cwd, "src/ui/torpedo-icon.ts", "// torpedo icon\n// selection highlight\nexport const ICON = 1;\n");
	write(cwd, "packages/legacy/torpedo-legacy.ts", "// legacy torpedo\n// legacy selection\nexport const LEGACY = true;\n");
	write(cwd, "docs/torpedo.md", "# torpedo selection crash\n\nThe docs mention the torpedo selection crash.\n");
	write(cwd, "src/net/socket.ts", "export const socket = 1;\n");
	gitCommitAll(cwd);
	// The two ground-truth files are the change under exploration.
	write(cwd, "src/game/torpedo.ts", `// torpedo selection crash: fix\n${Array.from({ length: 4 }, (_, i) => `// torpedo selection crash note ${i}`).join("\n")}\nexport function selectTorpedo(selection: number) {\n  return selection;\n}\n`);
	write(cwd, "src/game/torpedo-selection.ts", `// torpedo selection crash: fix\n${Array.from({ length: 3 }, (_, i) => `// torpedo selection crash note ${i}`).join("\n")}\nexport const SELECTION_LIMIT = 4;\n`);
	return { cwd, objective: "fix torpedo selection crash", groundTruth: ["src/game/torpedo.ts", "src/game/torpedo-selection.ts"] };
}

/** A repository whose matches keep appearing in every round: the naive path never converges. */
export function loopFixture(): Fixture {
	const cwd = tempDir("leanpi-explore-loop-");
	gitInit(cwd);
	write(cwd, "package.json", packageJson("explore-loop"));
	for (const phase of ["phase0", "phase1", "phase2", "phase3"]) {
		for (const name of ["alpha", "beta", "gamma"]) {
			write(
				cwd,
				`src/loop/${phase}/${name}.ts`,
				[
					`// ${phase}/${name} torpedo selection path`,
					"// torpedo selection crash report",
					filler(`${phase}-${name}`),
					`export const ${name.toUpperCase()}_PHASE = "${phase}";`,
				].join("\n"),
			);
		}
	}
	gitCommitAll(cwd);
	write(cwd, "src/loop/phase0/alpha.ts", `// torpedo selection crash: the fix\n${filler("ground-truth", 30)}\nexport function selectTorpedo(selection: number): number {\n  return selection;\n}\n`);
	return { cwd, objective: "fix torpedo selection crash", groundTruth: ["src/loop/phase0/alpha.ts"] };
}

/** Three subsystems; the ground truth lives in the one the breadth order reaches last. */
export function multiSubsystemFixture(): Fixture {
	const cwd = tempDir("leanpi-explore-multi-");
	gitInit(cwd);
	write(cwd, "package.json", packageJson("explore-multi"));
	write(cwd, "packages/alpha/src/alpha.ts", "export const alpha = 1;\n");
	write(cwd, "packages/beta/src/beta.ts", "export const beta = 1;\n");
	write(
		cwd,
		"packages/gamma/src/engine.ts",
		[
			"// the torpedo selection crash is in this engine",
			"export function run(selection: number): number {",
			"  // torpedo selection crash when the tube is empty",
			"  return selection;",
			"}",
		].join("\n"),
	);
	// The test sibling does not mention the objective terms, so it is never a candidate.
	write(
		cwd,
		"packages/gamma/src/engine.test.ts",
		['import { run } from "./engine.js";', "", 'describe("engine", () => {', "\t// exercises the engine helper", "\texport const check = run(1);", "});"].join("\n"),
	);
	gitCommitAll(cwd);
	write(cwd, "packages/alpha/src/alpha.ts", "export const alpha = 2;\n");
	write(cwd, "packages/beta/src/beta.ts", "export const beta = 2;\n");
	return { cwd, objective: "fix torpedo selection crash", groundTruth: ["packages/gamma/src/engine.ts"] };
}

/** One test that exercises the change and one unrelated test sharing an identifier. */
export function testRelevanceFixture(): Fixture {
	const cwd = tempDir("leanpi-explore-tests-");
	gitInit(cwd);
	write(cwd, "package.json", packageJson("explore-tests"));
	write(
		cwd,
		"src/game/torpedo.ts",
		["// torpedo selection crash", "export function selectTorpedo(selection: number): number {", "  return selection;", "}"].join("\n"),
	);
	write(
		cwd,
		"src/game/torpedo.test.ts",
		['import { selectTorpedo } from "./torpedo.js";', "", 'describe("torpedo", () => {', "\tit(\"selects a torpedo\", () => {", "\t\tselectTorpedo(1);", "\t});", "});"].join("\n"),
	);
	write(
		cwd,
		"packages/legacy/tests/legacy-torpedo.spec.ts",
		["// the legacy helper: named after the feature, unrelated to the change", "export const legacyHelper = 1;", 'describe("legacy helper", () => {});'].join("\n"),
	);
	gitCommitAll(cwd);
	write(cwd, "src/game/torpedo.ts", ["// torpedo selection crash: fix", "export function selectTorpedo(selection: number): number {", "  return Math.max(selection, 0);", "}"].join("\n"));
	return { cwd, objective: "fix torpedo selection crash", groundTruth: ["src/game/torpedo.ts"] };
}

export interface ExploreHarness {
	cwd: string;
	config: LeanPiConfig;
	client: JevClient;
	stub: StubJev;
	artifacts: ArtifactStore;
	search: SearchPort;
	session: ExplorationSession;
	/** `ask()` calls that reached the client, whatever the client then did. */
	asks(): number;
	/** Every path the governor read, in order. */
	reads(): string[];
	/** The excerpts and refs the governor handed to PRD-014's working state, if any. */
	selection(): ContextSelection | undefined;
	packet: TaskPacket;
	run(overrides?: { budget?: Record<string, number>; settings?: Record<string, unknown>; changedFiles?: string[]; roots?: string[]; objective?: string }): Promise<ExploreResult>;
	close(): Promise<void>;
}

export interface HarnessOptions {
	cwd: string;
	objective: string;
	responders?: StubJevResponder[];
	mode?: JevMode;
	/** Replaces the client entirely, e.g. to model a malformed answer. */
	client?: JevClient;
	/** Stands in for PRD-018's LSP symbol queries. */
	symbols?: (terms: readonly string[]) => Array<{ path: string; count: number }>;
	/** Omits the JEV client entirely: JEV enabled by configuration, not constructed. */
	noClient?: boolean;
}

/** A real JEV client against a stub endpoint, a real artifact store, real git facts. */
export async function harness(options: HarnessOptions): Promise<ExploreHarness> {
	const stub = await startStubJev(options.responders);
	const config = loadConfig(options.cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { quick: { backend: "local", model: "m" } },
		jev: { endpoint: stub.url, apiKey: "test-key", model: "jev-latest", mode: options.mode ?? "enabled" },
	});
	const inner = options.client ?? createJevClient({ config, cwd: options.cwd });
	let asks = 0;
	const client: JevClient = {
		...inner,
		ask: (siteId, questions, state) => {
			asks += 1;
			return inner.ask(siteId, questions, state);
		},
	};
	const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-explore-artifacts-") });
	const fileSearch = createFileSearch({ cwd: options.cwd });
	const readPaths: string[] = [];
	const search: SearchPort = {
		...fileSearch,
		read: (path) => {
			readPaths.push(path);
			return fileSearch.read(path);
		},
	};
	const packet = scoutTask(options.cwd, options.objective);
	let selection: ContextSelection | undefined;
	const deps = {
		search,
		artifacts,
		...(options.noClient ? {} : { jev: client }),
		config,
		...(options.symbols ? { symbols: options.symbols } : {}),
		writeContext: (written: ContextSelection) => (selection = written),
	};
	const session = createExplorationSession(deps);
	const explore = (overrides: { budget?: Record<string, number>; settings?: Record<string, unknown>; changedFiles?: string[]; roots?: string[]; objective?: string } = {}): Promise<ExploreResult> => {
		selection = undefined;
		return createExplorationSession({ ...deps, ...(overrides.budget ? { budget: overrides.budget } : {}), ...(overrides.settings ? { settings: overrides.settings } : {}) }).explore({
			objective: overrides.objective ?? options.objective,
			packet,
			...(overrides.changedFiles ? { changedFiles: overrides.changedFiles } : {}),
			...(overrides.roots ? { roots: overrides.roots } : {}),
		});
	};
	return {
		cwd: options.cwd,
		config,
		client,
		stub,
		artifacts,
		search,
		session,
		packet,
		asks: () => asks,
		reads: () => [...readPaths],
		selection: () => selection,
		run: explore,
		close: async () => {
			await stub.close();
		},
	};
}

/** Answers every candidate Score with the same level and every Choice with the first option. */
export function scoreEveryone(level: number, confidence = 0.95): StubJevResponder {
	return (body) => {
		const questions = (body.questions ?? {}) as Record<string, { type?: string; criteria?: Record<string, string> }>;
		const answers: Record<string, unknown> = {};
		for (const [id, question] of Object.entries(questions)) {
			if (question.type === "score") {
				answers[id] = { type: "score", score: level, legend: {}, confidence };
				continue;
			}
			if (question.type === "choice") {
				const choice = Object.keys(question.criteria ?? {})[0] ?? "none";
				answers[id] = { type: "choice", choice, probabilities: { [choice]: confidence }, confidence };
				continue;
			}
			answers[id] = { type: "noul", noul: 0.5 };
		}
		return { answers };
	};
}

/** The worst case for the ceiling: maximum score, KEEP every snippet, EXPAND every sibling, NEED_MORE always. */
export function adversarialResponder(): StubJevResponder {
	return (body) => {
		const questions = (body.questions ?? {}) as Record<string, { type?: string; criteria?: Record<string, string> }>;
		const answers: Record<string, unknown> = {};
		for (const [id, question] of Object.entries(questions)) {
			if (question.type === "score") {
				answers[id] = { type: "score", score: 3, legend: {}, confidence: 0.99 };
				continue;
			}
			if (question.type === "choice") {
				const options = Object.keys(question.criteria ?? {});
				const choice = options.find((option) => option === "NEED_MORE") ?? options.find((option) => option === "KEEP") ?? options.find((option) => option === "EXPAND") ?? options[0] ?? "none";
				answers[id] = { type: "choice", choice, probabilities: { [choice]: 0.99 }, confidence: 0.99 };
				continue;
			}
			answers[id] = { type: "noul", noul: 0.5 };
		}
		return { answers };
	};
}

/** A JEV client with no socket behind it, for answers the wire shape cannot express. */
export function scriptedClient(script: (siteId: string, questions: JevQuestion[], state: unknown) => JevResult[]): JevClient {
	return {
		ask: async (siteId: string, questions: JevQuestion[], state: unknown) => script(siteId, questions, state),
		fallbackCount: () => 0,
		lastUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
		getMode: () => "enabled",
	} as unknown as JevClient;
}

/** Answer every question from one spec: the score, the choice when it is an option, else the first option. */
export function answersOf(questions: readonly JevQuestion[], spec: { score: number; choice: string; confidence?: number }): JevResult[] {
	const confidence = spec.confidence ?? 0.95;
	return questions.map((question): JevResult => {
		if (question.kind === "Score") return { kind: "Score", questionId: question.id, score: spec.score, legend: {}, confidence };
		if (question.kind === "Choice") {
			const options = Object.keys(question.options);
			const choice = options.includes(spec.choice) ? spec.choice : options[0]!;
			return { kind: "Choice", questionId: question.id, choice, probabilities: {}, confidence };
		}
		return { kind: "Noul", questionId: question.id, value: 0.5, confidence: 0 };
	});
}
