/**
 * `verifyTask` — the entry point a turn calls once its workspace edits have
 * landed (PRD-009, FR-120–FR-123).
 *
 * Selection → execution → storage, in that order, with the workspace hash
 * captured once at run start so every record of one run shares one provenance
 * stamp. The returned status is the aggregate and only the aggregate: no
 * parameter, and no semantic answer, can raise it.
 *
 * Nothing here requires network, a JEV key or a model: verifiers are local
 * commands, the regression-scope question resolves through its declared
 * deterministic fallback, and a missing facility is recorded as `unavailable`
 * or `not_run` rather than inferred as a pass.
 */
import type { ExecutionContract } from "../compiler/contract.js";
import type { ArtifactStore } from "../context/artifacts.js";
import type { LeanPiConfig } from "../core/types.js";
import type { JevClient } from "../jev/client.js";
import { aggregate, type VerificationStatus } from "./aggregate.js";
import { captureArtifact, DEFAULT_SCOPES, verifierFor, verifierOutcome, type VerifierContext, type VerifierDescriptor } from "./descriptors.js";
import { EvidenceStore, type EvidenceRecord, type EvidenceView, type VerifierResult } from "./evidence.js";
import { workspaceHash } from "./hash.js";
import { selectVerifiers, type DiffSummary, type RegressionScope } from "./select.js";
import type { ShellExec } from "./run.js";

/** The `verify:` block a host project may carry; the table in `descriptors.ts` is the default. */
export interface VerifySettings {
	commands?: Partial<Record<string, string>>;
	timeoutMs?: number;
}

export interface VerifyOptions {
	/** Reuse a store across attempts; a fresh one is created otherwise. */
	store?: EvidenceStore;
	/** Where captured stdout/stderr is stored; without it records carry `artifactRef: null`. */
	artifacts?: ArtifactStore;
	/** The JEV control plane. Absent, disabled or unreachable all mean the deterministic rule answers. */
	jev?: Pick<JevClient, "ask">;
	/** The session config; its optional `verify` block overrides commands and timeout. */
	config?: LeanPiConfig | VerifySettings;
	commands?: Partial<Record<string, string>>;
	timeoutMs?: number;
	/** Files this task touched; hashed alongside the git dirty set. */
	touchedPaths?: readonly string[];
	diff?: DiffSummary;
	/** Executor claims, recorded on the assertion channel only. */
	assertions?: ReadonlyArray<{ source: string; text: string; recordedAt?: string }>;
	/** Test seam: command execution. */
	exec?: ShellExec;
	now?: () => Date;
}

export interface VerifyResult extends EvidenceView {
	status: VerificationStatus;
	/**
	 * The exact commands this run resolved, in execution order. `records` and
	 * `staleRecords` cover this run only, so a store reused across attempts never
	 * folds an earlier attempt's verdict into this one; the store keeps the full
	 * history for `forCriterion`.
	 */
	commands: string[];
	regressionScope: RegressionScope;
}

/** The record kind used when the freshness stamp itself could not be computed. */
export const WORKSPACE_HASH_KIND = "workspace_hash";

const DEFAULT_TIMEOUT_MS = 120_000;

function settingsOf(options: VerifyOptions): Required<VerifySettings> {
	const carried = (options.config as { verify?: VerifySettings } | undefined)?.verify ?? {};
	return {
		commands: { ...carried.commands, ...options.commands },
		timeoutMs: options.timeoutMs ?? carried.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	};
}

function placeholderDescriptor(kind: string): VerifierDescriptor {
	return { kind, command: "", mandatory: true, criterion: [], scope: DEFAULT_SCOPES[kind] ?? "" };
}

/**
 * Run the contract's verifier set against `workspaceRoot`.
 *
 * `contract.verification.required` drives the set (with §8 aliases normalized
 * and `git_status` always added); the regression-scope decision may add the full
 * suite. Every selected verifier produces exactly one record, so a check that
 * could not run is visible to PRD-010 as `not_run`/`unavailable`.
 */
export async function verifyTask(contract: ExecutionContract, workspaceRoot: string, options: VerifyOptions = {}): Promise<VerifyResult> {
	const store = options.store ?? new EvidenceStore(options.now);
	const settings = settingsOf(options);
	const touchedPaths = options.touchedPaths ?? options.diff?.files ?? [];
	const context: VerifierContext = {
		cwd: workspaceRoot,
		timeoutMs: settings.timeoutMs,
		...(options.artifacts ? { artifacts: options.artifacts } : {}),
		...(options.exec ? { exec: options.exec } : {}),
	};

	const selection = await selectVerifiers(contract, {
		...(options.jev ? { jev: options.jev } : {}),
		// A caller that supplies no diff still has one: the files this run touched.
		// Without it the regression-scope rule cannot see a broad change, and the
		// targeted test has no surface to name.
		diff: options.diff ?? { files: touchedPaths },
		commands: settings.commands,
	});

	/** Every kind this run must account for; anything else is advisory and not aggregated. */
	const countedKinds = new Set<string>(selection.skipped.map((skip) => skip.kind));
	const commands: string[] = [];
	/** This run's records, so a store reused across attempts never folds an earlier attempt in. */
	const produced: EvidenceRecord[] = [];
	const record = (result: VerifierResult, workspaceState: string): void => {
		produced.push(store.record(result, workspaceState));
	};

	// One hash for the whole run: it is the workspace state the results describe.
	let hash = "";
	let hashFailure: string | null = null;
	const recordHashFailure = (message: string, workspaceState: string): void => {
		countedKinds.add(WORKSPACE_HASH_KIND);
		record(
			{
				kind: WORKSPACE_HASH_KIND,
				status: "error",
				exitCode: null,
				artifactRef: captureArtifact(options.artifacts, WORKSPACE_HASH_KIND, message),
				criterion: [],
				scope: "workspace",
				reason: message,
			},
			workspaceState,
		);
	};
	try {
		hash = workspaceHash(workspaceRoot, touchedPaths);
	} catch (error) {
		hashFailure = error instanceof Error ? error.message : String(error);
		recordHashFailure(hashFailure, hash);
	}

	for (const descriptor of selection.descriptors) {
		if (descriptor.mandatory) countedKinds.add(descriptor.kind);
		if (descriptor.command.length > 0) commands.push(descriptor.command);
		let result: VerifierResult;
		try {
			const runner = verifierFor(descriptor.kind);
			result = runner
				? await runner.run(descriptor, context)
				: verifierOutcome(descriptor, "not_run", {
						reason: `no verifier registered for kind "${descriptor.kind}"`,
						artifactRef: captureArtifact(options.artifacts, descriptor.kind, `no verifier registered for kind "${descriptor.kind}"`),
					});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			result = verifierOutcome(descriptor, "error", {
				reason,
				artifactRef: captureArtifact(options.artifacts, descriptor.kind, `$ ${descriptor.command}\n${reason}`),
			});
		}
		record(result, hash);
	}

	for (const skip of selection.skipped) {
		record(
			verifierOutcome(placeholderDescriptor(skip.kind), "not_run", {
				reason: skip.reason,
				artifactRef: captureArtifact(options.artifacts, skip.kind, skip.reason),
			}),
			hash,
		);
	}

	for (const claim of options.assertions ?? []) store.assert(claim);

	let finalHash = hash;
	if (hashFailure === null) {
		try {
			finalHash = workspaceHash(workspaceRoot, touchedPaths);
		} catch (error) {
			recordHashFailure(error instanceof Error ? error.message : String(error), hash);
		}
	}

	const fresh = produced.filter((entry) => entry.workspaceHash === finalHash);
	const stale = produced.filter((entry) => entry.workspaceHash !== finalHash);
	const counted = (records: readonly EvidenceRecord[]): EvidenceRecord[] => records.filter((entry) => countedKinds.has(entry.kind));

	return {
		records: fresh,
		staleRecords: stale,
		assertions: store.view(finalHash).assertions,
		status: aggregate(counted(fresh), counted(stale)),
		commands,
		regressionScope: selection.regressionScope,
	};
}
