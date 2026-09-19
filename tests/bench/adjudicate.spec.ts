/**
 * PRD-021 AC-5 — independent adjudication, and the false completion rate it makes real.
 *
 * The point of the fixture is the *disagreement*: an attempt that reports success
 * while the held-out golden fails must move the reported rate and name the task.
 * A run where the adjudicator simply echoed LeanPi's own claim would read 0 here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../../src/index.js";
import { runBench } from "../../src/bench/runner.js";
import { BenchError } from "../../src/bench/types.js";
import type { BenchAttemptResult } from "../../src/bench/types.js";
import { fixtureConfig, fixtureConfigRow, fixtureSuite, preparedWorkspaces, scriptedJudge, stubExecutor, tempDir } from "./helpers.js";

async function runFixtureSuite(options: { root: string; runId: string; claims: (taskId: string) => boolean; judged?: boolean; reviewerModel?: string; rubricCollision?: boolean }) {
	const suiteDir = fixtureSuite(options.root);
	const configDir = fixtureConfigRow(options.root, { id: "fixture-row" });
	const executor = stubExecutor(
		{ completes: () => true, cost: () => 0.01, reported_success: (task) => options.claims(task.id) },
		options.reviewerModel ?? "gemini-2.5-flash",
	);
	const config = fixtureConfig(options.root);
	return runBench({
		cwd: PACKAGE_ROOT,
		// The rubric role must resolve to a model distinct from the reviewer's.
		config: options.rubricCollision
			? { ...config, capability: { ...config.capability, roles: { strong: { pin: "gemini-2.5-flash" } } } }
			: config,
		suiteDir,
		configDir,
		configIds: ["fixture-row"],
		runId: options.runId,
		outDir: join(options.root, "out"),
		prepare: preparedWorkspaces(options.root).prepare,
		execute: executor,
		...(options.judged ? { rubricJudge: scriptedJudge(true) } : {}),
		now: () => new Date("2026-09-19T00:00:00.000Z"),
	});
}

describe("PRD-021 AC-5 — adjudication is independent and it bites", () => {
	it("reports a non-zero false completion rate naming the task the golden rejected", async () => {
		const root = tempDir();
		const run = await runFixtureSuite({ root, runId: "ac5-bites", claims: (taskId) => taskId !== "rubric-task", judged: true });
		const row = run.report.configs[0];
		expect(row?.reported_successes).toBe(2);
		expect(row?.false_completion_rate).toBeCloseTo(0.5, 10);
		expect(row?.false_completion_tasks).toEqual(["golden-fails"]);
		const golden = run.ledger.find((attempt) => attempt.task_id === "golden-fails");
		expect(golden?.adjudication.verdict).toBe("incomplete");
		expect(golden?.adjudication.adjudicator).toContain("never-written-marker");
		expect(golden?.reported_success).toBe(true);
		expect(readFileSync(run.report_path, "utf8")).toContain("tasks: golden-fails");
	});

	it("reports zero when the attempt's claim matches the golden", async () => {
		const root = tempDir();
		const run = await runFixtureSuite({ root, runId: "ac5-agrees", claims: (taskId) => taskId === "golden-passes", judged: true });
		const row = run.report.configs[0];
		expect(row?.reported_successes).toBe(1);
		expect(row?.false_completion_rate).toBe(0);
		expect(row?.false_completion_tasks).toEqual([]);
	});

	it("records the adjudicator's identity, and refuses a rubric judge that is the attempt's reviewer", async () => {
		const root = tempDir();
		const run = await runFixtureSuite({ root, runId: "ac5-identity", claims: () => true, judged: true });
		const rubric = run.ledger.find((attempt) => attempt.task_id === "rubric-task");
		expect(rubric?.adjudication.kind).toBe("rubric");
		// PRD-024's ranking decides the rubric role's model; what AC-5 requires is
		// that the identity is *recorded* and differs from the attempt's reviewer.
		expect(rubric?.adjudication.rubric_model).toBeTruthy();
		expect(rubric?.adjudication.reviewer_model).toBe("gemini-2.5-flash");
		expect(rubric?.adjudication.rubric_model).not.toBe(rubric?.adjudication.reviewer_model);
		expect(rubric?.adjudication.verdict).toBe("complete");
		const golden = run.ledger.find((attempt) => attempt.task_id === "golden-passes");
		expect(golden?.adjudication.adjudicator).toBe("test -f bench-done-marker");
		expect(golden?.adjudication.rubric_model).toBeNull();

		const collisionRoot = tempDir();
		const collision = await runFixtureSuite({ root: collisionRoot, runId: "ac5-collision", claims: () => true, judged: true, rubricCollision: true });
		const refused = collision.ledger.find((attempt) => attempt.task_id === "rubric-task");
		expect(refused?.adjudication.verdict).toBe("error");
		expect(refused?.adjudication.reason).toContain("self-comparison");
		expect(collision.report.configs[0]?.adjudication_errors).toBe(1);
	});

	it("has no path from the adjudicator into LeanPi's own proof gate", () => {
		const source = readFileSync(join(PACKAGE_ROOT, "src", "bench", "adjudicate.ts"), "utf8");
		const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] as string);
		expect(imports.length).toBeGreaterThan(0);
		expect(imports.filter((specifier) => /(^|\/)proof(\/|$|\.js)/.test(specifier))).toEqual([]);
		// The runner's adjudication call site is the only one, and it passes no gate.
		expect(source).not.toContain("evaluateProofGate");
	});

	it("is an error — never a pass — when no rubric judge is available", async () => {
		const root = tempDir();
		const run = await runFixtureSuite({ root, runId: "ac5-no-judge", claims: () => false });
		const rubric = run.ledger.find((attempt) => attempt.task_id === "rubric-task");
		expect(rubric?.adjudication.verdict).toBe("error");
		expect(rubric?.adjudication.reason).toContain("no rubric judge");
	});

	it("fails the run loudly when an attempt wrote no §52 record", async () => {
		const root = tempDir();
		const suiteDir = fixtureSuite(root);
		const configDir = fixtureConfigRow(root, { id: "fixture-row" });
		await expect(
			runBench({
				cwd: PACKAGE_ROOT,
				config: fixtureConfig(root),
				suiteDir,
				configDir,
				configIds: ["fixture-row"],
				runId: "ac5-no-record",
				outDir: join(root, "out"),
				prepare: preparedWorkspaces(root).prepare,
				execute: async (): Promise<BenchAttemptResult> => ({ extensions: [], operator: "scripted", subscription_usage: 0, note: null }),
			}),
		).rejects.toBeInstanceOf(BenchError);
	});
});
