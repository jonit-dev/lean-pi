/**
 * PRD-022 E4 — missing-proof recovery reaches runtime evidence (AC-5).
 *
 * §40's dead end is the subject: unit tests pass, the acceptance criterion is
 * UI-observable, and the gate classifies the gap `UI_VERIFICATION_REQUIRED`. Two
 * directions are asserted. With JEV answering, one gate call records the
 * classification, the recovery round selecting `browser_test`, and the same run
 * settling on PASS with that evidence in the criterion's packet. With no JEV at
 * all, the planner's declared-surface rule selects the same verifier and the same
 * fixture reaches the same PASS — so the pass is caused by acquired evidence, not
 * by a model opinion.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactStore } from "../../src/context/artifacts.js";
import { createJevClient } from "../../src/jev/client.js";
import { criteriaOf, evaluateProofGate, MISSING_PROOF_SITE_ID, SUFFICIENCY_SITE_ID } from "../../src/proof/index.js";
import { selectRuntimeVerifiers, registerRuntimeVerifiers, setBrowserFacility } from "../../src/runtime/index.js";
import { workspaceHash } from "../../src/verify/hash.js";
import { EvidenceStore } from "../../src/verify/evidence.js";
import { answerScript } from "../compiler/helpers.js";
import { startStubJev } from "../helpers/stub-jev.js";
import { tempDir } from "../helpers/fixtures.js";
import { choiceMap, proofConfig } from "../proof/support.js";
import { artifactText, copyFixture, fakeBrowser, runtimeContract, runtimeFixture, runtimeWorkspace, staticServer, verifyRuntime, withRuntimePlan } from "./support.js";

registerRuntimeVerifiers();

const PAGE = runtimeFixture("web/index.html");
const AFFIRMATIVE = { demonstrates: "YES", contradiction: "NO", staticForRuntime: "NO", unevidencedPath: "NO" } as const;

/** The UI fixture's contract, before the session folds the planner's kinds in. */
function uiFixture(url: string, rounds: number) {
	return runtimeContract({
		required: ["targeted_test"],
		criteria: [{ id: "AC-1", verifiers: ["targeted_test", "browser_test"], scope: "web/index.html" }],
		runtime: { browser: { url, selectors: ["#app"] } },
		rounds,
	});
}

describe("AC-5 — the gate's first evaluation asks for UI verification and the recovery acquires it", () => {
	it("records UI_VERIFICATION_REQUIRED, runs the browser verifier and settles on PASS in one run", async () => {
		const root = runtimeWorkspace();
		copyFixture(runtimeFixture("web"), join(root, "web"));
		const server = await staticServer(join(root, "web"));
		const browser = fakeBrowser({ page: PAGE });
		setBrowserFacility(browser.facility);
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });
		const stub = await startStubJev([answerScript({ choices: choiceMap({ ...AFFIRMATIVE, gap: "UI_VERIFICATION_REQUIRED" }) })]);
		const jev = createJevClient({ config: proofConfig(tempDir("leanpi-gate-jev-"), "enabled", { endpoint: stub.url, apiKey: "test-key" }), cwd: root });
		const contract = uiFixture(server.url, 1);
		// The session's own step: the declared surface puts `browser_test` into the
		// required set, so the criterion's coverage can actually be satisfied.
		contract.verification.required = ["targeted_test", ...selectRuntimeVerifiers(contract, { cwd: root })];
		expect(contract.verification.required).toEqual(["targeted_test", "browser_test"]);

		const hash = workspaceHash(root, []);
		const store = new EvidenceStore();
		store.record(
			{ kind: "targeted_test", status: "pass", exitCode: 0, artifactRef: null, criterion: ["AC-1"], scope: "web/index.html" },
			hash,
		);

		try {
			const gate = await withRuntimePlan(contract, () =>
				evaluateProofGate(criteriaOf(contract), { workspaceHash: hash, changedFiles: ["web/index.html"], summary: "rendered the page" }, {
					contract,
					store,
					jev,
					cwd: root,
					artifacts,
				}),
			);

			// The first evaluation, observed rather than inferred: the gate classified
			// the criterion as missing a UI measurement before anything was run.
			expect(gate.telemetry.filter((row) => row.site_id === MISSING_PROOF_SITE_ID).map((row) => row.answer)).toEqual(["UI_VERIFICATION_REQUIRED"]);
			expect(gate.actions.map((entry) => [entry.category, entry.action.target, entry.executed, entry.round])).toEqual([
				["UI_VERIFICATION_REQUIRED", "browser_test", true, 1],
			]);
			expect(gate.attempts).toContainEqual(expect.objectContaining({ kind: "gather", target: "browser_test", status: "pass", round: 1 }));

			// The second evaluation of the same run settles on PASS with that evidence.
			expect(gate.criteria[0]!.decision).toBe("PASS");
			expect(gate.decision).toBe("PASS");
			expect(gate.telemetry.filter((row) => row.site_id === SUFFICIENCY_SITE_ID).map((row) => row.answer)).toEqual(["MISSING_PROOF", "PASS"]);
			expect(gate.criteria[0]!.packet.evidence).toContainEqual({ kind: "browser_test", status: "pass", scope: "web/index.html", exitCode: null });

			// The record is PRD-009's, produced by the registered verifier, and its
			// artifact is the trace of the real navigation.
			const produced = store.current(hash).find((entry) => entry.kind === "browser_test");
			expect(produced?.status).toBe("pass");
			expect(produced?.criterion).toEqual(["AC-1"]);
			expect(artifactText(artifacts, produced!.artifactRef!)).toContain(server.url);
			expect(browser.visited).toEqual([server.url]);
		} finally {
			await stub.close();
			setBrowserFacility(undefined);
			await server.close();
		}
	});

	it("acquires the same evidence with JEV disabled, through the deterministic selection rule", async () => {
		const root = runtimeWorkspace();
		copyFixture(runtimeFixture("web"), join(root, "web"));
		const server = await staticServer(join(root, "web"));
		const browser = fakeBrowser({ page: PAGE });
		setBrowserFacility(browser.facility);
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });
		const contract = uiFixture(server.url, 0);
		const hash = workspaceHash(root, []);
		const store = new EvidenceStore();
		store.record({ kind: "targeted_test", status: "pass", exitCode: 0, artifactRef: null, criterion: ["AC-1"], scope: "web/index.html" }, hash);

		try {
			// No JEV anywhere in this test: the surface alone selects the verifier.
			const selected = selectRuntimeVerifiers(contract, { cwd: root });
			expect(selected).toEqual(["browser_test"]);
			contract.verification.required = ["targeted_test", ...selected];
			// The criterion's own test is real in the session, not in a spec; the
			// command seam keeps this run to the verifier under test.
			const commands = { targeted_test: "true" };

			// First evaluation: the gate names the gap.
			const first = await withRuntimePlan(contract, () =>
				evaluateProofGate(criteriaOf(contract), { workspaceHash: hash, changedFiles: ["web/index.html"] }, { contract, store, cwd: root, artifacts, commands }),
			);
			expect(first.criteria[0]!.gap.category).toBe("UI_VERIFICATION_REQUIRED");
			expect(first.decision).toBe("BLOCKED");
			expect(first.criteria[0]!.decision).not.toBe("PASS");

			// The recovery the session runs: the selected kind, verified for real.
			const verified = await verifyRuntime(contract, root, { artifacts, store, commands });
			expect(verified.records.find((entry) => entry.kind === "browser_test")?.status).toBe("pass");

			// Second evaluation: PASS, with browser evidence in the packet.
			const second = await withRuntimePlan(contract, () =>
				evaluateProofGate(criteriaOf(contract), { workspaceHash: hash, changedFiles: ["web/index.html"] }, { contract, store, cwd: root, artifacts, commands }),
			);
			expect(second.decision).toBe("PASS");
			expect(second.criteria[0]!.packet.evidence).toContainEqual({ kind: "browser_test", status: "pass", scope: "web/index.html", exitCode: null });
			// The two packets are different objects, so the pass is not the first
			// evaluation's packet re-read.
			const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
			expect(digest(second.criteria[0]!.packet)).not.toBe(digest(first.criteria[0]!.packet));
		} finally {
			setBrowserFacility(undefined);
			await server.close();
		}
	});
});
