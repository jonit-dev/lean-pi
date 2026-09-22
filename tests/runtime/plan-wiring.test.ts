/**
 * PRD-022 D1 — the runtime plan has a producer and a per-run consumer.
 *
 * `compileTask` copies the trusted `verify.runtime` block into the contract and
 * requires `runtime_smoke` only when a smoke plan exists; `verifyTask` selects
 * and runs the runtime kinds the contract declares, reading the plan from its
 * own context so two overlapping verifications cannot see each other's plan.
 */
import { describe, expect, it } from "vitest";
import { compileTask } from "../../src/compiler/index.js";
import { registerRuntimeVerifiers, runtimePlanOf, selectRuntimeVerifiers } from "../../src/runtime/index.js";
import { verifyTask } from "../../src/verify/index.js";
import { unavailableHarness, packet } from "../compiler/helpers.js";
import { runtimeWorkspace } from "./support.js";

registerRuntimeVerifiers();

describe("D1 — compileTask produces verification.runtime", () => {
	it("requires runtime_smoke only when the config declares a smoke plan", async () => {
		const none = await unavailableHarness({ verify: { commands: {} } });
		try {
			const contract = await compileTask("fix the parse bug", packet());
			expect(contract.task.execution_complexity).toBe("MEDIUM");
			expect(contract.verification.required).not.toContain("runtime_smoke");
			expect(contract.verification.runtime).toBeUndefined();
			expect(runtimePlanOf(contract).smoke).toBeUndefined();
		} finally {
			await none.close();
		}

		const smoke = { command: "node server.js", ready: { port: 4321 } };
		const withSmoke = await unavailableHarness({ verify: { commands: {}, runtime: { smoke } } });
		try {
			const contract = await compileTask("fix the parse bug", packet());
			expect(contract.verification.runtime).toEqual({ smoke });
			expect(contract.verification.required).toContain("runtime_smoke");
			expect(runtimePlanOf(contract).smoke).toEqual(smoke);
		} finally {
			await withSmoke.close();
		}
	});

	it("selects a declared screenshot by declaration even when its baseline is absent", async () => {
		const baseline = "web/definitely-absent.png";
		const harness = await unavailableHarness({ verify: { commands: {}, runtime: { screenshot: { url: "http://127.0.0.1:1/", baseline } } } });
		try {
			const contract = await compileTask("fix the parse bug", packet());
			expect(contract.verification.required).toContain("screenshot_compare");
			expect(selectRuntimeVerifiers(contract)).toEqual(["screenshot_compare"]);
		} finally {
			await harness.close();
		}
	});

	it("selects the CLI kind a declared cli plan names", async () => {
		const cli = { command: "my-cli", expect: { exitCode: 0 } };
		const harness = await unavailableHarness({ verify: { commands: {}, runtime: { cli } } });
		try {
			const contract = await compileTask("fix the parse bug", packet());
			expect(contract.verification.required).toContain("cli_invocation");
			expect(selectRuntimeVerifiers(contract)).toEqual(["cli_invocation"]);
		} finally {
			await harness.close();
		}
	});
});

describe("D1 — verifyTask consumes the plan from its own context", () => {
	it("runs a declared CLI invocation and records its real output", async () => {
		const root = runtimeWorkspace();
		const contract = {
			task: { acceptance_criteria: [{ id: "AC-1", text: "cli works" }] },
			verification: {
				required: ["cli_invocation"],
				runtime: { cli: { command: "printf CLI-OK", expect: { stdoutContains: ["CLI-OK"] } } },
			},
			limits: { semantic_review_rounds: 0 },
		} as never;
		const result = await verifyTask(contract, root, {});
		const record = result.records.find((entry) => entry.kind === "cli_invocation");
		expect(record?.status).toBe("pass");
	});

	it("two overlapping plans each see their own declaration", async () => {
		const root = runtimeWorkspace();
		const contractOf = (marker: string) =>
			({
				task: { acceptance_criteria: [{ id: "AC-1", text: marker }] },
				verification: {
					required: ["cli_invocation"],
					runtime: { cli: { command: `printf ${marker}`, expect: { stdoutContains: [marker] } } },
				},
				limits: { semantic_review_rounds: 0 },
			}) as never;

		// Under a process-global bind the second call clobbers the first; per-context
		// plans mean each contract's own command is the one that runs.
		const [a, b] = await Promise.all([
			verifyTask(contractOf("PLAN-A"), root, {}),
			verifyTask(contractOf("PLAN-B"), root, {}),
		]);
		expect(a.records.find((entry) => entry.kind === "cli_invocation")?.status).toBe("pass");
		expect(b.records.find((entry) => entry.kind === "cli_invocation")?.status).toBe("pass");
	});

	it("records a declared screenshot with a missing baseline as unavailable, never a pass", async () => {
		const root = runtimeWorkspace();
		const contract = {
			task: { acceptance_criteria: [{ id: "AC-1", text: "shot" }] },
			verification: {
				required: ["screenshot_compare"],
				runtime: { screenshot: { url: "http://127.0.0.1:1/", baseline: "web/absent.png" } },
			},
			limits: { semantic_review_rounds: 0 },
		} as never;
		const result = await verifyTask(contract, root, { browserFacility: null });
		const record = result.records.find((entry) => entry.kind === "screenshot_compare");
		// A declared, required check never silently disappears: it is recorded
		// `unavailable`, which is not a pass.
		expect(record?.status).toBe("unavailable");
		expect(result.status).not.toBe("pass");
	});

	it("records a declared browser check unavailable when no facility is threaded", async () => {
		const root = runtimeWorkspace();
		const contract = {
			task: { acceptance_criteria: [{ id: "AC-1", text: "ui" }] },
			verification: {
				required: ["browser_test"],
				runtime: { browser: { url: "http://127.0.0.1:1/", selectors: ["#app"] } },
			},
			limits: { semantic_review_rounds: 0 },
		} as never;
		const result = await verifyTask(contract, root, { browserFacility: null });
		const record = result.records.find((entry) => entry.kind === "browser_test");
		// A declared, required check never silently disappears: it is recorded
		// `unavailable`, which is not a pass.
		expect(record?.status).toBe("unavailable");
		expect(result.status).not.toBe("pass");
	});
});
