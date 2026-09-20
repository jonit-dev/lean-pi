/**
 * PRD-008 Phase 2 — E2: AC-3. The native backend owns the Pi agent loop, changes
 * the workspace file the packet asked for, and returns the identical
 * `WorkerResult` shape an external harness returns.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackendRegistry, nativeStop, runNative, runWorkerTurn, type WorkerResult, type WorkerTaskPacket } from "../../src/backends/index.js";
import { loadConfig } from "../../src/index.js";
import { fixtureRepo, nativeBackend, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend, type StubStep } from "../helpers/stub-backend.js";
import { installStubCli, setStubScript } from "./helpers.js";

const WRITE_TASK = "create shared.txt containing the requested text";

function shapeOf(result: WorkerResult): Record<string, string> {
	return Object.fromEntries(
		Object.entries(result)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => [key, Array.isArray(value) ? "array" : typeof value]),
	);
}

describe("PRD-008 Phase 2 — native model backend", () => {
	it("AC-3: a native turn writes the requested file through the Pi agent loop", async () => {
		const stub: StubBackend = await startStubBackend([
			{ toolCalls: [{ name: "write", args: { path: "shared.txt", content: "native wrote this\n" } }] },
			{ text: "created shared.txt" },
		]);
		const { cwd } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(stub.baseUrl, { model: "local-code" }) },
			models: { quick: { backend: "local", model: "local-code" } },
		});
		const registry = new BackendRegistry(loadConfig(cwd));

		const outcome = await runWorkerTurn(
			{ objective: WRITE_TASK, role: "quick", files: ["shared.txt"], allowedTools: ["write"] },
			{ registry, cwd },
		);
		await stub.close();

		expect(outcome.status).toBe("completed");
		expect(outcome.backend).toBe("local");
		expect(readFileSync(join(cwd, "shared.txt"), "utf8")).toBe("native wrote this\n");
		expect(outcome.result?.changedFiles).toEqual(["shared.txt"]);
		expect(outcome.result?.summary).toContain("created shared.txt");
		// The tool/model cycle ran on LeanPi's side: the model was asked again with
		// the write tool's result in the transcript.
		expect(stub.requests.length).toBeGreaterThan(1);
	});

	it("AC-3: the native and harness outcomes have the same field-for-field shape", async () => {
		const cli = installStubCli();
		const cliDir = fixtureRepo();
		const nativeDir = fixtureRepo();
		const stub: StubBackend = await startStubBackend([
			{ toolCalls: [{ name: "write", args: { path: "shared.txt", content: "native\n" } }] },
			{ text: "created shared.txt" },
		]);
		const backends = {
			local: nativeBackend(stub.baseUrl, { model: "local-code" }),
			claude: { type: "external_harness", command: cli.bin.claude, roles: ["strong"] },
		};
		const models = {
			quick: { backend: "local", model: "local-code" },
			strong: { backend: "claude", model: "strong" },
		};
		writeConfig(cliDir.cwd, { backends, models });
		writeConfig(nativeDir.cwd, { backends, models });

		const nativeRegistry = new BackendRegistry(loadConfig(nativeDir.cwd));
		const harnessRegistry = new BackendRegistry(loadConfig(cliDir.cwd));
		const packet = (role: "quick" | "strong"): WorkerTaskPacket => ({
			objective: WRITE_TASK,
			role,
			files: ["shared.txt"],
			allowedTools: ["write"],
		});

		const nativeOutcome = await runWorkerTurn(packet("quick"), { registry: nativeRegistry, cwd: nativeDir.cwd });
		const restore = setStubScript(cli.recordPath, { files: { "shared.txt": "claude\n" } });
		const harnessOutcome = await runWorkerTurn(packet("strong"), { registry: harnessRegistry, cwd: cliDir.cwd });
		restore();
		await stub.close();

		expect(nativeOutcome.status).toBe("completed");
		expect(harnessOutcome.status).toBe("completed");
		expect(shapeOf(nativeOutcome.result as WorkerResult)).toEqual(shapeOf(harnessOutcome.result as WorkerResult));
		expect(shapeOf(nativeOutcome.result as WorkerResult)).toEqual({
			changedFiles: "array",
			raw: "object",
			sessionId: "string",
			status: "string",
			summary: "string",
		});
	});

	it("a provider error is a typed worker failure, never a throw", async () => {
		// A 400 is not retried by the provider layer, so the typed failure is
		// asserted without waiting out a 5xx retry storm.
		const stub: StubBackend = await startStubBackend([{ status: 400, body: JSON.stringify({ error: { message: "stub exploded" } }) }]);
		const { cwd } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(stub.baseUrl, { model: "local-code" }) },
			models: { quick: { backend: "local", model: "local-code" } },
		});
		const registry = new BackendRegistry(loadConfig(cwd));
		const backend = registry.selectBackend("quick")[0]!;

		const outcome = await runNative(backend, { objective: WRITE_TASK, role: "quick", files: ["shared.txt"] }, { cwd });
		await stub.close();

		expect(outcome.status).toBe("failed");
		expect(outcome).toMatchObject({ status: "failed", failure: "provider" });
		expect(outcome.status === "failed" && outcome.reason.length > 0).toBe(true);
	});

	it("the packet's budget stops the Pi agent loop", async () => {
		const steps: StubStep[] = [1, 2, 3, 4].map((index) => ({
			toolCalls: [{ name: "write", args: { path: `loop-${index}.txt`, content: `${index}\n` } }],
		}));
		const stub: StubBackend = await startStubBackend(steps);
		const { cwd } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(stub.baseUrl, { model: "local-code" }) },
			models: { quick: { backend: "local", model: "local-code" } },
		});
		const registry = new BackendRegistry(loadConfig(cwd));

		const outcome = await runWorkerTurn(
			{ objective: "keep going forever", role: "quick", files: ["loop-1.txt"], allowedTools: ["write"], budget: 2 },
			{ registry, cwd },
		);
		const requests = stub.requests.length;
		await stub.close();

		expect(outcome.status).toBe("blocked");
		expect(outcome.attempts[0]).toMatchObject({ backend: "local", failure: "blocked" });
		expect(outcome.attempts[0]!.reason).toContain("budget of 2 turns");
		expect(requests).toBeLessThan(4);
	});

	it("classifies a stopped loop by its own facts, not by the transcript", () => {
		// The regression this pins: a provider error that arrives after the loop
		// already wrote text and files must not read as a completion.
		expect(nativeStop({ promptError: false, providerError: true, timedOut: false, exceeded: false })).toBe("provider_failure");
		expect(nativeStop({ promptError: false, providerError: false, timedOut: true, exceeded: false })).toBe("deadline");
		expect(nativeStop({ promptError: false, providerError: false, timedOut: false, exceeded: true })).toBe("budget");
		expect(nativeStop({ promptError: true, providerError: true, timedOut: true, exceeded: true })).toBe("provider_failure");
		// A stop we caused is reported as ours, even though an abort also leaves an
		// error message behind.
		expect(nativeStop({ promptError: false, providerError: true, timedOut: true, exceeded: true })).toBe("deadline");
		expect(nativeStop({ promptError: false, providerError: false, timedOut: false, exceeded: false })).toBe("completed");
	});

	it("ends a stalled loop at the wall-clock ceiling and reports what it spent", async () => {
		// Every request asks for another write, so only the ceiling stops it.
		const stub: StubBackend = await startStubBackend([{ toolCalls: [{ name: "write", args: { path: "stall.txt", content: "x\n" } }] }]);
		const { cwd } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(stub.baseUrl, { model: "local-code" }) },
			models: { quick: { backend: "local", model: "local-code" } },
		});
		const registry = new BackendRegistry(loadConfig(cwd));
		const backend = registry.selectBackend("quick")[0]!;

		const outcome = await runNative(
			backend,
			{ objective: "never stop", role: "quick", files: ["stall.txt"], allowedTools: ["write"], budget: 1_000 },
			{ cwd, timeoutMs: 400 },
		);
		await stub.close();

		expect(outcome.status).toBe("blocked");
		if (outcome.status !== "blocked") throw new Error("expected a blocked outcome");
		expect(outcome.summary).toContain("wall-clock ceiling");
		// A killed attempt has spent money, so it reports what the session counted.
		const raw = outcome.raw;
		expect(raw !== null && typeof raw === "object" && "tokens" in raw && typeof raw.tokens === "number").toBe(true);
	});
});
