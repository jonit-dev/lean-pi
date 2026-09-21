/**
 * `/verify` — run this task's verification and proof gate against the workspace
 * as it is now.
 *
 * On a native backend Pi's own loop is the executor (§23), so LeanPi's executor
 * lane — and with it PRD-009's verification and PRD-010's gate — never runs.
 * Every claim of done on that path was therefore the model's word, which is the
 * one thing this harness exists not to ship.
 *
 * `verifyAndGate` is the gate itself, reached two ways. The executor calls it
 * through the `verify` tool when its own change carries regression risk — that
 * decision belongs to the model that just made the change and knows what it
 * touched, not to a rule in the harness, and not to the user being told to run a
 * command. This command is the other door: proving the workspace on demand,
 * mid-session, when no turn just changed it.
 *
 * It regenerates nothing. It runs the contract's verifiers, gates their records
 * and reports — so a `PASS` here is the same decision the executor lane's turns
 * are held to.
 */
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExecutionContract } from "../compiler/contract.js";
import type { ArtifactStore } from "../context/artifacts.js";
import type { LeanPiConfig } from "../core/types.js";
import type { JevClient } from "../jev/client.js";
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
}

export interface VerifyAndGateResult {
	verification: Awaited<ReturnType<typeof verifyTask>>;
	proof: Awaited<ReturnType<typeof evaluateProofGate>>;
}

/** The contract's verifiers, then PRD-010's gate over exactly the records they wrote. */
export async function verifyAndGate(contract: ExecutionContract, deps: Omit<VerifyCommandDeps, "contract">): Promise<VerifyAndGateResult> {
	const store = new EvidenceStore();
	const verification = await verifyTask(contract, deps.cwd, {
		store,
		config: deps.config,
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
			...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
			...(deps.jev ? { jev: deps.jev } : {}),
		},
	);

	return { verification, proof };
}

export async function runVerifyCommand(deps: VerifyCommandDeps): Promise<CommandResult> {
	const contract = deps.contract();
	if (!contract) return { ok: false, text: "nothing to verify: no task has been compiled in this session yet" };
	const { verification, proof } = await verifyAndGate(contract, deps);

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

export const VERIFY_TOOL_NAME = "verify";

/**
 * When the executor should reach for it.
 *
 * This is the tool's description, which is the only instruction the model reads
 * at the moment it decides. Two triggers, both about risk rather than ceremony:
 * a change that could break something already working, and a bug fix, which is
 * not proved by code that passes — it is proved by a test that failed before the
 * fix and passes after it.
 */
export const VERIFY_TOOL_DESCRIPTION = [
	"Run this task's verifiers against the workspace and put the result through the proof gate.",
	"",
	"Call it when your change carries regression risk — it touches shared code, a caller you did not read, or behaviour something else depends on. Run the tests related to what you changed, not the whole suite, unless the change is broad enough to warrant it.",
	"For a bug fix, work red to green: write the failing test first and call this to watch it fail, then fix, then call it again to watch it pass. A fix with no test that ever failed proves nothing.",
	"Skip it for a change that cannot regress anything — a comment, a docs edit, an answer with no edit at all.",
].join("\n");

export interface VerifyToolDeps extends Omit<VerifyCommandDeps, "contract"> {
	/** The turn's compiled contract; `undefined` before anything has compiled one. */
	contract: () => ExecutionContract | undefined;
	/** Where the result lands so the turn's record and the goal boundary can read it. */
	onVerified?: (result: VerifyAndGateResult) => void;
}

export function verifyToolDefinition(deps: VerifyToolDeps): ToolDefinition {
	return {
		name: VERIFY_TOOL_NAME,
		label: VERIFY_TOOL_NAME,
		description: VERIFY_TOOL_DESCRIPTION,
		parameters: Type.Object({}),
		execute: async (): Promise<AgentToolResult<Record<string, unknown>>> => {
			const contract = deps.contract();
			// eslint-disable-next-line no-console
			if (!contract) {
				return { content: [{ type: "text", text: "unavailable: no task has been compiled in this session yet" }], details: {} };
			}
			const gated = await verifyAndGate(contract, deps);
			deps.onVerified?.(gated);
			// The gate's own words. An unproved criterion names itself and its reason
			// because that is what the model has to act on next; a bare FAIL would
			// send it guessing.
			const lines = [
				`proof: ${gated.proof.decision}`,
				`verification: ${gated.verification.status}${gated.verification.commands.length > 0 ? ` — ${gated.verification.commands.join(" · ")}` : " — no verifier matched this task"}`,
				...gated.proof.criteria
					.filter((criterion) => criterion.decision !== "PASS")
					.map((criterion) => `unproved ${criterion.id}: ${criterion.decision} — ${criterion.reasons.join("; ")}`),
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { proof: gated.proof.decision } };
		},
	};
}

/** Registers the tool and returns its name, for the session's allowlist. */
export function registerVerifyTool(pi: ExtensionAPI, deps: VerifyToolDeps): string {
	pi.registerTool(verifyToolDefinition(deps));
	return VERIFY_TOOL_NAME;
}
