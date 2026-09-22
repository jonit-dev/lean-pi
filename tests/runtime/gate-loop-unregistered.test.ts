/**
 * PRD-022 E4, negative control — a UI gap with no registered browser verifier
 * must end BLOCKED, never PASS (AC-5).
 *
 * This file deliberately never calls `registerRuntimeVerifiers()`, which is the
 * only state in which the verifier map lacks `browser_test`: the same fixture
 * that reaches PASS next door must fail closed here, proving the pass is caused
 * by the evidence the verifier acquired rather than by the gate's disposition.
 * Vitest forks one process per file, so nothing from the other spec can register
 * a runner into this one.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactStore } from "../../src/context/artifacts.js";
import { criteriaOf, evaluateProofGate } from "../../src/proof/index.js";
import { selectRuntimeVerifiers } from "../../src/runtime/index.js";
import { workspaceHash } from "../../src/verify/hash.js";
import { EvidenceStore } from "../../src/verify/evidence.js";
import { tempDir } from "../helpers/fixtures.js";
import { artifactText, copyFixture, runtimeContract, runtimeFixture, runtimeWorkspace, staticServer, withRuntimePlan } from "./support.js";

describe("AC-5 — an unregistered runtime verifier leaves the gap open", () => {
	it("ends BLOCKED rather than PASS, naming the missing registration", async () => {
		const root = runtimeWorkspace();
		copyFixture(runtimeFixture("web"), join(root, "web"));
		const server = await staticServer(join(root, "web"));
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });
		const contract = runtimeContract({
			required: ["targeted_test"],
			criteria: [{ id: "AC-1", verifiers: ["targeted_test", "browser_test"], scope: "web/index.html" }],
			runtime: { browser: { url: server.url, selectors: ["#app"] } },
			rounds: 1,
		});
		contract.verification.required = ["targeted_test", ...selectRuntimeVerifiers(contract)];
		const hash = workspaceHash(root, []);

		try {
			const store = new EvidenceStore();
			store.record({ kind: "targeted_test", status: "pass", exitCode: 0, artifactRef: null, criterion: ["AC-1"], scope: "web/index.html" }, hash);

			const gate = await withRuntimePlan(contract, () =>
				evaluateProofGate(criteriaOf(contract), { workspaceHash: hash, changedFiles: ["web/index.html"] }, { contract, store, cwd: root, artifacts }),
			);

			expect(gate.decision).toBe("BLOCKED");
			expect(gate.decision).not.toBe("PASS");
			expect(gate.criteria[0]!.decision).not.toBe("PASS");

			// The round did happen and produced a record — a `not_run` one, whose
			// artifact names the missing registration rather than a UI defect.
			const record = store.current(hash).find((entry) => entry.kind === "browser_test");
			expect(record?.status).toBe("not_run");
			expect(artifactText(artifacts, record!.artifactRef!)).toContain('no verifier registered for kind "browser_test"');
			// The gate sees an unrun check, so the criterion's coverage stays short and
			// no amount of looping can turn it into a pass.
			expect(gate.criteria[0]!.packet.evidence).toContainEqual({ kind: "browser_test", status: "not_run", scope: "web/index.html", exitCode: null });
			expect(gate.criteria[0]!.coverage.satisfied).toBe(false);
			expect(gate.criteria[0]!.coverage.unsatisfied).toEqual(["browser_test"]);
		} finally {
			await server.close();
		}
	});
});
