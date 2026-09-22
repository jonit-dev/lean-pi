/**
 * `/verify` — run this task's verification and proof gate against the workspace
 * as it is now.
 *
 * On a native backend Pi's own loop is the executor (§23), so LeanPi's executor
 * lane — and with it PRD-009's verification and PRD-010's gate — never runs.
 * Every claim of done on that path was therefore the model's word, which is the
 * one thing this harness exists not to ship. Running the gate automatically
 * after each native turn would spend the project's test command on every
 * "explain this function", so it is a command: the user asks for evidence when
 * a claim matters, and the footer says when a turn has none.
 *
 * It regenerates nothing. It runs the contract's verifiers, gates their records
 * and reports — so a `PASS` here is the same decision the executor lane's turns
 * are held to.
 */
import type { ExecutionContract } from "../compiler/contract.js";
import type { ArtifactStore } from "../context/artifacts.js";
import type { LeanPiConfig } from "../core/types.js";
import type { JevClient } from "../jev/client.js";
import type { BrowserFacility } from "../runtime/browser.js";
import { evaluateProofGate } from "../proof/gate.js";
import { criteriaOf } from "../proof/packet.js";
import { EvidenceStore } from "../verify/evidence.js";
import { verifyTask } from "../verify/index.js";
import type { CommandRegistry, CommandResult } from "./registry.js";

export interface VerifyCommandDeps {
	cwd: string;
	config: LeanPiConfig;
	/** The turn's compiled contract; `undefined` until a turn has been compiled. */
	contract: () => ExecutionContract | undefined;
	artifacts?: ArtifactStore;
	jev?: Pick<JevClient, "ask" | "fallbackCount">;
	/** The host's browser adapter, threaded to the runtime verifiers this run may select. */
	browserFacility?: BrowserFacility | null;
}

export async function runVerifyCommand(deps: VerifyCommandDeps): Promise<CommandResult> {
	const contract = deps.contract();
	if (!contract) return { ok: false, text: "nothing to verify: no task has been compiled in this session yet" };

	const store = new EvidenceStore();
	const verification = await verifyTask(contract, deps.cwd, {
		store,
		config: deps.config,
		...(deps.browserFacility !== undefined ? { browserFacility: deps.browserFacility } : {}),
		...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
		...(deps.jev ? { jev: deps.jev } : {}),
	});
	const attributed = criteriaOf(contract);
	const criteria =
		attributed.length > 0
			? attributed
			: contract.task.acceptance_criteria.map((criterion) => ({ id: criterion.id, text: criterion.text, required: [...contract.verification.required] }));
	const proof = await evaluateProofGate(
		criteria,
		{ workspaceHash: verification.workspaceHash, evidence: verification.records, summary: null },
		{
			contract,
			config: deps.config,
			store,
			cwd: deps.cwd,
			...(deps.browserFacility !== undefined ? { browserFacility: deps.browserFacility } : {}),
			...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
			...(deps.jev ? { jev: deps.jev } : {}),
		},
	);

	// Verdict first: the caller renders a non-`PASS` result as an error, and a
	// line that opened with `verification: pass` read as a contradiction.
	const lines = [
		`proof: ${proof.decision}`,
		`verification: ${verification.status}${verification.commands.length > 0 ? ` — ${verification.commands.join(" · ")}` : " — no verifier matched this task"}`,
		...proof.criteria.filter((criterion) => criterion.decision !== "PASS").map((criterion) => `unproved ${criterion.id}: ${criterion.decision} — ${criterion.reasons.join("; ")}`),
	];
	return { ok: proof.decision === "PASS", text: lines.join("\n") };
}

export function registerVerifyCommand(registry: CommandRegistry, deps: VerifyCommandDeps): void {
	// A later session supersedes the earlier handler, like every other command.
	if (registry.has("verify")) registry.unregister("verify");
	registry.register({
		name: "verify",
		summary: "run this task's verifiers and proof gate against the workspace now",
		usage: "/verify",
		run: () => runVerifyCommand(deps),
	});
}
