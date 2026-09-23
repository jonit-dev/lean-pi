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
	loadConfig,
	readRuns,
	registerCapabilityProvider,
	scoutTask,
	writeUserDefault,
} from "../src/index.js";
import { registerLane, runTurn } from "../src/commands/session.js";
import { clearRoutePins, setRoutePins } from "../src/compiler/pins.js";
import { laneLoads, resetLaneLoads } from "../src/prd/dispatch.js";
import { registerTurnLanes, registerTurnLanesIfOwned } from "../src/commands/turn-lanes.js";
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

/**
 * A mixed configuration (ROADMAP §23): the role a turn is invoked with is
 * native, the class the compiler can ask for is an external harness. Pi's own
 * loop has a provider for the first and none for the second — a harness model is
 * spawned, never registered with the model runtime — so `serveClass` is the one
 * variable the two specs below flip: whether the class's backend is reachable.
 */
function mixedRoute({ serveClass }: { serveClass: boolean }) {
	const { cwd } = fixtureRepo();
	writeConfig(cwd, {
		backends: {
			local: nativeBackend("http://127.0.0.1:9/v1", { model: "cheap-model" }),
			harness: { type: "external_harness", vendor: "claude", command: "claude" },
		},
		models: {
			balanced: { backend: "local", model: "cheap-model" },
			strong: { backend: "harness", model: "strong-model" },
		},
	});
	const config = loadConfig(cwd);
	const ran: { model: string | null } = { model: null };
	const session = {
		setModel: async (selected: { id?: string }) => {
			ran.model = String(selected?.id ?? "");
		},
		setThinkingLevel: () => undefined,
		prompt: async () => undefined,
		getActiveToolNames: () => [],
		setActiveToolsByName: () => undefined,
	};
	const models: Record<string, { id: string; provider: string }> = {
		local: { id: "cheap-model", provider: "local" },
		harness: { id: "strong-model", provider: "harness" },
	};
	const runtime = { getModel: (backend: string) => (backend === "harness" && !serveClass ? undefined : models[backend]) };
	return { config, cwd, ran, session, runtime };
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
			// tool-output pipeline needs is active with the baseline, joined by the
			// pi-subagents parent tools when that package is attached (PRD-041).
			expect([...session.activation.tools].sort()).toEqual(["edit", "execute", "read", "search", "write"]);
			const active = (session.session as unknown as { getActiveToolNames(): string[] }).getActiveToolNames();
			expect(active.sort()).toEqual(["edit", "execute", "read", "search", "write", ARTIFACT_TOOL_NAME, "subagent", "bg_wait"].sort());
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

	it("runs the model and the thinking budget the compiled route decided (PRD-004 §14)", async () => {
		// The spend decision on a native backend. Pi's loop is the executor, so
		// nothing else carries the class: the session's own model and level are what
		// the classification changes, and without this wiring JEV decides nothing
		// that costs money.
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: {
				cheap: nativeBackend("http://127.0.0.1:9/v1", { model: "cheap-model" }),
				strong: nativeBackend("http://127.0.0.1:9/v1", { model: "strong-model" }),
			},
			models: {
				quick: { backend: "cheap", model: "cheap-model" },
				balanced: { backend: "strong", model: "strong-model" },
			},
		});
		const config = loadConfig(cwd);
		const session = await bootSession({ cwd, agentDir, config });
		const ran: { model: string | null; thinking: string | null } = { model: null, thinking: null };
		const model = { id: "cheap-model", provider: "cheap" };
		const stub = {
			setModel: async (selected: { id?: string }) => {
				ran.model = String(selected?.id ?? "");
			},
			setThinkingLevel: (level: string) => {
				ran.thinking = level;
			},
			prompt: async () => undefined,
			getActiveToolNames: () => [],
			setActiveToolsByName: () => undefined,
			modelRuntime: { getModel: () => model },
		};
		clearLanes();
		setRoutePins({ executor_class: "quick" }, "wiring-spec");
		try {
			// A native config: the compiler registers, the executor lane does not.
			expect(registerTurnLanesIfOwned({ cwd, config })).toBe(false);
			const context = await runTurn(
				{ text: "change the button text" },
				{ config, cwd, session: stub as never, runtime: { getModel: () => model } as never },
			);
			expect(context.contract!.routing.executor_class).toBe("quick");
			// Both decisions are the compiled ones, not the session's defaults.
			expect(ran.model).toBe("cheap-model");
			expect(context.modelRef.model).toBe("cheap-model");
			expect(ran.thinking).toBe(context.contract!.reasoning.effort);
		} finally {
			clearRoutePins();
			clearLanes();
			session.session.dispose();
		}
	});

	it("keeps the invoked role when the compiled class needs a backend the loop cannot serve (PRD-004 §14)", async () => {
		// The compiled class is a request, not an order: on a mixed configuration the
		// class resolves to the harness, `getModel` finds nothing for it, and the turn
		// must run the role it was invoked with instead of failing outright.
		const { config, cwd, ran, session, runtime } = mixedRoute({ serveClass: false });
		clearLanes();
		setRoutePins({ executor_class: "strong" }, "wiring-spec");
		try {
			expect(registerTurnLanesIfOwned({ cwd, config })).toBe(false);
			const context = await runTurn(
				{ text: "rewrite the scheduler" },
				{ config, cwd, session: session as never, runtime: runtime as never },
			);
			expect(context.contract!.routing.executor_class).toBe("strong");
			expect(context.modelRef).toEqual({ backend: "local", model: "cheap-model", type: "native" });
			expect(ran.model).toBe("cheap-model");
		} finally {
			clearRoutePins();
			clearLanes();
		}
	});

	it("adopts the compiled class when the runtime can serve it (PRD-004 §14)", async () => {
		// The control for the spec above: same configuration, same pinned class, and
		// the only difference is that the runtime reaches the class's backend.
		const { config, cwd, ran, session, runtime } = mixedRoute({ serveClass: true });
		clearLanes();
		setRoutePins({ executor_class: "strong" }, "wiring-spec");
		try {
			expect(registerTurnLanesIfOwned({ cwd, config })).toBe(false);
			const context = await runTurn(
				{ text: "rewrite the scheduler" },
				{ config, cwd, session: session as never, runtime: runtime as never },
			);
			expect(context.modelRef.model).toBe("strong-model");
			expect(ran.model).toBe("strong-model");
		} finally {
			clearRoutePins();
			clearLanes();
		}
	});

	it("still fails a turn whose invoked role has no model (PRD-004 §14)", async () => {
		// The counterpart to the refusal: an unconfigured role is a configuration
		// error, and the fallback must not turn it into a silent wrong-model run. A
		// caller that named the class itself asked for that role, so it stands.
		const { config, cwd, ran, session, runtime } = mixedRoute({ serveClass: false });
		clearLanes();
		registerTurnLanesIfOwned({ cwd, config });
		try {
			await expect(
				runTurn({ text: "rewrite the scheduler", role: "strong" }, { config, cwd, session: session as never, runtime: runtime as never }),
			).rejects.toThrow();
			expect(ran.model).toBeNull();
		} finally {
			clearLanes();
		}
	});

	it("propagates the lane's own failure when the context observer throws (PRD-040 P4-F)", async () => {
		// A lane that threw after compiling is published through `onContext` so the
		// failed turn can still be billed. That observer is a reporter: when it
		// throws, the caller must still see the lane's original error, not the
		// reporter's. Only this error path swallows it; the success paths are not.
		const { cwd } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend("http://127.0.0.1:9/v1") },
			models: { balanced: { backend: "local", model: "cheap-model" } },
		});
		const config = loadConfig(cwd);
		clearLanes();
		registerLane({
			name: "test.throwing",
			async run() {
				throw new Error("the lane failed first");
			},
		});
		try {
			await expect(
				runTurn(
					{ text: "do the thing" },
					{
						config,
						cwd,
						onContext: () => {
							throw new Error("the observer blew up");
						},
					},
				),
			).rejects.toThrow(/the lane failed first/);
		} finally {
			clearLanes();
		}
	});

	it("runs the compiled class on the interactive loop's model (PRD-004 §14)", async () => {
		// The user's own path: Pi's `before_agent_start` runs the lanes, and the model
		// the request carries is the class's — not the session default.
		const backend = await startStubBackend([{ text: "ok" }, { text: "ok" }]);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: {
				cheap: nativeBackend(backend.baseUrl, { model: "cheap-model" }),
				strong: nativeBackend(backend.baseUrl, { model: "strong-model" }),
			},
			models: {
				quick: { backend: "cheap", model: "cheap-model" },
				balanced: { backend: "strong", model: "strong-model" },
			},
		});
		const session = await bootSession({ cwd, agentDir });
		try {
			setRoutePins({ executor_class: "quick" }, "wiring-spec");
			await session.session.prompt("rename the helper");
			expect(backend.requests[0]?.model).toBe("cheap-model");
		} finally {
			clearRoutePins();
			session.session.dispose();
			await backend.close();
		}
	});

	it("installs a native `/model` pin ahead of the routed class (PRD-048 AC-2)", async () => {
		// `/model` means "the model being used now": a native pick changes the model
		// Pi's loop runs, regardless of which class the classifier routed the turn to.
		const backend = await startStubBackend([{ text: "ok" }]);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: {
				cheap: nativeBackend(backend.baseUrl, { model: "cheap-model" }),
				strong: nativeBackend(backend.baseUrl, { model: "strong-model" }),
			},
			models: {
				quick: { backend: "cheap", model: "cheap-model" },
				balanced: { backend: "cheap", model: "cheap-model" },
				strong: { backend: "strong", model: "strong-model" },
			},
		});
		const session = await bootSession({ cwd, agentDir });
		try {
			setRoutePins({ model: { backend: "strong", model: "strong-model", type: "native" } }, "wiring-spec");
			await session.session.prompt("rename the helper");
			expect(backend.requests[0]?.model).toBe("strong-model");
		} finally {
			clearRoutePins();
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
			expect(passing.contract!.verification.criteria).toEqual([{ id: "AC-1", verifiers: ["affected_tests"], scope: ["tests/parse.spec.ts"] }]);
			expect(passing.proof!.criteria.map((criterion) => criterion.id)).toEqual(["AC-1"]);
			// The gate reads this turn's own evidence: the verifier the executor ran
			// reported `targeted_test` pass, and AC-1's packet carries it.
			expect(passing.proof!.criteria[0]!.coverage.satisfied).toBe(true);
			expect(passing.proof!.criteria[0]!.coverage.unsatisfied).toEqual([]);
			// D1 fixed: a MEDIUM contract that declares no runtime plan no longer
			// requires an unsatisfiable `runtime_smoke`, so the passing targeted test
			// and the passing review settle the criterion on PASS.
			expect(passing.proof!.decision).toBe("PASS");

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
