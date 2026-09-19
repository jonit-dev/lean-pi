/**
 * Phase 2 / AC-2 — derivation from the PRD and evidence-governed status.
 *
 * The fixture is a real PRD written in the repository's own convention (PRD-012's
 * `stagedPrd`), so the criteria come from the parser the lane actually consumes;
 * the gate is PRD-010's own `evaluateProofGate` where the verdict must be real,
 * and a swappable port where the verdict is the variable under test.
 */
import { describe, expect, it } from "vitest";
import { createCommandRegistry, type CommandContext } from "../../src/commands/registry.js";
import type { ExecutionContract } from "../../src/compiler/contract.js";
import { evaluateProofGate, type ProofCriterion } from "../../src/proof/index.js";
import { registerTodoCommands } from "../../src/todo/commands.js";
import { gateFromProofResult, syncFromPrd } from "../../src/todo/derive.js";
import type { PrdState } from "../../src/prd/state.js";
import type { TodoCarrier, TodoGate, TodoGateVerdict, TodoItem } from "../../src/todo/state.js";
import { artifactStoreFor, freshPass, stagedPrd, HASH_AT_READ } from "../prd/helpers.js";
import { tempDir } from "../helpers/fixtures.js";

const context = (cwd: string): CommandContext => ({ cwd });

/** The swappable gate: the verdict per criterion is what this spec varies. */
function gateWith(verdicts: Record<string, TodoGateVerdict | undefined>): TodoGate {
	return { verdict: (criterionId) => verdicts[criterionId] };
}

const PASS: TodoGateVerdict = { decision: "PASS", missing: [], reason: "every required kind has a fresh passing record" };
const MISSING: TodoGateVerdict = {
	decision: "MISSING_PROOF",
	missing: ["targeted_test"],
	reason: "AC-2: no fresh passing record for targeted_test",
};

function fixture(): { cwd: string; state: TodoCarrier; prd: PrdState } {
	const cwd = tempDir("leanpi-todo-derive-");
	const prd = stagedPrd(cwd, { artifactStore: artifactStoreFor(tempDir("leanpi-todo-artifacts-")) }).state;
	return { cwd, state: {}, prd };
}

const contract = (reviewer: "none" | "review_quick" = "none"): ExecutionContract => ({
	task: {
		type: "code_change",
		prd_required: true,
		planning_decision: "PRD_REQUIRED",
		execution_complexity: "MEDIUM",
		review_risk: "R1",
		required_capability: { min_coding_index: 20 },
		user_request: "implement the todo list",
	},
	routing: { executor_class: "balanced", executor_backend: "unresolved", reviewer_class: reviewer },
	reasoning: { effort: "medium" },
	capabilities: { skills: [], mcps: [], lsp: false, rtk: "auto" },
	context: { strategy: "targeted", budget_tokens: 10_000 },
	verification: { required: ["targeted_test"] },
	limits: { execution_attempts: 1, semantic_review_rounds: 0 },
});

describe("todo derivation (AC-2)", () => {
	it("derives exactly the remaining criteria and stays idempotent", async () => {
		const { state, prd } = fixture();
		const first = await syncFromPrd(state, { prd });
		expect(first.map((item) => item.criterion)).toEqual(["AC-1", "AC-2", "AC-3"]);
		// The first pending item is the active one, exactly as after a `done`.
		expect(first.map((item) => item.status)).toEqual(["in_progress", "pending", "pending"]);
		expect(first.map((item) => item.id)).toEqual(["a", "b", "c"]);

		const second = await syncFromPrd(state, { prd });
		expect(second.map((item) => item.id)).toEqual(["a", "b", "c"]);
		expect(second.map((item) => item.criterion)).toEqual(["AC-1", "AC-2", "AC-3"]);
	});

	it("lists the derived items with their criterion ids through /todo", async () => {
		const { cwd, state, prd } = fixture();
		await syncFromPrd(state, { prd });
		const registry = createCommandRegistry();
		registerTodoCommands(registry, { cwd, state, prd: () => prd });

		const listing = (await registry.dispatch("/todo", context(cwd))).text;
		expect(listing).toContain("a: in_progress AC-1");
		expect(listing).toContain("b: pending AC-2");
		expect(listing).toContain("c: pending AC-3");
	});

	it("follows the gate: PASS completes, and a lost PASS reopens at the original position", async () => {
		const { state, prd } = fixture();
		await syncFromPrd(state, { prd, gate: gateWith({ "AC-2": PASS }) });

		const items = () => state.todo as TodoItem[];
		expect(items().map((item) => `${item.id}:${item.status}`)).toEqual(["a:in_progress", "b:done", "c:pending"]);

		// Fresh contradicting evidence: the gate stops reporting PASS for AC-2.
		await syncFromPrd(state, { prd, gate: gateWith({ "AC-2": MISSING }) });
		expect(items().map((item) => `${item.id}:${item.status}`)).toEqual(["a:in_progress", "b:pending", "c:pending"]);
		expect(items().findIndex((item) => item.criterion === "AC-2")).toBe(1);
	});

	it("maps a BLOCKED verdict to a blocked item carrying the gate's reason", async () => {
		const { state, prd } = fixture();
		await syncFromPrd(state, {
			prd,
			gate: gateWith({ "AC-1": { decision: "BLOCKED", missing: [], reason: "no diff-inspection executor is registered" } }),
		});
		const blocked = (state.todo as TodoItem[]).find((item) => item.criterion === "AC-1");
		expect(blocked).toMatchObject({ status: "blocked", blockedReason: "no diff-inspection executor is registered" });
	});

	it("refuses /todo done on a derived item that is not PASS, and accepts it when it is", async () => {
		const { cwd, state, prd } = fixture();
		await syncFromPrd(state, { prd });
		const registry = createCommandRegistry();
		registerTodoCommands(registry, { cwd, state, prd: () => prd, gate: gateWith({ "AC-2": MISSING }) });

		const refused = await registry.dispatch("/todo done b", context(cwd));
		expect(refused.ok).toBe(false);
		expect(refused.text).toContain("MISSING_PROOF");
		expect(refused.text).toContain("targeted_test");
		expect(state.todo?.find((item) => item.id === "b")?.status).toBe("pending");

		// The positive control: the same command with a PASS verdict completes.
		const passing = createCommandRegistry();
		registerTodoCommands(passing, { cwd, state, prd: () => prd, gate: gateWith({ "AC-2": PASS }) });
		expect((await passing.dispatch("/todo done b", context(cwd))).ok).toBe(true);
		expect(state.todo?.find((item) => item.id === "b")?.status).toBe("done");
	});

	it("consumes PRD-010's real gate result, PASS and not-PASS alike", async () => {
		const passing = gateFromProofResult(
			await evaluateProofGate(
				[{ id: "AC-1", text: "plan the cache layout", required: ["targeted_test"], scope: "tests/todo" }] satisfies ProofCriterion[],
				{ workspaceHash: HASH_AT_READ, evidence: [freshPass("AC-1", HASH_AT_READ, "artifact://todo/1")] },
				{ contract: contract() },
			),
		);
		expect(passing.verdict("AC-1")).toMatchObject({ decision: "PASS" });

		// A criterion with no runnable kind has no evidence to pass it: the gate
		// reports MISSING_PROOF against the criterion's own wording.
		const unproved = gateFromProofResult(
			await evaluateProofGate([{ id: "AC-2", text: "measure the hit rate", required: [] }], { workspaceHash: HASH_AT_READ }, { contract: contract() }),
		);
		const verdict = await unproved.verdict("AC-2");
		expect(verdict?.decision).toBe("MISSING_PROOF");
		expect(verdict?.reason).toContain("AC-2");

		const { state, prd } = fixture();
		await syncFromPrd(state, { prd, gate: passing });
		expect(state.todo?.find((item) => item.criterion === "AC-1")?.status).toBe("done");

		const registry = createCommandRegistry();
		registerTodoCommands(registry, { cwd: "/tmp/leanpi-todo-derive-gate", state, prd: () => prd, gate: unproved });
		const refused = await registry.dispatch("/todo done c", context("/tmp/leanpi-todo-derive-gate"));
		expect(refused.ok).toBe(false);
		expect(refused.text).toContain("cannot mark c done: MISSING_PROOF");
		expect(state.todo?.find((item) => item.id === "c")?.status).not.toBe("done");
	});
});
