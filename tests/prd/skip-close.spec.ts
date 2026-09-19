/**
 * PRD-012 Phase 4 / AC-7, AC-8 — the quick-path skip and closure through the
 * installed prd-manager helper.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../src/commands/registry.js";
import { registerPrdCommands } from "../../src/prd/commands.js";
import { laneLoads, openPrdLane, registerPrdCommandsLazily, resetLaneLoads } from "../../src/prd/dispatch.js";
import { readPrdState, transitionCriterion, writePrdState, type PrdState } from "../../src/prd/state.js";
import { fixtureRepo, gitCommitAll, gitInit, tempDir } from "../helpers/fixtures.js";
import {
	artifactStoreFor,
	CLOSING_HELPER,
	prdConfig,
	prdRecord,
	quickRecord,
	REJECTING_HELPER,
	stagedPrd,
	writePrdManagerSkill,
} from "./helpers.js";

/** Every criterion verified, and the state persisted as `/prd status` reads it. */
function verifyAll(cwd: string, state: PrdState): string {
	for (const criterion of state.criteria) {
		transitionCriterion(state, criterion.id, { status: "VERIFIED", evidenceRef: `artifact://evidence/${criterion.id}` });
	}
	writePrdState(cwd, state);
	return state.prdPath;
}

describe("PRD-012 Phase 4 — quick path and closure", () => {
	it("AC-7: a prd_required=false task creates no PRD state and loads no src/prd/* module", async () => {
		const { cwd, agentDir } = fixtureRepo();
		writeFileSync(join(cwd, "README.md"), "# fixture\n");
		gitInit(cwd);
		gitCommitAll(cwd);
		const config = prdConfig(cwd);
		const artifactStore = artifactStoreFor(agentDir);

		const quick = await quickRecord(cwd);
		expect(quick.record.contract.task.prd_required).toBe(false);
		expect(quick.record.next_stage).toBe("executor_lane");

		// Wiring `/prd` through the lazy registrar loads no lane module, and the
		// quick path adds none either: the counter stays at zero.
		resetLaneLoads();
		const registry = createCommandRegistry();
		registerPrdCommandsLazily(registry, { cwd, config, artifactStore, author: async () => "" });
		const skipped = await openPrdLane(quick.record, { config, cwd, artifactStore });

		expect(skipped).toBeNull();
		expect(laneLoads).toEqual([]);
		expect(registry.has("prd")).toBe(true);
		expect(existsSync(join(cwd, ".leanpi", "prd"))).toBe(false);
		expect(existsSync(join(artifactStore.sessionDir, "artifacts", "prd"))).toBe(false);

		// `/prd` is reachable all the same; with no PRD it says so instead of failing.
		const noPrd = await registry.dispatch("/prd close", { cwd });
		expect(noPrd.ok).toBe(false);
		expect(noPrd.text).toContain("no active PRD");

		// Negative control, same process, run after the skip: the PRD path does load
		// the lane, which is what makes the zero above an observation.
		const prd = await prdRecord(cwd);
		expect(prd.record.next_stage).toBe("prd_lane");
		stagedPrd(cwd, { artifactStore });
		resetLaneLoads();
		const lane = await openPrdLane(prd.record, { config, cwd, artifactStore });

		expect(lane).not.toBeNull();
		expect(laneLoads).toContain("manager");
	});

	it("AC-8: /prd close invokes the installed prd-close.mjs with the PRD path", async () => {
		const { cwd, agentDir } = fixtureRepo();
		const artifactStore = artifactStoreFor(agentDir);
		const { state, prdPath } = stagedPrd(cwd, { artifactStore });
		verifyAll(cwd, state);
		const skillsRoot = tempDir("leanpi-skills-");
		writePrdManagerSkill(skillsRoot, CLOSING_HELPER);

		const registry = createCommandRegistry();
		registerPrdCommands(registry, { cwd, config: prdConfig(cwd, { skillRoots: [skillsRoot] }), artifactStore });
		const result = await registry.dispatch("/prd close", { cwd });

		expect(result.ok).toBe(true);
		const invocation = JSON.parse(
			readFileSync(join(skillsRoot, "prd-manager", "scripts", "invocation.json"), "utf8"),
		) as { prdPath: string; flags: string[] };
		expect(invocation.prdPath).toBe(prdPath);
		expect(invocation.flags).toEqual(["--yes"]);
		expect(existsSync(prdPath)).toBe(false);
		expect(existsSync(join(dirname(prdPath), "done", basename(prdPath)))).toBe(true);
		expect(readPrdState(cwd)!.closure?.source).toBe("installed");
	});

	it("AC-8: with no resolvable helper the internal fallback moves the PRD and records the degradation", async () => {
		const { cwd, agentDir } = fixtureRepo();
		const artifactStore = artifactStoreFor(agentDir);
		const { state, prdPath } = stagedPrd(cwd, { artifactStore });
		verifyAll(cwd, state);
		const emptyRoot = tempDir("leanpi-empty-skills-");

		const registry = createCommandRegistry();
		registerPrdCommands(registry, { cwd, config: prdConfig(cwd, { skillRoots: [emptyRoot] }), artifactStore });
		const result = await registry.dispatch("/prd close", { cwd });

		const moved = join(dirname(prdPath), "done", basename(prdPath));
		expect(result.ok).toBe(true);
		expect(result.text).toContain("builtin-fallback");
		expect(existsSync(prdPath)).toBe(false);
		expect(existsSync(moved)).toBe(true);
		const closure = readPrdState(cwd)!.closure!;
		expect(closure.source).toBe("builtin-fallback");
		expect(closure.detail).toContain(moved);
	});

	it("AC-8: a rejecting helper is reported as a failure and leaves the PRD in place", async () => {
		const { cwd, agentDir } = fixtureRepo();
		const artifactStore = artifactStoreFor(agentDir);
		const { state, prdPath } = stagedPrd(cwd, { artifactStore });
		verifyAll(cwd, state);
		const skillsRoot = tempDir("leanpi-skills-");
		writePrdManagerSkill(skillsRoot, REJECTING_HELPER);

		const registry = createCommandRegistry();
		registerPrdCommands(registry, { cwd, config: prdConfig(cwd, { skillRoots: [skillsRoot] }), artifactStore });
		const result = await registry.dispatch("/prd close", { cwd });

		expect(result.ok).toBe(false);
		expect(result.text).toContain("prd-manager helper failed");
		expect(existsSync(prdPath)).toBe(true);
		expect(existsSync(join(dirname(prdPath), "done", basename(prdPath)))).toBe(false);
	});

	it("AC-8: close refuses while a required criterion is not VERIFIED", async () => {
		const { cwd, agentDir } = fixtureRepo();
		const artifactStore = artifactStoreFor(agentDir);
		const { prdPath } = stagedPrd(cwd, { artifactStore });

		const registry = createCommandRegistry();
		registerPrdCommands(registry, { cwd, config: prdConfig(cwd), artifactStore });
		const result = await registry.dispatch("/prd close", { cwd });

		expect(result.ok).toBe(false);
		expect(result.text).toContain("cannot close PRD-101: AC-1 is PENDING");
		expect(existsSync(prdPath)).toBe(true);
	});
});
