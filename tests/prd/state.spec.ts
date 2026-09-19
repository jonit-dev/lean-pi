/**
 * PRD-012 Phase 2 / AC-2, AC-5, AC-6 — criterion status, the satisfaction
 * decision and reopen.
 */
import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../src/commands/registry.js";
import { createJevClient } from "../../src/jev/client.js";
import { getSite } from "../../src/jev/registry.js";
import { registerPrdCommands } from "../../src/prd/commands.js";
import {
	createPrdManager,
	PRD_CRITERION_QUESTION_ID,
	PRD_CRITERION_SITE_ID,
	registerPrdCriterionSite,
	type PrdManager,
} from "../../src/prd/manager.js";
import { criterionOf, readPrdState, type PrdState } from "../../src/prd/state.js";
import type { EvidenceRecord } from "../../src/verify/evidence.js";
import { fixtureRepo } from "../helpers/fixtures.js";
import { startStubJev } from "../helpers/stub-jev.js";
import {
	AC1_COMMAND,
	AC2_COMMAND,
	AC3_COMMAND,
	artifactStoreFor,
	failingEvidence,
	freshPass,
	HASH_AT_READ,
	prdConfig,
	prdRecord,
	stalePass,
	stagedPrd,
} from "./helpers.js";

const HASH = HASH_AT_READ;

interface Fixture {
	cwd: string;
	agentDir: string;
	state: PrdState;
	manager: PrdManager;
}

/** A fixture PRD with one manager; a JEV endpoint enables the decision site. */
async function setUp(options: { jevEndpoint?: string; minCodingIndex?: number } = {}): Promise<Fixture> {
	const { cwd, agentDir } = fixtureRepo();
	const artifactStore = artifactStoreFor(agentDir);
	const { state } = stagedPrd(cwd, { artifactStore, minCodingIndex: options.minCodingIndex });
	const { contract } = await prdRecord(cwd);
	const jev =
		options.jevEndpoint === undefined
			? undefined
			: createJevClient({
					config: prdConfig(cwd, { jev: { mode: "enabled", endpoint: options.jevEndpoint, apiKey: "test-key" } }),
					cwd,
				});
	const manager = createPrdManager({
		contract,
		config: prdConfig(cwd),
		cwd,
		artifactStore,
		state,
		jev,
		hashWorkspace: () => HASH,
	});
	return { cwd, agentDir, state, manager };
}

function statusOf(text: string, criterionId: string): string[] {
	return text.split("\n").filter((line) => line.startsWith(`${criterionId} `));
}

describe("PRD-012 Phase 2 — criterion status", () => {
	it("AC-2: evidence for one criterion shows it VERIFIED while its siblings stay PENDING with per-criterion references", async () => {
		const { cwd, agentDir, manager } = await setUp();
		const record = await manager.applyEvidence("AC-1", [freshPass("AC-1", HASH, "artifact://evidence/ac-1")], [AC1_COMMAND]);
		expect(record.status).toBe("VERIFIED");
		expect(record.evidenceRef).toBe("artifact://evidence/ac-1");

		const registry = createCommandRegistry();
		registerPrdCommands(registry, { cwd, config: prdConfig(cwd), artifactStore: artifactStoreFor(agentDir) });
		const result = await registry.dispatch("/prd status", { cwd });

		expect(result.ok).toBe(true);
		expect(statusOf(result.text, "AC-1")[0]).toContain("VERIFIED");
		expect(statusOf(result.text, "AC-2")[0]).toContain("PENDING");
		expect(statusOf(result.text, "AC-3")[0]).toContain("PENDING");
		expect(statusOf(result.text, "AC-1")[0]).toContain("evidence: artifact://evidence/ac-1");
		expect(result.text.split("\n").filter((line) => line.includes("evidence: none"))).toHaveLength(2);
	});

	it("AC-5: a SATISFIED answer verifies and dispatches on; an INSUFFICIENT_EVIDENCE answer re-dispatches the same unit", async () => {
		const satisfied = await startStubJev([
			() => ({
				answers: { [PRD_CRITERION_QUESTION_ID]: { type: "choice", choice: "SATISFIED", probabilities: {}, confidence: 0.95 } },
			}),
		]);
		try {
			const { state, manager } = await setUp({ jevEndpoint: satisfied.url });
			const record = await manager.applyEvidence("AC-1", []);

			expect(record.status).toBe("VERIFIED");
			expect(manager.nextUnit()?.id).toBe("unit-2");
			expect(state.units[1]!.dependsOn).toEqual(["unit-1"]);

			// One question per criterion, never batched, and it names the criterion.
			expect(satisfied.requests).toHaveLength(1);
			const asked = satisfied.requests[0]!.body.questions as Record<string, { instructions: string }>;
			expect(Object.keys(asked)).toEqual([PRD_CRITERION_QUESTION_ID]);
			expect(asked[PRD_CRITERION_QUESTION_ID]!.instructions).toContain("Plan the cache layout");
		} finally {
			await satisfied.close();
		}

		const insufficient = await startStubJev([
			() => ({
				answers: {
					[PRD_CRITERION_QUESTION_ID]: { type: "choice", choice: "INSUFFICIENT_EVIDENCE", probabilities: {}, confidence: 0.95 },
				},
			}),
		]);
		try {
			const { manager } = await setUp({ jevEndpoint: insufficient.url });
			// The deterministic rule would verify this record; JEV says otherwise.
			const record = await manager.applyEvidence("AC-1", [freshPass("AC-1", HASH, "artifact://evidence/ac-1")], [AC1_COMMAND]);
			expect(record.status).toBe("PENDING");
			expect(record.reason).toBe("jev: INSUFFICIENT_EVIDENCE");
			expect(manager.nextUnit()?.id).toBe("unit-1");
		} finally {
			await insufficient.close();
		}
	});

	it("AC-5: with JEV disabled only a fresh passing record for the criterion's own command verifies", async () => {
		const { cwd, manager } = await setUp();

		const verified = await manager.applyEvidence("AC-1", [freshPass("AC-1", HASH, "artifact://evidence/ac-1")], [AC1_COMMAND]);
		expect(verified.status).toBe("VERIFIED");

		// Negative control: the same record with a stale workspace hash stays PENDING.
		const stale = await manager.applyEvidence("AC-3", [stalePass("AC-3", "artifact://evidence/ac-3-stale")], [AC3_COMMAND]);
		expect(stale.status).toBe("PENDING");
		expect(stale.reason).toBe("records present but none fresh and passing for the criterion's command");

		// …and so does a fresh record collected for a different command.
		const mismatch = await manager.applyEvidence("AC-2", [freshPass("AC-2", HASH, "artifact://evidence/ac-1")], [AC1_COMMAND]);
		expect(mismatch.status).toBe("PENDING");

		// The session still progresses with JEV off.
		expect(manager.dispatch()?.unit.id).toBe("unit-2");
		expect(readPrdState(cwd)!.criteria.find((criterion) => criterion.id === "AC-2")!.status).toBe("PENDING");

		// With no command list, the record's own attribution is required.
		const unattributed = await manager.applyEvidence("AC-1", [freshPass("AC-3", HASH, "artifact://evidence/ac-3")]);
		expect(unattributed.status).toBe("PENDING");
	});

	it("AC-5: the registered site is high-consequence and its fallback never loosens the deterministic rule", async () => {
		registerPrdCriterionSite();
		const site = getSite(PRD_CRITERION_SITE_ID);
		expect(site.telemetryTag).toBe(PRD_CRITERION_SITE_ID);
		expect(site.consequence).toBe("high");
		expect(site.returnType).toEqual(["Choice"]);

		const answered = site.fallback({
			siteId: PRD_CRITERION_SITE_ID,
			reason: "no-credential",
			questions: [{ id: PRD_CRITERION_QUESTION_ID, kind: "Choice", text: "Does the evidence satisfy?", options: {} }],
			state: { freshPassing: false },
		});
		expect(answered).toEqual([
			{ kind: "Choice", questionId: PRD_CRITERION_QUESTION_ID, choice: "INSUFFICIENT_EVIDENCE", probabilities: {}, confidence: 1 },
		]);
	});

	it("AC-6: a failing record reopens a verified criterion and re-queues its unit next", async () => {
		const { cwd, agentDir, manager, state } = await setUp();
		await manager.applyEvidence("AC-1", [freshPass("AC-1", HASH, "artifact://evidence/ac-1")], [AC1_COMMAND]);
		expect(criterionOf(state, "AC-1")!.status).toBe("VERIFIED");

		const failing: EvidenceRecord = failingEvidence("AC-1", "artifact://evidence/ac-1-failing");
		const reopened = await manager.applyEvidence("AC-1", [failing], [AC1_COMMAND]);

		expect(reopened.status).toBe("REOPENED");
		expect(reopened.evidenceRef).toBe("artifact://evidence/ac-1-failing");
		expect(manager.nextUnit()?.id).toBe("unit-1");

		const registry = createCommandRegistry();
		registerPrdCommands(registry, { cwd, config: prdConfig(cwd), artifactStore: artifactStoreFor(agentDir) });
		const result = await registry.dispatch("/prd status", { cwd });
		expect(statusOf(result.text, "AC-1")[0]).toContain("REOPENED");
	});

	it("AC-2/AC-6: status is persisted, so a second read of the store agrees with the manager", async () => {
		const { cwd, manager } = await setUp();
		await manager.applyEvidence("AC-2", [freshPass("AC-2", HASH, "artifact://evidence/ac-2")], [AC2_COMMAND]);
		const persisted = readPrdState(cwd)!;
		expect(persisted.criteria.map((criterion) => `${criterion.id}:${criterion.status}`)).toEqual([
			"AC-1:PENDING",
			"AC-2:VERIFIED",
			"AC-3:PENDING",
		]);
	});
});
