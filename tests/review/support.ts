/** Shared fixtures for the PRD-011 reviewer-lane suite: a changed fixture repo, configs and runners. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createArtifactStore, type ArtifactStore } from "../../src/context/artifacts.js";
import { loadConfig } from "../../src/core/config.js";
import type { LeanPiConfig } from "../../src/core/types.js";
import { createJevClient, type JevClient } from "../../src/jev/client.js";
import type { RegisteredBackend, WorkerOutcome, WorkerTaskPacket } from "../../src/backends/index.js";
import { REVIEW_LEVEL_QUESTION_ID } from "../../src/review/gate.js";
import type { ReviewRunner } from "../../src/review/lane.js";
import { workspaceChange } from "../../src/review/packet.js";
import type { ReviewLevel } from "../../src/review/schema.js";
import { gitCommitAll, gitInit, tempDir } from "../helpers/fixtures.js";
import { startStubJev, typedAnswers, type StubJev } from "../helpers/stub-jev.js";

/** A string that exists only in the executor's turn record, never in a review packet. */
export const TRANSCRIPT_MARKER = "EXECUTOR-TRANSCRIPT-MARKER-9f3a1c";

function writeFiles(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
}

export interface ReviewRepo {
	cwd: string;
	artifacts: ArtifactStore;
	/** The full candidate diff, as the packet builder reads it. */
	diff(): string;
	/** Path of the committed executor transcript the packet must never reproduce. */
	transcriptPath: string;
}

/**
 * A repository whose base commit carries an executor transcript containing
 * `TRANSCRIPT_MARKER`, plus an uncommitted candidate change (one modified file,
 * one untracked file). The marker is reachable from the workspace but is not part
 * of the diff, which is what makes AC-2's absence check meaningful.
 */
export function reviewRepo(): ReviewRepo {
	const cwd = tempDir("leanpi-review-");
	gitInit(cwd);
	writeFiles(cwd, {
		"src/app.ts": "export const value = 1;\n",
		"notes/executor-transcript.md": `executor turn 1: ${TRANSCRIPT_MARKER}\n`,
	});
	gitCommitAll(cwd, "base");
	writeFiles(cwd, {
		"src/app.ts": "export const value = 2;\n",
		"src/added.ts": "export const added = true;\n",
	});
	return {
		cwd,
		// The session directory lives outside the repository on purpose: an artifact
		// written into the workspace changes the porcelain listing PRD-009 hashes,
		// which would make its own evidence read as stale.
		artifacts: createArtifactStore({ sessionDir: join(tempDir("leanpi-review-session-"), "session") }),
		transcriptPath: join(cwd, "notes/executor-transcript.md"),
		diff: () => workspaceChange(cwd).diff,
	};
}

function native(name: string, model?: string): Record<string, unknown> {
	return {
		type: "native",
		baseUrl: `http://127.0.0.1:1/v1/${name}`,
		api: "openai-completions",
		apiKey: "sk-stub",
		...(model ? { model } : {}),
	};
}

function stubJevConfig(cwd: string, backends: Record<string, unknown>, models: LeanPiConfig["models"] = {}): LeanPiConfig {
	return loadConfig(cwd, {
		configPath: null,
		backends,
		models,
		jev: { apiKey: null, endpoint: "http://127.0.0.1:1/v1/systemone", model: "jev-stub", mode: "disabled" },
	});
}

/** One backend (`a`) serving both roles: the pool that cannot offer a differing reviewer. */
export function singleBackendConfig(cwd: string): LeanPiConfig {
	return stubJevConfig(cwd, { a: native("a", "exec-ma") }, {
		balanced: { backend: "a", model: "exec-ma" },
		review_quick: { backend: "a", model: "exec-ma" },
		review_strong: { backend: "a", model: "exec-ma" },
	});
}

/** Two backends: the reviewer role resolves to `b`, which the executor never ran on (§31). */
export function twoBackendConfig(cwd: string): LeanPiConfig {
	return stubJevConfig(cwd, { a: native("a", "exec-ma"), b: native("b", "review-mb") }, {
		balanced: { backend: "a", model: "exec-ma" },
		review_quick: { backend: "a", model: "exec-ma" },
		review_strong: { backend: "b", model: "review-mb" },
	});
}

export function configWith(cwd: string, backends: Record<string, unknown>, models: LeanPiConfig["models"]): LeanPiConfig {
	return stubJevConfig(cwd, backends, models);
}

export interface ScriptedRunner {
	runner: ReviewRunner;
	/** One entry per invocation: the packet the lane built and the backend it chose. */
	calls: Array<{ packet: WorkerTaskPacket; backend: RegisteredBackend }>;
}

/** A scripted reviewer: the last summary repeats once the queue is exhausted. */
export function scriptedRunner(summaries: string | string[]): ScriptedRunner {
	const queue = Array.isArray(summaries) ? [...summaries] : [summaries];
	const calls: ScriptedRunner["calls"] = [];
	return {
		calls,
		runner: async (packet, backend): Promise<WorkerOutcome> => {
			calls.push({ packet, backend });
			const summary = queue.length > 1 ? queue.shift()! : queue[0]!;
			return { status: "ok", changedFiles: [], summary };
		},
	};
}

/** The verdict JSON a reviewer is scripted to emit. */
export function verdictJson(decision: string, findings: Array<Record<string, string>> = []): string {
	return JSON.stringify({ decision, findings });
}

export interface JevStubHarness {
	client: Pick<JevClient, "ask">;
	stub: StubJev;
	close(): Promise<void>;
}

/** A real JEV client pointed at a stub endpoint that answers `review.level` with `choice`. */
export async function jevAnswering(choice: ReviewLevel): Promise<JevStubHarness> {
	const stub = await startStubJev([
		(body) => ({
			answers: typedAnswers(body, {
				[REVIEW_LEVEL_QUESTION_ID]: { type: "choice", choice, probabilities: { [choice]: 0.95 }, confidence: 0.95 },
			}),
		}),
	]);
	const cwd = tempDir("leanpi-review-jev-");
	const config = loadConfig(cwd, {
		configPath: null,
		backends: { a: native("a") },
		models: { balanced: { backend: "a", model: "m" } },
		jev: { endpoint: stub.url, apiKey: "test-key", model: "jev-latest", mode: "enabled" },
	});
	return { client: createJevClient({ config, cwd }), stub, close: () => stub.close() };
}

/** A JEV client that fails every call: the §49 degradation path. */
export function throwingJev(): Pick<JevClient, "ask"> {
	return { ask: () => Promise.reject(new Error("JEV is down")) };
}
