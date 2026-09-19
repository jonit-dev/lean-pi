/**
 * The standing negative control of PRD-010 (AC-2).
 *
 * An executor that asserts "feature implemented and working" while the evidence
 * channel holds nothing for the feature — one `git_status` record about the
 * workspace, attributed to no criterion — and a contract that names the check
 * that would have proved it. The gate must reject this; if it ever passes, the
 * fixture is the first thing that fails.
 */
import type { ExecutionContract } from "../../../src/compiler/contract.js";
import type { EvidenceStore } from "../../../src/verify/evidence.js";
import type { ProofCriterion, ProofOutcome } from "../../../src/proof/index.js";
import { criteriaOf } from "../../../src/proof/index.js";
import { FIXTURE_HASH, proofContract, storeOf } from "../support.js";

export const FALSE_COMPLETION_CRITERION = "AC-1";

/** The executor's claim, on the assertion channel only. */
export const FALSE_COMPLETION_CLAIM = "feature implemented and working";

/** The one check the contract would have run, and the surface it covers. */
export const FALSE_COMPLETION_CHECK = "targeted_test";
export const FALSE_COMPLETION_SCOPE = "tests/feature.test.ts";

export interface FalseCompletion {
	contract: ExecutionContract;
	criteria: ProofCriterion[];
	store: EvidenceStore;
	outcome: ProofOutcome;
	/** Every record the fixture's store holds — asserted by the spec so the control is not vacuous. */
	recorded: readonly string[];
}

export function falseCompletion(rounds = 0): FalseCompletion {
	const contract = proofContract(
		{
			required: [FALSE_COMPLETION_CHECK],
			criteria: [{ id: FALSE_COMPLETION_CRITERION, verifiers: [FALSE_COMPLETION_CHECK], scope: FALSE_COMPLETION_SCOPE }],
		},
		rounds,
	);
	// `git_status` is the workspace's own dirty proof: it says nothing about the
	// criterion, so it carries no criterion attribution.
	const store = storeOf(FIXTURE_HASH, [{ kind: "git_status", status: "pass", scope: "workspace" }]);
	store.assert({ source: "executor", text: FALSE_COMPLETION_CLAIM });
	return {
		contract,
		criteria: criteriaOf(contract),
		store,
		outcome: {
			workspaceHash: FIXTURE_HASH,
			changedFiles: ["src/feature.ts"],
			summary: FALSE_COMPLETION_CLAIM,
		},
		recorded: ["git_status"],
	};
}
