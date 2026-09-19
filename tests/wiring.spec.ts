/**
 * The wiring audit's regression net: every feature the audit found unreachable
 * gets one assertion that runs through the real extension boot rather than
 * calling the module by hand. A registration that only works in a unit test
 * cannot pass any of these.
 */
import { globSync, readFileSync } from "node:fs";
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
import { registerLane } from "../src/commands/session.js";
import { bootSession, fixtureRepo, nativeBackend, tempDir, writeConfig } from "./helpers/fixtures.js";
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
