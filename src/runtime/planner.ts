/**
 * Deterministic runtime-verifier selection (PRD-022 Phase 3, AC-5, ROADMAP §40).
 *
 * The rule is "declared surface → verifier kind", read off the contract's
 * `verification.runtime` block, and it is the primary path: with JEV disabled
 * the browser and runtime verifiers are still selected and still run. PRD-010's
 * missing-proof classification only *augments* the set — a `UI_VERIFICATION_REQUIRED`
 * gap names `browser_test`, a `RUNTIME_TEST_REQUIRED` gap names the runtime kind
 * the declaration actually names — and it never invents a check the contract
 * declared nothing for: the gate then reports the missing capability instead of
 * running a verifier over a surface nobody described.
 *
 * This closes §40's dead end. Without it a UI criterion whose contract never
 * listed `browser_test` could only re-request evidence it could not collect until
 * §41's loop limit fired, and the task would land BLOCKED for a reason that was
 * actually a missing selection rule.
 */
import type { ExecutionContract } from "../compiler/contract.js";
import { runtimePlanOf, RUNTIME_VERIFIER_KINDS } from "./plan.js";

export type RuntimeVerifierKind = (typeof RUNTIME_VERIFIER_KINDS)[number];

export interface RuntimeSelectionOptions {
	/**
	 * PRD-010's gap classification for the criterion being recovered, when there
	 * is one (`UI_VERIFICATION_REQUIRED`, `RUNTIME_TEST_REQUIRED`, or any other
	 * member of that enum, which changes nothing here).
	 */
	gap?: string;
}

/**
 * The runtime verifier kinds this contract's declarations select, in canonical
 * order. Pure: no JEV, no model, no network — the same contract selects the same
 * set on every run.
 *
 * A declared surface is always selected, even when its facility cannot run right
 * now: a missing baseline or an absent browser is the verifier's `unavailable`
 * record, not a reason for the check to vanish. Selection decides *what the
 * contract declared*, never whether the environment happens to satisfy it — a
 * rule that consulted the filesystem here would compile a configured screenshot
 * into no required check and report a false success.
 */
export function selectRuntimeVerifiers(contract: ExecutionContract | undefined, options: RuntimeSelectionOptions = {}): RuntimeVerifierKind[] {
	const plan = runtimePlanOf(contract);
	const selected = new Set<RuntimeVerifierKind>();
	if (plan.smoke) selected.add("runtime_smoke");
	if (plan.cli) selected.add("cli_invocation");
	if (plan.browser) selected.add("browser_test");
	if (plan.screenshot) selected.add("screenshot_compare");
	switch (options.gap) {
		case "UI_VERIFICATION_REQUIRED":
			if (plan.browser) selected.add("browser_test");
			if (plan.screenshot) selected.add("screenshot_compare");
			break;
		case "RUNTIME_TEST_REQUIRED":
			if (plan.smoke) selected.add("runtime_smoke");
			if (plan.cli) selected.add("cli_invocation");
			break;
		default:
			break;
	}
	return RUNTIME_VERIFIER_KINDS.filter((kind) => selected.has(kind));
}
