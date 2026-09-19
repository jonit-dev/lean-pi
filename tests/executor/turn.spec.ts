/**
 * PRD-007 AC-2 — the reachable consumer: a user message driven through the real
 * `runTurn()` lane chain reaches the executor and changes the workspace.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearLanes, listLanes, ownsExecutionLoop, registerTurnLanes, registerTurnLanesIfOwned, runTurn } from "../../src/index.js";
import { setCompilerContext } from "../../src/compiler/index.js";
import { fakeExec, harness, multiBackendConfig, VERIFY_COMMANDS, type ExecHarness } from "./helpers.js";

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

		// Native roles: Pi's own agent loop is the executor, so no lane registers.
		expect(ownsExecutionLoop(h.config)).toBe(false);
		expect(registerTurnLanesIfOwned({ cwd: h.cwd, config: h.config })).toBe(false);
		expect(listLanes()).toHaveLength(0);

		// External-harness roles: LeanPi owns the loop, so the chain registers.
		const harnessConfig = multiBackendConfig(h.cwd);
		expect(ownsExecutionLoop(harnessConfig)).toBe(true);
		expect(registerTurnLanesIfOwned({ cwd: h.cwd, config: harnessConfig })).toBe(true);
		expect(listLanes().map((lane) => lane.name)).toEqual(["compiler", "executor"]);
	});
});
