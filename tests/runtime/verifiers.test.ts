/**
 * PRD-022 E1 — runtime smoke and CLI invocation (AC-1, AC-2).
 *
 * Both verifiers run real programs through PRD-009's verification entry point, so
 * the records under test are the ones that module stored. The negative controls
 * are on the evidence itself: the pass artifact must contain the marker the
 * fixture actually printed, and the failure artifact must contain the fixture's
 * real stderr — neither is reachable by a verifier that answered without running
 * anything. Every case ends by proving no child survived the verifier.
 */
import { describe, expect, it } from "vitest";
import { createArtifactStore } from "../../src/context/artifacts.js";
import { registerRuntimeVerifiers } from "../../src/runtime/index.js";
import { tempDir } from "../helpers/fixtures.js";
import {
	artifactText,
	freePort,
	isAlive,
	pidOf,
	runtimeContract,
	runtimeFixture,
	runtimeWorkspace,
	verifyRuntime,
	waitForDeath,
} from "./support.js";

registerRuntimeVerifiers();

describe("AC-1 — runtime smoke starts the service, observes readiness and reaps it", () => {
	it("passes the service fixture with its real stdio in the artifact", async () => {
		const root = runtimeWorkspace();
		const port = await freePort();
		const contract = runtimeContract({
			required: ["runtime_smoke"],
			criteria: [{ id: "AC-1", verifiers: ["runtime_smoke"], scope: "service" }],
			runtime: {
				smoke: {
					command: `node ${runtimeFixture("service.mjs")} ${port}`,
					ready: { log: "SERVICE_READY", port, timeoutMs: 15_000 },
					timeoutMs: 20_000,
				},
			},
		});
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });

		const result = await verifyRuntime(contract, root, { artifacts, timeoutMs: 30_000 });

		expect(result.status).toBe("pass");
		const record = result.records.find((entry) => entry.kind === "runtime_smoke");
		expect(record?.status).toBe("pass");
		expect(record?.artifactRef).toContain("artifact://runtime_smoke/");
		expect(record?.criterion).toEqual(["AC-1"]);

		// The artifact is the fixture's own output, not a summary the verifier wrote.
		const captured = artifactText(artifacts, record!.artifactRef!);
		expect(captured).toContain("SERVICE_PID");
		expect(captured).toContain("SERVICE_READY");
		expect(captured).toContain("readiness observed");

		// The service the verifier started is gone: it was in its own process group.
		const pid = pidOf(captured, "SERVICE_PID");
		expect(pid).toBeGreaterThan(0);
		expect(await waitForDeath(pid!)).toBe(true);
	});

	it("fails the boot-failure fixture with its stderr and leaves no child behind", async () => {
		const root = runtimeWorkspace();
		const contract = runtimeContract({
			required: ["runtime_smoke"],
			criteria: [{ id: "AC-1", verifiers: ["runtime_smoke"], scope: "service" }],
			runtime: {
				smoke: {
					command: `node ${runtimeFixture("service.mjs")} --fail`,
					ready: { log: "SERVICE_READY", timeoutMs: 15_000 },
				},
			},
		});
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });

		const result = await verifyRuntime(contract, root, { artifacts, timeoutMs: 30_000 });

		expect(result.status).toBe("deterministic_failure");
		const record = result.records.find((entry) => entry.kind === "runtime_smoke");
		expect(record?.status).toBe("fail");
		expect(record?.exitCode).toBe(1);

		const captured = artifactText(artifacts, record!.artifactRef!);
		expect(captured.split("\n")[0]).toContain("before the readiness signal");
		expect(captured).toContain("BOOT_STDERR the fixture service cannot bind its port");
		const pid = pidOf(captured, "BOOT_FAILURE pid");
		expect(pid).toBeGreaterThan(0);
		expect(await waitForDeath(pid!)).toBe(true);
	});

	it("fails a silent service at the deadline rather than passing it", async () => {
		const root = runtimeWorkspace();
		const contract = runtimeContract({
			required: ["runtime_smoke"],
			criteria: [{ id: "AC-1", verifiers: ["runtime_smoke"], scope: "service" }],
			runtime: {
				// The service starts and stays up; the declared signal never fires.
				smoke: { command: `node ${runtimeFixture("service.mjs")}`, ready: { log: "NEVER_PRINTED_ANYWHERE", timeoutMs: 700 } },
			},
		});
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });

		const result = await verifyRuntime(contract, root, { artifacts, timeoutMs: 30_000 });

		const record = result.records.find((entry) => entry.kind === "runtime_smoke");
		expect(record?.status).toBe("fail");
		const captured = artifactText(artifacts, record!.artifactRef!);
		expect(captured).toContain("timed out after 700ms");
		const pid = pidOf(captured, "SERVICE_PID");
		expect(pid).toBeGreaterThan(0);
		expect(await waitForDeath(pid!)).toBe(true);
		expect(isAlive(pid!)).toBe(false);
	});
});

describe("AC-2 — CLI invocation compares the real invocation against the declared expectation", () => {
	const cliContract = (expect: Record<string, unknown>) =>
		runtimeContract({
			required: ["cli_invocation"],
			criteria: [{ id: "AC-2", verifiers: ["cli_invocation"], scope: "cli" }],
			runtime: { cli: { command: `node ${runtimeFixture("cli.mjs")}`, stdin: "world\n", expect } },
		});

	it("passes when the binary emits exactly what the contract declares", async () => {
		const root = runtimeWorkspace();
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });
		const contract = cliContract({ exitCode: 0, stdoutContains: ["CLI_STDOUT hello world"], stderrContains: ["CLI_STDERR"] });

		const result = await verifyRuntime(contract, root, { artifacts, timeoutMs: 30_000 });

		expect(result.status).toBe("pass");
		const record = result.records.find((entry) => entry.kind === "cli_invocation");
		expect(record?.status).toBe("pass");
		expect(record?.exitCode).toBe(0);
		const captured = artifactText(artifacts, record!.artifactRef!);
		// The marker proves the invocation happened with the declared stdin.
		expect(captured).toContain("CLI_STDOUT hello world");
		expect(captured).toContain("exit: exit 0");
		expect(captured).toContain('stdin: "world\\n"');
	});

	it("fails on an expectation the binary does not emit, naming the mismatch", async () => {
		const root = runtimeWorkspace();
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });
		const contract = cliContract({ exitCode: 0, stdoutContains: ["CLI_STDOUT goodbye world"] });

		const result = await verifyRuntime(contract, root, { artifacts, timeoutMs: 30_000 });

		expect(result.status).toBe("deterministic_failure");
		const record = result.records.find((entry) => entry.kind === "cli_invocation");
		expect(record?.status).toBe("fail");
		expect(record?.exitCode).toBe(0);
		const captured = artifactText(artifacts, record!.artifactRef!);
		expect(captured.split("\n")[0]).toContain('stdout did not contain "CLI_STDOUT goodbye world"');
		// The real output is still there: the run happened, the expectation did not hold.
		expect(captured).toContain("CLI_STDOUT hello world");
	});

	it("fails on an exit code the binary does not return, naming both values", async () => {
		const root = runtimeWorkspace();
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });
		const contract = cliContract({ exitCode: 7, stdoutContains: ["CLI_STDOUT hello world"] });

		const result = await verifyRuntime(contract, root, { artifacts, timeoutMs: 30_000 });

		const record = result.records.find((entry) => entry.kind === "cli_invocation");
		expect(record?.status).toBe("fail");
		expect(artifactText(artifacts, record!.artifactRef!).split("\n")[0]).toContain("the exit code was 0, the contract expects 7");
	});
});
