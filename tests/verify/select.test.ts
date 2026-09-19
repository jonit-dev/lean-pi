/**
 * E2 (AC-1, AC-4, AC-6, AC-8): requirement-driven selection and execution.
 *
 * The executed command list is asserted alongside the selected kind set, so a
 * verifier that is selected but never run cannot pass the test; the JEV pair
 * (scripted answer vs disabled) is the differential control that the answer is
 * actually consumed; and the empty criterion set is the control that attribution
 * never defaults to "all criteria".
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactStore } from "../../src/context/artifacts.js";
import { createJevClient } from "../../src/jev/client.js";
import { createDecisionLog, decisionLogPath, readDecisions } from "../../src/jev/log.js";
import type { RegressionScope } from "../../src/verify/select.js";
import { EvidenceStore } from "../../src/verify/evidence.js";
import { verifyTask } from "../../src/verify/index.js";
import { contractOf, gitInit, recordingExec, stubConfig, tempWorkspace, writeFiles, TSC } from "./support.js";

const BUGFIX_CRITERIA = [{ id: "AC-1", verifiers: ["typecheck", "affected_tests"], scope: "tests/verify/*.test.ts" }];

/** The wire answer both atomic questions receive, at a confidence the site accepts. */
function wireAnswers(choice: RegressionScope): Record<string, unknown> {
	const answer = { type: "choice", choice, probabilities: { [choice]: 0.95 }, confidence: 0.95 };
	return { "regression_scope.coverage": answer, "regression_scope.contract_change": answer };
}

describe("selection and execution (AC-1, AC-4)", () => {
	it("records a failing typecheck with a non-zero exit and a deterministic_failure aggregate", async () => {
		const root = tempWorkspace();
		gitInit(root);
		writeFiles(root, { "src/bad.ts": "export const bad: number = 'not a number';\n" });

		const result = await verifyTask(contractOf({ required: ["typecheck"] }), root, {
			commands: { typecheck: `${TSC} --noEmit --strict src/bad.ts` },
			touchedPaths: ["src/bad.ts"],
			timeoutMs: 60_000,
		});

		const record = result.records.find((entry) => entry.kind === "typecheck");
		expect(record?.status).toBe("fail");
		expect(record?.exitCode).toBeGreaterThan(0);
		expect(result.staleRecords).toHaveLength(0);
		expect(result.status).toBe("deterministic_failure");
	});

	it("selects and runs different verifier sets for a narrow bugfix and a broad refactor", async () => {
		const root = tempWorkspace();
		writeFiles(root, { "src/a.ts": "export const a = 1;\n" });

		const narrow = recordingExec();
		const bugfix = await verifyTask(
			contractOf({ required: ["typecheck", "affected_tests"], criteria: BUGFIX_CRITERIA }),
			root,
			{ exec: narrow.exec, touchedPaths: ["src/a.ts"], diff: { files: ["src/a.ts"] } },
		);
		expect([...bugfix.records.map((record) => record.kind)].sort()).toEqual(["git_status", "targeted_test", "typecheck"]);
		expect(bugfix.commands).toEqual(["npm run typecheck", "npx vitest run tests/verify/*.test.ts", "git status --porcelain"]);
		expect(bugfix.commands).not.toContain("npm test");

		const broad = recordingExec();
		const refactor = await verifyTask(
			contractOf({ required: ["typecheck", "affected_tests", "full_suite"], criteria: BUGFIX_CRITERIA }, "refactor"),
			root,
			{ exec: broad.exec, touchedPaths: ["src/a.ts"], diff: { files: ["src/a.ts"] } },
		);
		expect(refactor.records.map((record) => record.kind)).toContain("full_suite");
		expect(broad.commands).toContain("npm test");
	});
});

describe("per-criterion attribution (AC-8)", () => {
	it("attributes each record only to the criteria that declared it", async () => {
		const root = tempWorkspace();
		writeFiles(root, { "src/a.ts": "export const a = 1;\n" });
		const store = new EvidenceStore();
		const control = recordingExec();

		await verifyTask(
			contractOf({
				required: ["typecheck", "affected_tests"],
				criteria: [
					{ id: "AC-1", verifiers: ["typecheck", "affected_tests"], scope: "tests/verify/*.test.ts" },
					{ id: "AC-2", verifiers: ["typecheck"] },
					{ id: "AC-3", verifiers: [] },
				],
			}),
			root,
			{ store, exec: control.exec, touchedPaths: ["src/a.ts"] },
		);

		const first = store.forCriterion("AC-1").map((record) => record.kind).sort();
		const second = store.forCriterion("AC-2").map((record) => record.kind);
		expect(first).toEqual(["targeted_test", "typecheck"]);
		expect(second).toEqual(["typecheck"]);
		expect(first).not.toEqual(second);
		// The criterion with no declared verifier receives no records at all.
		expect(store.forCriterion("AC-3")).toEqual([]);

		// The shared typecheck carries both ids because the block declared it so.
		const shared = store.forCriterion("AC-1").find((record) => record.kind === "typecheck");
		expect([...shared!.criterion].sort()).toEqual(["AC-1", "AC-2"]);
		expect(shared!.scope).toBe("src/**/*.ts");

		// The §8 alias resolved to a real run, not a not_run gap.
		const targeted = store.forCriterion("AC-1").find((record) => record.kind === "targeted_test");
		expect(targeted?.status).toBe("pass");
		expect(targeted?.scope).toBe("tests/verify/*.test.ts");
	});
});

describe("regression-scope decision (AC-6)", () => {
	it("widens to the full suite on a JEV answer, and runs the targeted set with a fallback row when JEV is off", async () => {
		const root = tempWorkspace();
		writeFiles(root, { "src/a.ts": "export const a = 1;\n" });
		const contract = contractOf({ required: ["typecheck", "affected_tests"], criteria: BUGFIX_CRITERIA });
		// The rule alone scopes this diff as targeted-only.
		const diff = { files: ["src/a.ts"] };
		const log = createDecisionLog(decisionLogPath(root));

		const enabled = createJevClient({
			config: stubConfig(root, "enabled"),
			cwd: root,
			log,
			credential: () => ({ key: "sk-test", source: "config" }),
			transport: async () => ({
				status: 200,
				text: JSON.stringify({ model: "jev-stub", answers: wireAnswers("BROADER_SUITE_REQUIRED"), usage: { input_tokens: 120, output_tokens: 8 } }),
			}),
		});
		const widened = recordingExec();
		const withJev = await verifyTask(contract, root, { jev: enabled, exec: widened.exec, touchedPaths: ["src/a.ts"], diff });
		expect(withJev.commands).toContain("npm test");
		expect(withJev.records.map((record) => record.kind)).toContain("full_suite");
		expect(withJev.regressionScope).toBe("BROADER_SUITE_REQUIRED");

		const disabled = createJevClient({ config: stubConfig(root, "disabled"), cwd: root, log, credential: () => ({ key: "sk-test", source: "config" }) });
		const targetedOnly = recordingExec();
		const withoutJev = await verifyTask(contract, root, { jev: disabled, exec: targetedOnly.exec, touchedPaths: ["src/a.ts"], diff });
		expect(withoutJev.commands).not.toContain("npm test");
		expect(withoutJev.records.map((record) => record.kind)).not.toContain("full_suite");
		expect(withoutJev.regressionScope).toBe("TARGETED_SUFFICIENT");

		const rows = readDecisions(root).filter((row) => row.siteId === "verify.regression_scope");
		expect(rows.map((row) => row.fallbackUsed)).toEqual([false, true]);
		expect(rows[1]!.reason).toBe("privacy-mode-disabled");
		expect(rows[1]!.telemetryTag).toBe("verify/regression_scope");
	});

	it("widens on its own for a diff the deterministic rule scopes as broad", async () => {
		const root = tempWorkspace();
		writeFiles(root, { "src/a.ts": "export const a = 1;\n" });
		const control = recordingExec();

		const result = await verifyTask(contractOf({ required: ["typecheck", "affected_tests"], criteria: BUGFIX_CRITERIA }), root, {
			exec: control.exec,
			touchedPaths: ["src/a.ts"],
			diff: { files: ["src/a.ts", "package.json"] },
		});

		expect(result.regressionScope).toBe("BROADER_SUITE_REQUIRED");
		expect(control.commands).toContain("npm test");
	});
});

describe("missing tooling", () => {
	it("records an unsupported contract kind as not_run instead of omitting it", async () => {
		const root = tempWorkspace();
		const artifacts = createArtifactStore({ sessionDir: join(root, "session") });
		const control = recordingExec();
		const result = await verifyTask(contractOf({ required: ["typecheck", "benchmark"] }), root, {
			exec: control.exec,
			artifacts,
			touchedPaths: [],
		});

		const gap = result.records.find((record) => record.kind === "benchmark");
		expect(gap?.status).toBe("not_run");
		expect(artifacts.expand(gap!.artifactRef!).toString("utf8")).toBe('unsupported verifier kind "benchmark"');
		expect(result.records.map((record) => record.kind)).toContain("typecheck");
		expect(result.status).toBe("incomplete");
	});

	it("records a canonical kind with no registered verifier as not_run with its reason", async () => {
		const root = tempWorkspace();
		const artifacts = createArtifactStore({ sessionDir: join(root, "session") });
		const control = recordingExec();
		const result = await verifyTask(contractOf({ required: ["browser_test"] }), root, {
			exec: control.exec,
			artifacts,
			touchedPaths: [],
		});

		const gap = result.records.find((record) => record.kind === "browser_test");
		expect(gap?.status).toBe("not_run");
		expect(result.status).toBe("incomplete");
		expect(artifacts.expand(gap!.artifactRef!).toString("utf8")).toContain('no verifier registered for kind "browser_test"');
	});
});
