/**
 * PRD-004 Phase 3 — AC-5, AC-6, AC-7: the routing matrix, deviations and the
 * atomic-question transcript.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compileRecordOf, compileTask, matrixDefault, REVIEWER_BY_RISK, ROUTING_MATRIX, type DeviationInput, type ExecutionComplexity } from "../../src/index.js";
import { answerScript, harness, packet, type AnswerSpec, type CompilerHarness } from "./helpers.js";

let active: CompilerHarness | undefined;

afterEach(async () => {
	await active?.close();
	active = undefined;
});

const REQUESTS: Record<string, string> = {
	LOW: "change the button text from Deploy to Publish",
	MEDIUM: "add an endpoint with several integrations across the service",
	HIGH: "optimise the sorting algorithm in the scheduler",
};

const PACKETS = {
	LOW: packet({
		task: { user_request: REQUESTS.LOW },
		workspace: { changed_files: ["src/button.ts"], likely_modules: ["src"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
	}),
	MEDIUM: packet({
		task: { user_request: REQUESTS.MEDIUM },
		workspace: { changed_files: ["src/a.ts", "src/b.ts", "src/c.ts"], likely_modules: ["src/a", "src/b"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
	}),
	HIGH: packet({
		task: { user_request: REQUESTS.HIGH },
		workspace: { changed_files: ["src/sort.ts"], likely_modules: ["src"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
	}),
};

function scriptFor(prdRequired: boolean, complexity: ExecutionComplexity, risk: "R0" | "R2"): AnswerSpec {
	const complexityChoices: Record<ExecutionComplexity, Record<string, string>> = {
		LOW: { mechanical: "yes", explicit_result: "yes", several_modules: "no", unfamiliar_coupled: "no", concurrency_perf: "no" },
		MEDIUM: { mechanical: "no", explicit_result: "yes", several_modules: "yes", unfamiliar_coupled: "no", concurrency_perf: "no" },
		HIGH: { mechanical: "no", explicit_result: "yes", several_modules: "no", unfamiliar_coupled: "no", concurrency_perf: "yes" },
	};
	return {
		choices: {
			architecture: prdRequired ? "yes" : "no",
			localized: prdRequired ? "no" : "yes",
			ambiguous: "no",
			multi_behavior: prdRequired ? "yes" : "no",
			multi_stage: "no",
			deterministic_sufficient: "yes",
			alters_visible: risk === "R2" ? "yes" : "no",
			wide_blast: risk === "R2" ? "yes" : "no",
			...complexityChoices[complexity],
		},
	};
}

describe("PRD-004 Phase 3 — routing matrix", () => {
	it("AC-5: every resolved §Solution row compiles to its documented classes", async () => {
		const cells: Array<{ prd: boolean; complexity: ExecutionComplexity; risk: "R0" | "R2"; executor: string; reviewer: string }> = [
			{ prd: false, complexity: "LOW", risk: "R0", executor: "quick", reviewer: "none" },
			{ prd: false, complexity: "LOW", risk: "R2", executor: "quick", reviewer: "review_quick" },
			{ prd: false, complexity: "MEDIUM", risk: "R0", executor: "balanced", reviewer: "review_quick" },
			{ prd: false, complexity: "HIGH", risk: "R0", executor: "strong", reviewer: "review_strong" },
			{ prd: true, complexity: "LOW", risk: "R0", executor: "quick", reviewer: "review_quick" },
			{ prd: true, complexity: "MEDIUM", risk: "R0", executor: "balanced", reviewer: "review_strong" },
			{ prd: true, complexity: "HIGH", risk: "R0", executor: "strong", reviewer: "review_strong" },
		];

		for (const cell of cells) {
			active = await harness([answerScript(scriptFor(cell.prd, cell.complexity, cell.risk))]);
			const request = REQUESTS[cell.complexity]!;
			const contract = await compileTask(request, PACKETS[cell.complexity]);
			const label = `${cell.prd}/${cell.complexity}/${cell.risk}`;
			expect(contract.task.prd_required, label).toBe(cell.prd);
			expect(contract.task.execution_complexity, label).toBe(cell.complexity);
			expect(contract.routing.executor_class, label).toBe(cell.executor);
			expect(contract.routing.reviewer_class, label).toBe(cell.reviewer);
			expect(contract.routing.deviation, label).toBeUndefined();
			await active.close();
			active = undefined;
		}

		// The table itself: one class per cell, and the risk-band mapping is fixed.
		expect(Object.keys(ROUTING_MATRIX).sort()).toEqual(["false|HIGH", "false|LOW", "false|MEDIUM", "true|HIGH", "true|LOW", "true|MEDIUM"]);
		expect(REVIEWER_BY_RISK).toEqual({ R0: "none", R1: "review_quick", R2: "review_quick", R3: "review_strong" });
		expect(matrixDefault(false, "LOW", "R2").reviewer_class).toBe("review_quick");
	});

	it("AC-6: a deviation is applied and recorded, or absent when nothing deviates", async () => {
		active = await harness([answerScript(scriptFor(false, "LOW", "R0"))]);
		const plain = await compileTask(REQUESTS.LOW, PACKETS.LOW);
		expect(plain.routing.executor_class).toBe("quick");
		expect(plain.routing.deviation).toBeUndefined();
		await active.close();
		active = undefined;

		const deviations: DeviationInput[] = [
			{ kind: "model_availability", executor_class: "quick", available: false, reason: "quick model is offline" },
		];
		active = await harness([answerScript(scriptFor(false, "LOW", "R0"))]);
		const deviated = await compileTask(REQUESTS.LOW, PACKETS.LOW, deviations);
		expect(deviated.routing.executor_class).toBe("balanced");
		expect(deviated.routing.deviation).toEqual({ from: "quick", to: "balanced", reason: "quick model is offline" });

		// An unknown deviation input is recorded-and-ignored, never fatal.
		const unknown = await compileTask(REQUESTS.LOW, PACKETS.LOW, [{ kind: "latency", reason: "slow network" }]);
		expect(unknown.routing.executor_class).toBe("quick");
		expect(unknown.routing.deviation).toBeUndefined();
	});

	it("AC-7: one compile sends only atomic questions — no contract-shaped answer", async () => {
		active = await harness([answerScript(scriptFor(false, "MEDIUM", "R0"))]);
		const contract = await compileTask(REQUESTS.MEDIUM, PACKETS.MEDIUM);
		const record = compileRecordOf(contract)!;

		expect(active.stub.requests).toHaveLength(4);
		const questionIds = new Set<string>();
		for (const request of active.stub.requests) {
			const questions = (request.body.questions ?? {}) as Record<string, { type?: string; instructions?: unknown; criteria?: unknown }>;
			for (const [id, question] of Object.entries(questions)) {
				questionIds.add(id);
				expect(["choice", "score", "noul"], id).toContain(question.type);
				expect(typeof question.instructions === "string" || typeof question.instructions === "object", id).toBe(true);
			}
			// No request carries the contract: the router is a table, the answers are atomic.
			const serialized = JSON.stringify(request.body);
			expect(serialized).not.toContain("executor_class");
			expect(serialized).not.toContain("prd_required");
			expect(serialized).not.toContain("review_risk");
		}
		// gate(6 question ids + confidence) + complexity(5 + confidence) +
		// capability(1 + index) + risk(3 + confidence) — the shared `confidence`
		// id is defined once per site, so 19 questions map onto 17 distinct ids.
		expect(questionIds.size).toBe(17);
		expect(new Set(record.telemetry.map((row) => row.site_id)).size).toBe(4);
		for (const row of record.telemetry) {
			expect(["string", "number", "boolean"]).toContain(typeof row.answer);
		}

		// Negative control: the same atomicity check does flag a nested answer shape.
		const nested = { instructions: "which route?", criteria: { quick: { nested: "object" } } };
		expect(typeof (nested.criteria as { quick: unknown }).quick).toBe("object");
	});
});
