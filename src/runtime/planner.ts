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
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExecutionContract } from "../compiler/contract.js";
import { runtimePlanOf, RUNTIME_VERIFIER_KINDS, type RuntimePlan } from "./plan.js";

export type RuntimeVerifierKind = (typeof RUNTIME_VERIFIER_KINDS)[number];

export interface RuntimeSelectionOptions {
	/**
	 * PRD-010's gap classification for the criterion being recovered, when there
	 * is one (`UI_VERIFICATION_REQUIRED`, `RUNTIME_TEST_REQUIRED`, or any other
	 * member of that enum, which changes nothing here).
	 */
	gap?: string;
	/** The workspace root the declarations' relative paths resolve against. Defaults to `process.cwd()`. */
	cwd?: string;
}

function baselineExists(plan: RuntimePlan, cwd: string): boolean {
	const declared = plan.screenshot?.baseline;
	if (declared === undefined) return false;
	return existsSync(isAbsolute(declared) ? declared : resolve(cwd, declared));
}

/**
 * The runtime verifier kinds this contract's declarations select, in canonical
 * order. Pure: no JEV, no model, no network — the same contract selects the same
 * set on every run.
 */
export function selectRuntimeVerifiers(contract: ExecutionContract | undefined, options: RuntimeSelectionOptions = {}): RuntimeVerifierKind[] {
	const plan = runtimePlanOf(contract);
	const cwd = options.cwd ?? process.cwd();
	const selected = new Set<RuntimeVerifierKind>();
	if (plan.smoke) selected.add("runtime_smoke");
	if (plan.cli) selected.add("cli_invocation");
	if (plan.browser) selected.add("browser_test");
	// A baseline is what makes a comparison possible; without one the screenshot
	// verifier could only report `unavailable`, so it is not selected.
	if (plan.screenshot && baselineExists(plan, cwd)) selected.add("screenshot_compare");
	switch (options.gap) {
		case "UI_VERIFICATION_REQUIRED":
			if (plan.browser) selected.add("browser_test");
			if (plan.screenshot && baselineExists(plan, cwd)) selected.add("screenshot_compare");
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
