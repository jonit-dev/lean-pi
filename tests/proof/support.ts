/** Shared fixtures for the PRD-010 proof-gate suite. */
import type { ExecutionContract } from "../../src/compiler/contract.js";
import { loadConfig } from "../../src/core/config.js";
import type { JevMode, LeanPiConfig } from "../../src/core/types.js";
import { GAP_QUESTION_ID, SUFFICIENCY_QUESTION_IDS } from "../../src/proof/questions.js";
import type { ProofAttempt, ProofReview, ProofReviewLevel, ProofReviewVerdict } from "../../src/proof/recover.js";
import { EvidenceStore, type EvidenceStatus, type VerifierResult } from "../../src/verify/evidence.js";
import { tempDir } from "../helpers/fixtures.js";
import { contractOf, type ContractVerification } from "../verify/support.js";

/** A stable stand-in for PRD-009's workspace hash: hashing is that PRD's subject, not this gate's. */
export const FIXTURE_HASH = "3f".repeat(32);

/** A workspace for recovery commands to run in. */
export const FIXTURE_CWD = tempDir("leanpi-proof-");

/** The §8 contract the gate reads, with the round ceiling this fixture needs. */
export function proofContract(verification: ContractVerification, rounds: number): ExecutionContract {
	const contract = contractOf(verification);
	contract.limits.semantic_review_rounds = rounds;
	return contract;
}

export interface RecordSpec {
	kind: string;
	status: EvidenceStatus;
	/** Acceptance-criterion ids the record is attributed to; empty means task-level. */
	criterion?: string[];
	scope?: string;
	exitCode?: number | null;
	artifactRef?: string | null;
	/** A different hash makes the record stale against the hash under test. */
	hash?: string;
}

/** A store holding exactly these records, stamped with a fixed timestamp so two runs are comparable. */
export function storeOf(workspaceHash: string, specs: readonly RecordSpec[]): EvidenceStore {
	const store = new EvidenceStore();
	for (const spec of specs) {
		const result: VerifierResult = {
			kind: spec.kind,
			status: spec.status,
			exitCode: spec.exitCode ?? null,
			artifactRef: spec.artifactRef ?? null,
			criterion: spec.criterion ?? [],
			scope: spec.scope ?? "",
		};
		store.record(result, spec.hash ?? workspaceHash, "2026-01-01T00:00:00.000Z");
	}
	return store;
}

/** A config whose only backend is a stub, so nothing in this suite needs a model or a network. */
export function proofConfig(
	root: string,
	mode: JevMode,
	overrides: { endpoint?: string; apiKey?: string | null } = {},
): LeanPiConfig {
	const env = { HOME: root, XDG_CONFIG_HOME: root };
	return loadConfig(
		root,
		{
			backends: { stub: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
			models: { quick: { backend: "stub", model: "stub-model" } },
			jev: {
				apiKey: overrides.apiKey ?? null,
				endpoint: overrides.endpoint ?? "http://127.0.0.1:1/v1/systemone",
				model: "jev-stub",
				mode,
			},
		},
		env,
	);
}

export interface ChoiceScript {
	demonstrates?: string;
	contradiction?: string;
	staticForRuntime?: string;
	unevidencedPath?: string;
	gap?: string;
}

/** The choice map the stub JEV responder needs, keyed by the real question ids. */
export function choiceMap(script: ChoiceScript): Record<string, string> {
	const choices: Record<string, string> = {};
	if (script.demonstrates) choices[SUFFICIENCY_QUESTION_IDS.demonstrates] = script.demonstrates;
	if (script.contradiction) choices[SUFFICIENCY_QUESTION_IDS.contradiction] = script.contradiction;
	if (script.staticForRuntime) choices[SUFFICIENCY_QUESTION_IDS.staticForRuntime] = script.staticForRuntime;
	if (script.unevidencedPath) choices[SUFFICIENCY_QUESTION_IDS.unevidencedPath] = script.unevidencedPath;
	if (script.gap) choices[GAP_QUESTION_ID] = script.gap;
	return choices;
}

export interface ReviewSpy {
	/** The binding the gate is handed in place of PRD-011's lane. */
	review: ProofReview;
	/** Every level the ladder called, in order. */
	levels: ProofReviewLevel[];
}

/** A reviewer lane that returns a scripted verdict per rung and records the rungs it was called at. */
export function reviewSpy(
	decisions: Partial<Record<ProofReviewLevel, string>> = {},
	packet: unknown = { objective: "fixture" },
): ReviewSpy {
	const levels: ProofReviewLevel[] = [];
	const run = async (_packet: unknown, level: ProofReviewLevel): Promise<ProofReviewVerdict> => {
		levels.push(level);
		return { verdict: { decision: decisions[level] ?? "FIX_REQUIRED" }, level, independence: "independent" };
	};
	return { levels, review: { packet, run } };
}

export function gatherAttempts(attempts: readonly ProofAttempt[]): Array<Extract<ProofAttempt, { kind: "gather" }>> {
	const gathered: Array<Extract<ProofAttempt, { kind: "gather" }>> = [];
	for (const attempt of attempts) {
		if (attempt.kind === "gather") gathered.push(attempt);
	}
	return gathered;
}

export function reviewAttempts(attempts: readonly ProofAttempt[]): Array<Extract<ProofAttempt, { kind: "review" }>> {
	const reviewed: Array<Extract<ProofAttempt, { kind: "review" }>> = [];
	for (const attempt of attempts) {
		if (attempt.kind === "review") reviewed.push(attempt);
	}
	return reviewed;
}
