/**
 * The wiring audit's regression net: every feature the audit found unreachable
 * gets one assertion that runs through the real extension boot rather than
 * calling the module by hand. A registration that only works in a unit test
 * cannot pass any of these.
 */
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ARTIFACT_TOOL_NAME,
	LSP_TOOL_NAMES,
	clearLanes,
	compileTask,
	itemsOf,
	readRuns,
	registerCapabilityProvider,
	scoutTask,
	writeUserDefault,
} from "../src/index.js";
import { registerLane, runTurn } from "../src/commands/session.js";
import { clearRoutePins, setRoutePins } from "../src/compiler/pins.js";
import { laneLoads, resetLaneLoads } from "../src/prd/dispatch.js";
import { registerTurnLanes } from "../src/commands/turn-lanes.js";
import { fakeExec, VERIFY_COMMANDS } from "./executor/helpers.js";
import { artifactStoreFor, prdConfig, stagedPrd } from "./prd/helpers.js";
import { bootSession, fixtureRepo, gitCommitAll, gitInit, nativeBackend, tempDir, writeConfig } from "./helpers/fixtures.js";
import { startStubBackend, type StubStep } from "./helpers/stub-backend.js";

async function booted(steps: Parameters<typeof startStubBackend>[0] = [{ text: "ok" }]) {
	const backend = await startStubBackend(steps);
	const { cwd, agentDir } = fixtureRepo();
	writeConfig(cwd, {
		backends: { local: nativeBackend(backend.baseUrl) },
		models: { balanced: { backend: "local", model: "cheap-fast" } },
	});
	clearLanes();
	// The guard defaults `shell` to ask, which a non-interactive session cannot
	// answer. A real user grants it once; the fixture does the same.
	const env = { XDG_CONFIG_HOME: tempDir("leanpi-xdg-"), HOME: tempDir("leanpi-home-") };
	writeUserDefault("shell", "allow", env);
	writeUserDefault("edit", "allow", env);
	const session = await bootSession({ cwd, agentDir, env });
	return { backend, cwd, session };
}

describe("activation wiring", () => {
	it("registers the PRD-owned command surfaces (PRD-011/012/013/025)", async () => {
		const { backend, session } = await booted();
		try {
			for (const name of ["todo", "goal", "review", "prd"]) expect(session.commands.has(name)).toBe(true);
			// The claim that matters is that the handler runs, not that a name exists.
			const added = await session.commands.dispatch("todo add ship the wiring");
			expect(added.ok).toBe(true);
			expect(itemsOf(session.activation.todo)).toHaveLength(1);
		} finally {
			session.session.dispose();
			await backend.close();
		}
	});

	it("registers the LSP tools but leaves them inactive until a turn selects a mode (PRD-018 §15)", async () => {
		const { backend, session } = await booted();
		try {
			expect(LSP_TOOL_NAMES.length).toBeGreaterThan(0);
			// The five baseline names stay the activation's surface claim (§44); the
			// LSP group is registered and inactive, and the expand affordance the
			// tool-output pipeline needs is active with the baseline.
			expect([...session.activation.tools].sort()).toEqual(["edit", "execute", "read", "search", "write"]);
			const active = (session.session as unknown as { getActiveToolNames(): string[] }).getActiveToolNames();
			expect(active.sort()).toEqual(["edit", "execute", "read", "search", "write", ARTIFACT_TOOL_NAME].sort());
			for (const name of LSP_TOOL_NAMES) expect(active).not.toContain(name);
		} finally {
			session.session.dispose();
			await backend.close();
		}
	});

	it("captures a real tool result and hands the executor a reference (PRD-014 AC-1, PRD-019)", async () => {
		const { backend, cwd, session } = await booted([
			{ toolCalls: [{ name: "execute", args: { command: "yes abcdefghijklmnopqrstuvwxyz0123456789 | head -n 2000" } }] },
			{ text: "done" },
		]);
		try {
			await session.runTurn("print a lot");
			// The pipeline runs on Pi's tool_result hook, so the assertion is what the
			// next request carries: a reference, not the 50KB the tool produced.
			expect(JSON.stringify(backend.requests[1]!.body)).toContain("artifact://execute/");
			// And the bytes are really there, byte-identical to what the tool printed.
			const stored = globSync(join(cwd, ".leanpi", "artifacts", "**", "*"), { withFileTypes: true }).filter((entry) => entry.isFile());
			expect(stored.length).toBeGreaterThan(0);
			const bytes = readFileSync(join(stored[0]!.parentPath, stored[0]!.name), "utf8");
			expect(bytes).toContain("abcdefghijklmnopqrstuvwxyz0123456789");
		} finally {
			session.session.dispose();
			await backend.close();
		}
	});

	it("expands a compacted result through the artifact tool (PRD-014 AC-2)", async () => {
		const steps: StubStep[] = [
			{ toolCalls: [{ name: "execute", args: { command: "yes abcdefghijklmnopqrstuvwxyz0123456789 | head -n 2000" } }] },
			{ text: "noted the reference" },
		];
		const backend = await startStubBackend(steps);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, { backends: { local: nativeBackend(backend.baseUrl) }, models: { balanced: { backend: "local", model: "cheap-fast" } } });
		clearLanes();
		const env = { XDG_CONFIG_HOME: tempDir("leanpi-xdg-"), HOME: tempDir("leanpi-home-") };
		writeUserDefault("shell", "allow", env);
		const session = await bootSession({ cwd, agentDir, env });
		try {
			await session.runTurn("print a lot");
			const ref = /artifact:\/\/[^"\s\]]+/.exec(JSON.stringify(backend.requests[1]!.body))?.[0];
			expect(ref).toBeDefined();
			// A second turn asks for the bytes back through the tool the session exposes.
			steps.push({ toolCalls: [{ name: ARTIFACT_TOOL_NAME, args: { ref } }] }, { text: "expanded" });
			await session.runTurn("show me the full output");
			expect(JSON.stringify(backend.requests[3]!.body)).toContain("abcdefghijklmnopqrstuvwxyz0123456789");
		} finally {
			session.session.dispose();
			await backend.close();
		}
	});

	it("opens the PRD lane when the compiler dispatches to it, and nothing when it does not (PRD-012)", async () => {
		const { cwd, agentDir } = fixtureRepo();
		const config = prdConfig(cwd);
		const artifacts = artifactStoreFor(agentDir);
		stagedPrd(cwd, { artifactStore: artifacts });
		const worker = async () => ({ status: "completed", backend: "local", result: { status: "ok", changedFiles: [], summary: "done" }, attempts: [] }) as never;
		const lanes = { cwd, config, artifacts, worker, exec: fakeExec({ pass: true }), verifyCommands: VERIFY_COMMANDS, reviewRunner: async () => ({ status: "ok", changedFiles: [], summary: JSON.stringify({ decision: "PASS", findings: [] }) }) };
		try {
			// The quick path first: a direct-execution gate must not load the lane.
			clearLanes();
			resetLaneLoads();
			setRoutePins({ prd_required: false }, "wiring-spec");
			registerTurnLanes(lanes);
			const direct = await runTurn({ text: "do the thing" }, { config, cwd });
			expect(direct.contract?.task.prd_required).toBe(false);
			expect(direct.prd).toBeUndefined();
			expect(laneLoads).toEqual([]);

			// The same turn with the gate answering PRD_REQUIRED opens the lane.
			clearLanes();
			resetLaneLoads();
			setRoutePins({ prd_required: true }, "wiring-spec");
			registerTurnLanes(lanes);
			const prd = await runTurn({ text: "do the thing" }, { config, cwd });
			expect(prd.contract?.task.prd_required).toBe(true);
			expect(prd.prd?.state.prdId).toBe("PRD-101");
			expect(prd.prd?.nextUnit()?.id).toBeDefined();
			expect(laneLoads).toContain("manager");
		} finally {
			clearRoutePins();
			clearLanes();
		}
	});

	it("evaluates the proof gate over the contract's criteria (PRD-010)", async () => {
		const { cwd, agentDir } = fixtureRepo();
		mkdirSync(join(cwd, "src"), { recursive: true });
		mkdirSync(join(cwd, "tests"), { recursive: true });
		writeFileSync(join(cwd, "src", "parse.ts"), "export const parse = () => 1;\n");
		writeFileSync(join(cwd, "tests", "parse.spec.ts"), "it('parses', () => {});\n");
		gitInit(cwd);
		gitCommitAll(cwd);
		// A dirty test file is what names AC-1's surface, which is what PRD-009
		// attributes its records to (FR-124) and therefore what the gate gates on.
		writeFileSync(join(cwd, "tests", "parse.spec.ts"), "it('parses', () => expect(1).toBe(1));\n");

		const config = prdConfig(cwd);
		const artifacts = artifactStoreFor(agentDir);
		const worker = async () => ({
			status: "completed",
			backend: "local",
			result: { status: "ok", changedFiles: ["src/parse.ts"], summary: "done" },
			attempts: [],
		}) as never;
		const review = async () => ({ status: "ok", changedFiles: [], summary: JSON.stringify({ decision: "PASS", findings: [] }) });
		const lanes = (pass: boolean) => ({ cwd, config, artifacts, worker, exec: fakeExec({ pass }), verifyCommands: VERIFY_COMMANDS, reviewRunner: review });
		try {
			clearLanes();
			resetLaneLoads();
			setRoutePins({ prd_required: false }, "wiring-spec");
			registerTurnLanes(lanes(true));
			const passing = await runTurn({ text: "fix the parse bug" }, { config, cwd });
			expect(passing.contract!.verification.criteria).toEqual([{ id: "AC-1", verifiers: ["affected_tests"], scope: "tests/parse.spec.ts" }]);
			expect(passing.proof!.criteria.map((criterion) => criterion.id)).toEqual(["AC-1"]);
			// The gate reads this turn's own evidence: the verifier the executor ran
			// reported `targeted_test` pass, and AC-1's packet carries it.
			expect(passing.proof!.criteria[0]!.coverage.satisfied).toBe(true);
			expect(passing.proof!.criteria[0]!.coverage.unsatisfied).toEqual([]);
			// Whatever the verdict, it is one of PRD-010's four and never a fabricated
			// pass: this fixture cannot run the `runtime_smoke` its MEDIUM contract
			// requires, so the turn is gated as unproved.
			expect(["PASS", "MISSING_PROOF", "BLOCKED", "FAILED"]).toContain(passing.proof!.decision);
			expect(passing.proof!.decision).not.toBe("PASS");

			// The negative control: a failing verifier cannot satisfy the criterion.
			clearLanes();
			registerTurnLanes(lanes(false));
			const failing = await runTurn({ text: "fix the parse bug" }, { config, cwd });
			expect(failing.proof!.criteria[0]!.coverage.satisfied).toBe(false);
			expect(failing.proof!.criteria[0]!.coverage.unsatisfied).toContain("targeted_test");
		} finally {
			clearRoutePins();
			clearLanes();
		}
	});

	it("puts the contract's selected skill bodies in the request (PRD-005 AC-4)", async () => {
		const { backend, session } = await booted();
		try {
			const body = "BODY-MARKER: always run the targeted test first";
			// The contract is frozen by the compiler, so the slot is filled the way a
			// real session fills it: a provider registered at PRD-004's registration
			// point, consumed by compileTask.
			registerCapabilityProvider({ kind: "skills", supply: () => [{ name: "targeted", source: "user", body }] });
			const contract = await compileTask("add a helper and its test", scoutTask(session.activation.cwd, "add a helper and its test"));
			registerLane({
				name: "skill-contract-lane",
				run(_turn, context) {
					context.contract = contract;
				},
			});
			await session.runTurn("add a helper and its test");
			expect(JSON.stringify(backend.requests[0]!.body)).toContain("BODY-MARKER: always run the targeted test first");
		} finally {
			session.session.dispose();
			await backend.close();
		}
	});

	it("carries the todo list into the next request (PRD-025 §42)", async () => {
		const { backend, session } = await booted();
		try {
			await session.commands.dispatch("todo add ship the wiring");
			await session.runTurn("what is left");
			expect(JSON.stringify(backend.requests[0]!.body)).toContain("ship the wiring");
		} finally {
			session.session.dispose();
			await backend.close();
		}
	});
});
