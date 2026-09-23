/**
 * PRD-007 AC-2 — the reachable consumer: a user message driven through the real
 * `runTurn()` lane chain reaches the executor and changes the workspace.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearLanes, listLanes, ownsExecutionLoop, registerLane, registerTurnLanes, registerTurnLanesIfOwned, runTurn } from "../../src/index.js";
import { setCompilerContext } from "../../src/compiler/index.js";
import { REVIEW_LEVEL_QUESTION_ID, REVIEW_LEVEL_SITE_ID } from "../../src/review/gate.js";
import { choice, fakeExec, harness, multiBackendConfig, scriptedJev, VERIFY_COMMANDS, type ExecHarness } from "./helpers.js";

const open: ExecHarness[] = [];

afterEach(async () => {
	clearLanes();
	while (open.length > 0) await open.pop()?.close();
});

describe("PRD-007 Phase 1 — the turn chain", () => {
	it("AC-2: runTurn compiles the request and the executor lane edits the workspace", async () => {
		const h = await harness();
		open.push(h);
		setCompilerContext({ config: h.config, cwd: h.cwd });
		clearLanes();

		let seenObjective = "";
		registerTurnLanes({
			cwd: h.cwd,
			config: h.config,
			exec: fakeExec({ pass: true }),
			verifyCommands: VERIFY_COMMANDS,
			// This case is about the chain reaching the executor, so PRD-011's level
			// site answers "no review": otherwise the turn is routed to a reviewer
			// there is no worker for, and a verdict that did not pass blocks it.
			jev: scriptedJev({ [REVIEW_LEVEL_SITE_ID]: () => choice(REVIEW_LEVEL_QUESTION_ID, "NO_SEMANTIC_REVIEW") }),
			worker: async (packet) => {
				seenObjective = packet.objective;
				writeFileSync(join(h.cwd, "src", "target.ts"), "export const value = 42;\n");
				return { status: "completed", backend: "local", result: { status: "ok", changedFiles: ["src/target.ts"], summary: "edited" }, attempts: [] };
			},
		});

		const context = await runTurn({ text: "rename the helper in src/target.ts" }, { config: h.config, cwd: h.cwd });

		expect(context.contract).toBeDefined();
		expect(seenObjective).toBe(context.contract!.task.objective);
		expect(context.executor?.status).toBe("completed");
		expect(context.executor?.changedFiles).toEqual(["src/target.ts"]);
		expect(readFileSync(join(h.cwd, "src", "target.ts"), "utf8")).toContain("42");
	});

	it("AC-3: the lane stays out of the loop a native backend already owns", async () => {
		const h = await harness();
		open.push(h);
		clearLanes();

		// Native roles: Pi's own agent loop is the executor, so the *executor* lane
		// stays out — a second worker there would run the task twice. The compiler
		// still registers, because it is what classifies the task and decides the
		// model class and the reasoning budget the turn is billed for (§14): with
		// it out, a native turn costs whatever Pi's defaults cost and no JEV
		// decision ever reaches the spend.
		expect(ownsExecutionLoop(h.config)).toBe(false);
		expect(registerTurnLanesIfOwned({ cwd: h.cwd, config: h.config })).toBe(false);
		expect(listLanes().map((lane) => lane.name)).toEqual(["compiler", "tool-surface"]);

		// External-harness roles: LeanPi owns the loop, so the chain registers.
		clearLanes();
		const harnessConfig = multiBackendConfig(h.cwd);
		expect(ownsExecutionLoop(harnessConfig)).toBe(true);
		expect(registerTurnLanesIfOwned({ cwd: h.cwd, config: harnessConfig })).toBe(true);
		expect(listLanes().map((lane) => lane.name)).toEqual(["compiler", "tool-surface", "executor"]);
	});

	it("AC-3: a second registration supersedes LeanPi's own lanes instead of stacking them", async () => {
		const h = await harness();
		open.push(h);
		clearLanes();

		// The bench boots a session per task, so the same configuration registers
		// twice in one process. Stacked, the second task would compile twice (and on
		// the first task's workspace, captured in the earlier lane's closure).
		registerTurnLanesIfOwned({ cwd: h.cwd, config: h.config });
		registerTurnLanesIfOwned({ cwd: h.cwd, config: h.config });
		expect(listLanes().map((lane) => lane.name)).toEqual(["compiler", "tool-surface"]);

		// The owned chain follows the same rule, including a switch from a native
		// configuration to an external-harness one: no leftover compiler, no second
		// executor.
		registerTurnLanesIfOwned({ cwd: h.cwd, config: multiBackendConfig(h.cwd) });
		registerTurnLanes({ cwd: h.cwd, config: multiBackendConfig(h.cwd) });
		expect(listLanes().map((lane) => lane.name)).toEqual(["compiler", "tool-surface", "executor"]);
	});

	it("AC-3: a lane registered by hand survives a later registration", async () => {
		const h = await harness();
		open.push(h);
		clearLanes();

		registerLane({ name: "probe", run: () => {} });
		registerTurnLanesIfOwned({ cwd: h.cwd, config: h.config });
		registerTurnLanesIfOwned({ cwd: h.cwd, config: h.config });

		expect(listLanes().map((lane) => lane.name)).toEqual(["probe", "compiler", "tool-surface"]);
	});
});
