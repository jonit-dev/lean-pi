/** Shared fixtures for the executor-lane suite (PRD-007). */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BackendRegistry, type WorkerOutcome } from "../../src/backends/index.js";
import type { WorkerTaskPacket } from "../../src/backends/worker.js";
import { createArtifactStore, type ArtifactStore } from "../../src/context/artifacts.js";
import { compileTask, compileRecordOf, type ExecutionContract } from "../../src/compiler/index.js";
import { loadConfig } from "../../src/core/config.js";
import type { LeanPiConfig } from "../../src/core/types.js";
import type { EvidenceStore } from "../../src/verify/evidence.js";
import type { ShellExec } from "../../src/verify/run.js";
import { EvidenceStore as Store } from "../../src/verify/evidence.js";
import { scoutTask } from "../../src/scout/index.js";
import { getSite } from "../../src/jev/registry.js";
import type { JevQuestion, JevResult } from "../../src/jev/types.js";
import { nativeBackend, tempDir } from "../helpers/fixtures.js";
import { startStubJev, type StubJev, type StubJevResponder } from "../helpers/stub-jev.js";

export interface FixtureRepo {
	cwd: string;
	agentDir: string;
}

export function repoWithTest(): FixtureRepo {
	const cwd = tempDir("leanpi-exec-");
	const agentDir = tempDir("leanpi-exec-agent-");
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", devDependencies: { vitest: "^3.0.0" } }));
	writeFileSync(join(cwd, "src", "target.ts"), "export const value = 1;\n");
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
	execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Fixture"], { cwd });
	execFileSync("git", ["add", "-A"], { cwd });
	execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd });
	return { cwd, agentDir };
}

export function execConfig(cwd: string, overrides: Record<string, unknown> = {}): LeanPiConfig {
	return loadConfig(cwd, {
		configPath: null,
		backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
		models: { quick: { backend: "local", model: "cheap" }, balanced: { backend: "local", model: "mid" }, strong: { backend: "local", model: "big" } },
		...overrides,
	});
}

/** A config with several enabled backends, for the escalation chain cases. */
export function multiBackendConfig(cwd: string): LeanPiConfig {
	return loadConfig(cwd, {
		configPath: null,
		// Three enabled backends whose worker invocation is always stubbed; the
		// vendor names only have to satisfy the PRD-008 config schema.
		backends: {
			first: { type: "external_harness", vendor: "claude", command: "/bin/true", priority: 30 },
			second: { type: "external_harness", vendor: "codex", command: "/bin/true", priority: 20 },
			third: { type: "external_harness", vendor: "opencode", command: "/bin/true", priority: 10 },
		},
		models: { quick: { backend: "first", model: "cheap" }, balanced: { backend: "second", model: "mid" }, strong: { backend: "third", model: "big" } },
	});
}

/** Verifier overrides that resolve without a `{{scope}}` the fixture cannot supply. */
export const VERIFY_COMMANDS = { typecheck: "fixture-typecheck", targeted_test: "fixture-test", git_status: "git status --porcelain" } as const;

export function storeFor(agentDir: string): ArtifactStore {
	return createArtifactStore({ sessionDir: join(agentDir, "session") });
}

export function evidenceStore(): EvidenceStore {
	return new Store(() => new Date("2026-09-19T00:00:00.000Z"));
}

/** A scripted PRD-008 runner: the executor's worker seam. */
export function scriptedRunner(script: WorkerOutcome[]): {
	runner: (packet: WorkerTaskPacket) => Promise<WorkerOutcome>;
	packets: WorkerTaskPacket[];
} {
	const packets: WorkerTaskPacket[] = [];
	let index = 0;
	return {
		packets,
		async runner(packet) {
			packets.push(packet);
			const outcome = script[index] ?? script[script.length - 1]!;
			index += 1;
			return outcome;
		},
	};
}

export function okOutcome(changedFiles: string[]): WorkerOutcome {
	return { status: "ok", changedFiles, summary: "done" };
}

export function blockedOutcome(reason: string): WorkerOutcome {
	return { status: "blocked", attempts: [{ backend: "first", reason }] } as unknown as WorkerOutcome;
}

export function failureOutcome(kind: "exit" | "spawn" | "timeout" | "limit", reason: string): WorkerOutcome {
	return { status: "failed", failure: kind, reason };
}

/** A shell seam that always reports the given status without spawning anything. */
export function fakeExec(options: { pass: boolean; output?: string; kind?: string }): ShellExec {
	return async (command: string) => ({
		command,
		exitCode: options.pass ? 0 : 1,
		stdout: options.pass ? (options.output ?? "ok") : "",
		stderr: options.pass ? "" : (options.output ?? `${options.kind ?? "typecheck"} error: TS2322 at src/target.ts:3:5`),
		timedOut: false,
		spawnError: null,
	});
}

export interface ScriptedJev {
	ask(siteId: string, questions: JevQuestion[], state: unknown): Promise<JevResult[]>;
	fallbackCount(): number;
	calls: Array<{ site: string; state: unknown }>;
}

/**
 * An in-process JEV seam: one scripted answer per site id. An unscripted site,
 * or a site listed in `throwOn`, exercises the client's own failure path — the
 * answer is absent, so the lane's deterministic fallback must decide.
 */
export function scriptedJev(script: Record<string, (index: number) => JevResult | JevResult[]>, options: { throwOn?: readonly string[] } = {}): ScriptedJev {
	const calls: Array<{ site: string; state: unknown }> = [];
	const counts = new Map<string, number>();
	let fallbacks = 0;
	return {
		calls,
		fallbackCount: () => fallbacks,
		async ask(siteId, questions, state) {
			calls.push({ site: siteId, state });
			if (options.throwOn?.includes(siteId)) throw new Error(`stub JEV refused ${siteId}`);
			const index = counts.get(siteId) ?? 0;
			counts.set(siteId, index + 1);
			const entry = script[siteId];
			if (!entry) {
				fallbacks += 1;
				return getSite(siteId).fallback(questions, state);
			}
			const answer = entry(index);
			return Array.isArray(answer) ? answer : [answer];
		},
	};
}

export function choice(questionId: string, value: string, confidence = 0.95): JevResult {
	return { kind: "Choice", questionId, choice: value, probabilities: { [value]: confidence }, confidence };
}

export function score(questionId: string, value: number, confidence = 0.95): JevResult {
	return { kind: "Score", questionId, score: value, legend: {}, confidence };
}

export interface ExecHarness {
	cwd: string;
	agentDir: string;
	config: LeanPiConfig;
	artifacts: ArtifactStore;
	store: EvidenceStore;
	registry: BackendRegistry;
	close(): Promise<void>;
}

export async function harness(options: { responders?: StubJevResponder[]; config?: (cwd: string) => LeanPiConfig } = {}): Promise<ExecHarness & { stub?: StubJev }> {
	const { cwd, agentDir } = repoWithTest();
	const config = options.config ? options.config(cwd) : execConfig(cwd);
	let stub: StubJev | undefined;
	let jevConfig = config;
	if (options.responders) {
		stub = await startStubJev(options.responders);
		jevConfig = { ...config, jev: { ...config.jev, endpoint: stub.url, apiKey: "test-key", mode: "enabled" } };
	}
	return {
		cwd,
		agentDir,
		config: jevConfig,
		artifacts: storeFor(agentDir),
		store: evidenceStore(),
		registry: new BackendRegistry(jevConfig),
		...(stub ? { stub } : {}),
		async close() {
			await stub?.close();
		},
	};
}

/** A contract compiled for a request, with the executor class forced to `quick`. */
export async function quickContract(h: ExecHarness, request = "rename the helper in src/target.ts"): Promise<ExecutionContract> {
	const packet = scoutTask(h.cwd, request);
	const contract = await compileTask(request, packet);
	return contract;
}

export { compileRecordOf };
