/**
 * E1 (AC-2, AC-3): the two evidence channels and the freshness stamp.
 *
 * The controls that matter: the pre-edit read must report the record as fresh,
 * or the post-edit stale assertion would pass vacuously; and a claim must be
 * absent from every record field, not merely present under `assertions`.
 */
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactStore } from "../../src/context/artifacts.js";
import { aggregate } from "../../src/verify/aggregate.js";
import { EvidenceStore } from "../../src/verify/evidence.js";
import { workspaceHash } from "../../src/verify/hash.js";
import { verifyTask } from "../../src/verify/index.js";
import { contractOf, recordingExec, tempWorkspace, writeFiles } from "./support.js";

describe("workspaceHash", () => {
	it("is deterministic and content-based, not mtime-based", () => {
		const root = tempWorkspace();
		writeFiles(root, { "src/a.ts": "export const a = 1;\n" });

		const before = workspaceHash(root, ["src/a.ts"]);
		expect(workspaceHash(root, ["src/a.ts"])).toBe(before);

		// Rewriting the same bytes with a different mtime is the same workspace state.
		const past = new Date(2020, 0, 1);
		utimesSync(join(root, "src/a.ts"), past, past);
		expect(workspaceHash(root, ["src/a.ts"])).toBe(before);

		writeFiles(root, { "src/a.ts": "export const a = 2;\n" });
		expect(workspaceHash(root, ["src/a.ts"])).not.toBe(before);

		// A missing path is part of the hashed state, never a thrown error.
		expect(workspaceHash(root, ["src/absent.ts"])).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("EvidenceStore freshness (AC-3)", () => {
	it("reports a record as stale after an edit and drops the aggregate without re-running", () => {
		const root = tempWorkspace();
		writeFiles(root, { "src/a.ts": "export const a = 1;\n" });
		const store = new EvidenceStore();
		const before = workspaceHash(root, ["src/a.ts"]);
		const recorded = store.record(
			{ kind: "typecheck", status: "pass", exitCode: 0, artifactRef: null, criterion: ["AC-1"], scope: "src/**/*.ts" },
			before,
		);

		// Control: the pre-edit read is fresh, so the stale result below is not vacuous.
		const fresh = store.view(workspaceHash(root, ["src/a.ts"]));
		expect(fresh.records).toHaveLength(1);
		expect(fresh.staleRecords).toHaveLength(0);
		expect(aggregate(fresh.records, fresh.staleRecords)).toBe("pass");

		writeFiles(root, { "src/a.ts": "export const a = 2;\n" });
		const after = store.view(workspaceHash(root, ["src/a.ts"]));
		expect(after.records).toHaveLength(0);
		expect(after.staleRecords).toEqual([recorded]);
		expect(aggregate(after.records, after.staleRecords)).toBe("deterministic_failure");

		// The verifier was never re-run: the store still holds exactly the one record.
		expect(store.forCriterion("AC-1")).toEqual([recorded]);
	});
});

describe("measurements versus claims (AC-2)", () => {
	it("keeps an executor's claim out of the deterministic channel and out of the aggregate", async () => {
		const root = tempWorkspace();
		writeFiles(root, { "src/a.ts": "export const a = 1;\n" });
		const session = tempWorkspace();
		const artifacts = createArtifactStore({ sessionDir: session });
		const control = recordingExec();

		const result = await verifyTask(contractOf({ required: ["typecheck", "affected_tests"] }), root, {
			exec: control.exec,
			artifacts,
			touchedPaths: ["src/a.ts"],
			assertions: [{ source: "executor", text: "tests pass" }],
		});

		// The mandatory test verifier produced a record, and it is not a pass.
		const testRecord = result.records.find((record) => record.kind === "targeted_test");
		expect(testRecord?.status).toBe("not_run");
		expect(result.records.some((record) => record.status === "pass" && record.kind.includes("test"))).toBe(false);
		expect(result.records.some((record) => record.kind === "typecheck" && record.status === "pass")).toBe(true);
		expect(control.commands).not.toContain("npm test");

		// The claim is readable under assertions only — no record field carries it.
		expect(result.assertions.map((assertion) => assertion.text)).toEqual(["tests pass"]);
		expect(JSON.stringify(result.records)).not.toContain("tests pass");

		// An absent check is a recorded gap, never an inferred pass.
		expect(result.status).toBe("incomplete");
		const ref = testRecord?.artifactRef;
		expect(ref).toBeTruthy();
		expect(artifacts.expand(ref!).toString("utf8")).toContain("no command resolved for targeted_test");
	});
});

describe("attempt isolation", () => {
	it("scopes a reused store's verdict to the run that produced it", async () => {
		const root = tempWorkspace();
		writeFiles(root, { "src/a.ts": "export const a = 1;\n" });
		const store = new EvidenceStore();
		const contract = contractOf({ required: ["typecheck"], criteria: [{ id: "AC-1", verifiers: ["typecheck"] }] });

		const failing = await verifyTask(contract, root, {
			store,
			exec: recordingExec((command) => (command === "npm run typecheck" ? { exitCode: 1 } : undefined)).exec,
			touchedPaths: ["src/a.ts"],
		});
		expect(failing.status).toBe("deterministic_failure");

		const retry = await verifyTask(contract, root, { store, exec: recordingExec().exec, touchedPaths: ["src/a.ts"] });
		expect(retry.records).toHaveLength(2);
		expect(retry.status).toBe("pass");
		// Each attempt contributed one typecheck record attributed to AC-1; both are
		// still queryable, while the retry's verdict counted only its own two.
		expect(store.forCriterion("AC-1")).toHaveLength(2);
	});
});
