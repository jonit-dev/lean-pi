/**
 * Test relevance (PRD-023 Phase 4, AC-6).
 *
 * This module produces a ranked candidate list and stops there: no regression
 * scope, no expected pass/fail, no verification claim. PRD-009's verifier
 * selection consumes `candidateTests` and owns what actually runs, so nothing
 * here may look like a correctness statement.
 *
 * Discovery is deterministic and path-based — a test qualifies by path or
 * basename overlap with an accepted file, plus ownership by a runner the scout
 * packet declared — so an unrelated test that merely mentions the same
 * identifier never becomes a candidate and JEV cannot promote it into one.
 */
import type { SearchPort } from "./gather.js";

export interface DiscoveredTest {
	path: string;
	/** The runners whose globs matched this path, in declared order. */
	runners: string[];
}

export interface TestCandidate {
	path: string;
	score: number;
	deterministicScore: number;
	source: "jev" | "fallback";
	runners: string[];
}

/** Per-runner test globs; a runner the module does not know contributes nothing. */
const RUNNER_GLOBS: Record<string, readonly string[]> = {
	vitest: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "**/*.test.js", "**/*.spec.js"],
	jest: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "**/*.test.js", "**/*.spec.js"],
	mocha: ["**/*.test.js", "**/*.spec.js", "**/*.test.ts"],
	ava: ["**/*.test.js", "**/*.test.ts"],
	pytest: ["**/test_*.py", "**/*_test.py"],
	unittest: ["**/test_*.py"],
	cargo: ["**/tests/*.rs"],
	go: ["**/*_test.go"],
	gotest: ["**/*_test.go"],
	rspec: ["**/*_spec.rb"],
	phpunit: ["**/*Test.php"],
};

export function testQuestionId(path: string): string {
	return `test:${path}`;
}

/** The test globs the packet's runners own, paired with their runner; repository globs when none is known. */
export function runnerGlobPairs(runners: readonly string[], fallback: readonly string[]): Array<{ runner: string | null; glob: string }> {
	const pairs: Array<{ runner: string | null; glob: string }> = [];
	for (const runner of runners) {
		for (const glob of RUNNER_GLOBS[runner.toLowerCase()] ?? []) {
			if (!pairs.some((pair) => pair.runner === runner.toLowerCase() && pair.glob === glob)) pairs.push({ runner: runner.toLowerCase(), glob });
		}
	}
	return pairs.length > 0 ? pairs : fallback.map((glob) => ({ runner: null, glob }));
}

export interface DiscoverTestsInput {
	search: SearchPort;
	roots: readonly string[];
	runners: readonly string[];
	fallbackGlobs: readonly string[];
	maxTests: number;
}

/**
 * Deterministic test discovery: each glob the runners own matches through the
 * search port, and the glob's runner is the file's runner — the glob *is* the
 * ownership evidence, so nothing here re-implements matching.
 */
export function discoverTests(input: DiscoverTestsInput): DiscoveredTest[] {
	const pairs = runnerGlobPairs(input.runners, input.fallbackGlobs);
	const found = new Map<string, DiscoveredTest>();
	for (const pair of pairs) {
		for (const root of input.roots) {
			for (const path of input.search.glob({ pattern: pair.glob, root, maxFiles: input.maxTests })) {
				const existing = found.get(path);
				if (existing) {
					if (pair.runner !== null && !existing.runners.includes(pair.runner)) existing.runners.push(pair.runner);
					continue;
				}
				found.set(path, { path, runners: pair.runner === null ? [] : [pair.runner] });
				if (found.size >= input.maxTests) return [...found.values()].sort((left, right) => left.path.localeCompare(right.path));
			}
		}
	}
	return [...found.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/** `foo.test.ts` → `foo`; `test_foo.py` → `foo`; `bar_test.go` → `bar`. */
export function testStem(path: string): string {
	const base = path.split("/").pop() ?? path;
	const stem = base.replace(/\.[A-Za-z0-9]+$/, "");
	return stem.replace(/\.(test|spec)$/, "").replace(/^test_/, "").replace(/_test$/, "");
}

function moduleStem(path: string): string {
	return (path.split("/").pop() ?? path).replace(/\.[A-Za-z0-9]+$/, "");
}

function directoryOf(path: string): string {
	return path.split("/").slice(0, -1).join("/");
}

/** Path/basename overlap: the strong signal, and the only thing that qualifies a test. */
export function pathOverlap(testPath: string, acceptedFiles: readonly string[]): number {
	const stem = testStem(testPath);
	const dir = directoryOf(testPath);
	let best = 0;
	for (const accepted of acceptedFiles) {
		if (stem === moduleStem(accepted)) best = Math.max(best, 1);
		const acceptedDir = directoryOf(accepted);
		if (dir === acceptedDir || (acceptedDir.length > 0 && (dir.endsWith(`/${acceptedDir}`) || acceptedDir.endsWith(`/${dir}`)))) {
			best = Math.max(best, 0.5);
		}
	}
	return best;
}

export interface RankTestsInput {
	discovered: readonly DiscoveredTest[];
	acceptedFiles: readonly string[];
	declaredRunners: readonly string[];
	/** The test's own bytes; used only to count identifier evidence, never to qualify. */
	readContent?: (path: string) => string;
}

/** The rule's score: path overlap, then runner ownership, then identifier evidence. */
export function deterministicTestScore(
	test: DiscoveredTest,
	input: RankTestsInput,
): number {
	const overlap = pathOverlap(test.path, input.acceptedFiles);
	const owned = test.runners.some((runner) => input.declaredRunners.includes(runner));
	const ownership = test.runners.length === 0 ? (input.declaredRunners.length === 0 ? 0.5 : 0) : owned ? 1 : 0.5;
	const stems = [...new Set(input.acceptedFiles.map(moduleStem))].filter((stem) => stem.length > 2);
	const content = stems.length > 0 ? (input.readContent?.(test.path) ?? "") : "";
	const hits = stems.reduce((total, stem) => total + (content.match(new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"))?.length ?? 0), 0);
	const identifiers = Math.min(hits / 3, 1);
	return 0.6 * overlap + 0.3 * ownership + 0.1 * identifiers;
}

/** Ranked candidates: only tests with path overlap qualify, so nothing unrelated can be listed. */
export function rankTests(input: RankTestsInput): TestCandidate[] {
	return input.discovered
		.filter((test) => pathOverlap(test.path, input.acceptedFiles) > 0)
		.map((test): TestCandidate => {
			const score = deterministicTestScore(test, input);
			return { path: test.path, score, deterministicScore: score, source: "fallback", runners: [...test.runners] };
		})
		.sort(sortTests);
}

export function sortTests(left: TestCandidate, right: TestCandidate): number {
	return right.score - left.score || right.deterministicScore - left.deterministicScore || left.path.localeCompare(right.path);
}

/** JEV reorders the qualified set; a score for an unqualified path is malformed and ignored. */
export function overlayTestScores(
	candidates: readonly TestCandidate[],
	scores: ReadonlyMap<string, number>,
): { candidates: TestCandidate[]; malformed: string[] } {
	const known = new Set(candidates.map((candidate) => candidate.path));
	const malformed = [...scores.keys()].filter((path) => !known.has(path)).sort();
	const overlaid = candidates.map((candidate): TestCandidate => {
		const score = scores.get(candidate.path);
		return score === undefined ? candidate : { ...candidate, score, source: "jev" };
	});
	return { candidates: overlaid.sort(sortTests), malformed };
}
