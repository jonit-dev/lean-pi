/**
 * PRD-012 Phase 3 / AC-3, AC-4, AC-9 — work units, dependency gating, scoped
 * context and the derived goal descriptor.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveGoal } from "../../src/prd/goal.js";
import { createPrdManager, EXECUTOR_PACKET_KEYS } from "../../src/prd/manager.js";
import { readPrdState } from "../../src/prd/state.js";
import type { EvidenceRecord } from "../../src/verify/evidence.js";
import { fixtureRepo, tempDir } from "../helpers/fixtures.js";
import {
	AC1_COMMAND,
	AC2_COMMAND,
	artifactStoreFor,
	failingEvidence,
	FIXTURE_PRD_BODY,
	freshPass,
	HASH_AT_READ,
	MARKERS,
	prdConfig,
	prdRecord,
	stagedPrd,
	writeInstalledSkill,
} from "./helpers.js";

const HASH = HASH_AT_READ;

async function lane(options: { minCodingIndex?: number } = {}) {
	const { cwd, agentDir } = fixtureRepo();
	const artifactStore = artifactStoreFor(agentDir);
	const { state } = stagedPrd(cwd, { artifactStore, minCodingIndex: options.minCodingIndex });
	const { contract } = await prdRecord(cwd);
	const manager = createPrdManager({
		contract,
		config: prdConfig(cwd),
		cwd,
		artifactStore,
		state,
		hashWorkspace: () => HASH,
	});
	return { cwd, artifactStore, state, contract, manager };
}

describe("PRD-012 Phase 3 — units, gating and the goal descriptor", () => {
	it("AC-3: the executor packet carries the current unit and the artifact reference, and no sibling or PRD-body text", async () => {
		const { state, artifactStore, manager } = await lane();
		const packet = manager.unitContext("unit-1");

		expect(packet.objective).toBe("Phase 1: cache core");
		expect(packet.acceptanceCriteria).toEqual([{ id: "AC-1", text: "Plan the cache layout", verifyCommand: AC1_COMMAND }]);
		expect(packet.context.prd).toBe(state.artifactRef);
		expect(packet.budget).toBeTypeOf("number");
		expect(packet.retryLimit).toBeTypeOf("number");

		const serialized = JSON.stringify(packet);
		for (const marker of Object.values(MARKERS)) expect(serialized).not.toContain(marker);
		expect(serialized).not.toContain(AC2_COMMAND);

		// The full PRD is still retrievable through the reference.
		expect(artifactStore.expand(packet.context.prd).toString("utf8")).toBe(FIXTURE_PRD_BODY);

		// Negative control: a packet fed the whole PRD trips the same markers, so
		// the absence assertions above are sensitive rather than vacuous.
		const control = JSON.stringify({ ...packet, context: { prd: FIXTURE_PRD_BODY } });
		for (const marker of Object.values(MARKERS)) expect(control).toContain(marker);
	});

	it("AC-4: an unverified dependency blocks dispatch, and routing consumes the stored required_capability", async () => {
		const { cwd, contract, manager } = await lane();

		// The dependent unit is never dispatched while its dependency is unverified.
		expect(manager.nextUnit()?.id).toBe("unit-1");
		expect(manager.dispatch()?.unit.id).toBe("unit-1");
		expect(manager.state.units.find((unit) => unit.id === "unit-2")!.dependsOn).toEqual(["unit-1"]);

		// Raising the stored min_coding_index changes the model the routing decision selects.
		manager.setRequiredCapability({ min_coding_index: 20 });
		const low = manager.routingFor("unit-2");
		expect(low.required_capability.min_coding_index).toBe(20);
		expect(low.model).toBe("stub-quick");

		manager.setRequiredCapability({ min_coding_index: 95 });
		const high = manager.routingFor("unit-2");
		expect(high.model).toBe("stub-specialist");
		expect(high.model).not.toBe(low.model);

		// The packet handed on to PRD-007 is exactly the six §28 fields — no routing key.
		const packet = manager.unitContext("unit-2");
		expect(Object.keys(packet).sort()).toEqual([...EXECUTOR_PACKET_KEYS].sort());
		expect(Object.keys(packet)).not.toContain("required_capability");
		expect(Object.keys(packet)).not.toContain("routing");
		expect(packet.capabilities).toEqual(contract.capabilities);
		expect(packet.budget).toBe(contract.context.budget_tokens);
		expect(packet.retryLimit).toBe(contract.limits.execution_attempts);

		// The dependency's criterion verifies → the dependent unit is dispatched next.
		await manager.applyEvidence("AC-1", [freshPass("AC-1", HASH, "artifact://evidence/ac-1")], [AC1_COMMAND]);
		expect(manager.nextUnit()?.id).toBe("unit-2");
		expect(manager.dispatch()?.unit.id).toBe("unit-2");

		// The routing annotation is recorded with the unit, not with its packet.
		expect(readPrdState(cwd)!.routing.find((row) => row.unitId === "unit-2")?.model).toBe("stub-specialist");
	});

	it("AC-3: the unit shape comes from the installed prd-executor skill, degrading by name when absent", async () => {
		const skillsRoot = tempDir("leanpi-skills-");
		writeInstalledSkill(skillsRoot, "prd-executor", "PRD-EXECUTOR-MARKER", "Executor unit conventions");
		const { cwd, agentDir } = fixtureRepo();
		const artifactStore = artifactStoreFor(agentDir);
		const { state } = stagedPrd(cwd, { artifactStore });
		const { contract } = await prdRecord(cwd);

		const installed = createPrdManager({
			contract,
			config: prdConfig(cwd, { skillRoots: [skillsRoot] }),
			cwd,
			artifactStore,
			state,
			hashWorkspace: () => HASH,
		});
		expect(installed.executorUnitContract.source).toBe("installed");
		expect(installed.executorUnitContract.contract).toContain("PRD-EXECUTOR-MARKER");

		const degraded = createPrdManager({
			contract,
			config: prdConfig(cwd, { skillRoots: [join(cwd, "absent-skills")] }),
			cwd,
			artifactStore,
			state,
			hashWorkspace: () => HASH,
		});
		expect(degraded.executorUnitContract.source).toBe("builtin-fallback");
		expect(degraded.executorUnitContract.skillPath).toBeNull();
		expect(degraded.executorUnitContract.contract).toContain("PRD artifact reference");
	});

	it("AC-9: deriveGoal() lists exactly the remaining required criteria and shrinks as they verify", async () => {
		const { cwd, manager } = await lane();

		expect(manager.deriveGoal()).toEqual([
			{ criterionId: "AC-1", text: "Plan the cache layout", verifyCommand: AC1_COMMAND },
			{ criterionId: "AC-2", text: "Measure the hit rate", verifyCommand: "npx vitest run tests/prd/metrics.spec.ts" },
			{ criterionId: "AC-3", text: "Document the eviction policy", verifyCommand: "npx vitest run tests/prd/docs.spec.ts" },
		]);

		await manager.applyEvidence("AC-1", [freshPass("AC-1", HASH, "artifact://evidence/ac-1")], [AC1_COMMAND]);
		expect(manager.deriveGoal().map((entry) => entry.criterionId)).toEqual(["AC-2", "AC-3"]);

		// A reopened criterion re-enters the goal at its own position.
		const failing: EvidenceRecord = failingEvidence("AC-1", "artifact://evidence/ac-1-failing");
		await manager.applyEvidence("AC-1", [failing], [AC1_COMMAND]);
		expect(manager.deriveGoal().map((entry) => entry.criterionId)).toEqual(["AC-1", "AC-2", "AC-3"]);

		// The handoff is a pure function of the persisted state — no manual /goal text.
		expect(deriveGoal(readPrdState(cwd)!)).toEqual(manager.deriveGoal());
	});
});
