/** Shared fixtures for the PRD-009 verification suite: temp workspaces, a command seam and contracts. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExecutionContract } from "../../src/compiler/contract.js";
import { loadConfig } from "../../src/core/config.js";
import type { JevMode, LeanPiConfig } from "../../src/core/types.js";
import type { JevQuestion, JevResult } from "../../src/jev/types.js";
import type { ShellExec, ShellRunResult } from "../../src/verify/run.js";
import type { RegressionScope } from "../../src/verify/select.js";

export interface ContractVerification {
	required: string[];
	criteria?: Array<{ id: string; verifiers?: string[]; scope?: string }>;
}

/** A §8 contract carrying only the verification block this layer reads. */
export function contractOf(verification: ContractVerification, type = "bugfix"): ExecutionContract {
	const contract = {
		task: {
			type,
			prd_required: false,
			planning_decision: "DIRECT_EXECUTION",
			execution_complexity: "LOW",
			review_risk: "R0",
			required_capability: { min_coding_index: 0 },
			user_request: type,
		},
		routing: { executor_class: "quick", executor_backend: "unresolved", reviewer_class: "none" },
		reasoning: { effort: "low" },
		capabilities: { skills: [], mcps: [], lsp: false, rtk: "auto" },
		context: { strategy: "targeted", budget_tokens: 6000 },
		verification: { required: verification.required, ...(verification.criteria ? { criteria: verification.criteria } : {}) },
		limits: { execution_attempts: 1, semantic_review_rounds: 0 },
	};
	return contract as unknown as ExecutionContract;
}

export function tempWorkspace(): string {
	return mkdtempSync(join(tmpdir(), "leanpi-verify-"));
}

export function writeFiles(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

/** `git status` needs a repository; the workspace hash uses whatever git reports. */
export function gitInit(root: string): void {
	execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
}

export interface RecordingExec {
	exec: ShellExec;
	/** Every command the run actually executed, in order. */
	commands: string[];
}

/** A command seam that records invocations instead of shelling out. */
export function recordingExec(respond?: (command: string) => Partial<ShellRunResult> | undefined): RecordingExec {
	const commands: string[] = [];
	return {
		commands,
		exec: async (command) => {
			commands.push(command);
			return { exitCode: 0, stdout: "", stderr: "", timedOut: false, spawnError: null, ...respond?.(command) };
		},
	};
}

/** A scripted control plane: every atomic question answers the same Choice. */
export function jevStub(choice: RegressionScope): { ask(siteId: string, questions: JevQuestion[], state: unknown): Promise<JevResult[]> } {
	return {
		ask: async (_siteId, questions) =>
			questions.map((question): JevResult => ({ kind: "Choice", questionId: question.id, choice, probabilities: {}, confidence: 1 })),
	};
}

/** A config whose only model role points at a stub backend, so no session is needed. */
export function stubConfig(root: string, mode: JevMode): LeanPiConfig {
	const env = { HOME: root, XDG_CONFIG_HOME: root };
	return loadConfig(
		root,
		{
			backends: { stub: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
			models: { quick: { backend: "stub", model: "stub-model" } },
			jev: { apiKey: null, endpoint: "http://127.0.0.1:1/v1/systemone", model: "jev-stub", mode },
		},
		env,
	);
}

/** The repository's own compiler, used by the one test that runs a real typecheck. */
export const TSC = join(process.cwd(), "node_modules", ".bin", "tsc");
