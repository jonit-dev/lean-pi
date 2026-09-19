/**
 * PRD-022 E2/E3 — browser test and screenshot comparison (AC-3, AC-4).
 *
 * The browser is the host's, so these specs hand the verifier a facility built on
 * the fixture bytes: the page is served over a real HTTP server and the fake tab
 * answers selector questions from the served HTML, which is why deleting the
 * element from the fixture really does make the assertion fail. The unavailable
 * cases are the important ones — a missing facility or a missing baseline must
 * never be reported as a UI defect or as a pass.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactStore } from "../../src/context/artifacts.js";
import { criteriaOf, evaluateProofGate } from "../../src/proof/index.js";
import { registerRuntimeVerifiers, setBrowserFacility } from "../../src/runtime/index.js";
import { decodePng } from "../../src/runtime/png.js";
import { tempDir } from "../helpers/fixtures.js";
import { EvidenceStore } from "../../src/verify/evidence.js";
import {
	artifactText,
	copyFixture,
	fakeBrowser,
	runtimeContract,
	runtimeFixture,
	runtimeWorkspace,
	staticServer,
	verifyRuntime,
	withRuntimePlan,
	type StaticServer,
} from "./support.js";

registerRuntimeVerifiers();

const PAGE = runtimeFixture("web/index.html");
const REMOVED = runtimeFixture("web/element-removed.html");
const BASELINE = runtimeFixture("web/baseline.png");
const UNCHANGED = runtimeFixture("web/capture-unchanged.png");
const SHIFTED = runtimeFixture("web/capture-shifted.png");

/** A workspace holding the page fixture, plus the server that serves it. */
async function pageWorkspace(): Promise<{ root: string; server: StaticServer }> {
	const root = runtimeWorkspace();
	copyFixture(runtimeFixture("web"), join(root, "web"));
	return { root, server: await staticServer(join(root, "web")) };
}

function browserContract(url: string) {
	return runtimeContract({
		required: ["browser_test"],
		criteria: [{ id: "AC-1", verifiers: ["browser_test"], scope: "web/index.html" }],
		runtime: { browser: { url, selectors: ["#app"], text: ["Ready"] } },
	});
}

describe("AC-3 — browser_test drives the facility and asserts only what was declared", () => {
	it("passes the page fixture and records a trace of what it drove", async () => {
		const { root, server } = await pageWorkspace();
		const browser = fakeBrowser({ page: PAGE });
		setBrowserFacility(browser.facility);
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });
		try {
			const result = await verifyRuntime(browserContract(server.url), root, { artifacts, timeoutMs: 30_000 });

			expect(result.status).toBe("pass");
			const record = result.records.find((entry) => entry.kind === "browser_test");
			expect(record?.status).toBe("pass");
			// The verifier went to the declared URL and closed the tab it opened.
			expect(browser.visited).toEqual([server.url]);
			expect(browser.closed()).toBe(1);
			expect(record?.scope).toBe("web/index.html");

			const trace = artifactText(artifacts, record!.artifactRef!);
			const parsed = JSON.parse(trace.split("\n").slice(1).join("\n")) as { url: string; steps: Array<{ step: string; target: string; result: string }> };
			expect(parsed.url).toBe(server.url);
			expect(parsed.steps.map((step) => [step.step, step.target])).toEqual([
				["goto", server.url],
				["selector", "#app"],
				["text", "Ready"],
			]);
			expect(parsed.steps[1]!.result).toContain("1 match(es)");
		} finally {
			setBrowserFacility(undefined);
			await server.close();
		}
	});

	it("fails naming the selector when the fixture no longer renders it", async () => {
		const { root, server } = await pageWorkspace();
		const browser = fakeBrowser({ page: REMOVED });
		setBrowserFacility(browser.facility);
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });
		try {
			const result = await verifyRuntime(browserContract(server.url), root, { artifacts, timeoutMs: 30_000 });

			expect(result.status).toBe("deterministic_failure");
			const record = result.records.find((entry) => entry.kind === "browser_test");
			expect(record?.status).toBe("fail");
			// The record carries no reason (PRD-009 keeps it in the artifact), so the
			// artifact's first line is where the selector is named.
			expect(artifactText(artifacts, record!.artifactRef!).split("\n")[0]).toContain('selector "#app" matched no element');

			// And the selector is only matched against that page: the good page still passes.
			const good = fakeBrowser({ page: PAGE });
			setBrowserFacility(good.facility);
			const rerun = await verifyRuntime(browserContract(server.url), root, { artifacts: createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") }), timeoutMs: 30_000 });
			expect(rerun.records.find((entry) => entry.kind === "browser_test")?.status).toBe("pass");
		} finally {
			setBrowserFacility(undefined);
			await server.close();
		}
	});

	it("records unavailable with no facility, and the gate reports missing evidence rather than a UI defect", async () => {
		const { root, server } = await pageWorkspace();
		setBrowserFacility(null);
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });
		const store = new EvidenceStore();
		const contract = runtimeContract({
			required: ["browser_test"],
			criteria: [{ id: "AC-1", verifiers: ["browser_test"], scope: "web/index.html" }],
			runtime: { browser: { url: server.url, selectors: ["#app"] } },
			rounds: 1,
		});
		try {
			const result = await verifyRuntime(contract, root, { artifacts, timeoutMs: 30_000, store });

			const record = result.records.find((entry) => entry.kind === "browser_test");
			expect(record?.status).toBe("unavailable");
			expect(record?.status).not.toBe("pass");
			expect(record?.status).not.toBe("fail");
			expect(artifactText(artifacts, record!.artifactRef!).split("\n")[0]).toContain("no browser facility");

			// The gate reads it as missing evidence: an unavailable measurement is not a
			// measurement, so recovery runs the verifier again and still refuses to pass.
			const gate = await withRuntimePlan(contract, () =>
				evaluateProofGate(criteriaOf(contract), { workspaceHash: record!.workspaceHash }, { contract, store, cwd: root, artifacts }),
			);
			expect(gate.decision).toBe("BLOCKED");
			expect(gate.decision).not.toBe("FAILED");
			expect(gate.criteria[0]!.packet.known_gaps.join(" ")).toContain("unavailable: browser_test");
			expect(gate.attempts).toContainEqual(
				expect.objectContaining({ kind: "gather", target: "browser_test", status: "unavailable" }),
			);
		} finally {
			setBrowserFacility(undefined);
			await server.close();
		}
	});
});

describe("AC-4 — screenshot_compare compares against the stored baseline", () => {
	const shotContract = (url: string, threshold = 0.01) =>
		runtimeContract({
			required: ["screenshot_compare"],
			criteria: [{ id: "AC-4", verifiers: ["screenshot_compare"], scope: "web/baseline.png" }],
			runtime: { screenshot: { url, baseline: "web/baseline.png", threshold } },
		});

	it("passes an unchanged page", async () => {
		const { root, server } = await pageWorkspace();
		setBrowserFacility(fakeBrowser({ page: PAGE, capture: UNCHANGED }).facility);
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });
		try {
			const result = await verifyRuntime(shotContract(server.url), root, { artifacts, timeoutMs: 30_000 });

			expect(result.status).toBe("pass");
			const record = result.records.find((entry) => entry.kind === "screenshot_compare");
			expect(record?.status).toBe("pass");
			// The artifact is a real PNG of the compared capture.
			expect(decodePng(artifacts.expand(record!.artifactRef!)).width).toBe(200);
		} finally {
			setBrowserFacility(undefined);
			await server.close();
		}
	});

	it("fails a shifted element above the threshold and stores the diff image", async () => {
		const { root, server } = await pageWorkspace();
		setBrowserFacility(fakeBrowser({ page: PAGE, capture: SHIFTED }).facility);
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });
		try {
			const result = await verifyRuntime(shotContract(server.url), root, { artifacts, timeoutMs: 30_000 });

			expect(result.status).toBe("deterministic_failure");
			const record = result.records.find((entry) => entry.kind === "screenshot_compare");
			expect(record?.status).toBe("fail");
			expect(record?.artifactRef).toContain("artifact://screenshot_compare/");

			// The diff image is retrievable through the recorded reference, and it is a
			// diff: the moved block is painted red.
			const decoded = decodePng(artifacts.expand(record!.artifactRef!));
			expect([decoded.width, decoded.height]).toEqual([200, 120]);
			let red = 0;
			for (let at = 0; at < decoded.rgba.length; at += 4) {
				if (decoded.rgba[at] === 255 && decoded.rgba[at + 1] === 0 && decoded.rgba[at + 2] === 0) red += 1;
			}
			expect(red).toBeGreaterThan(0);
			// Same capture against a threshold above the observed difference passes: the
			// comparison, not a literal, is what decides.
			const tolerant = await verifyRuntime(shotContract(server.url, 0.5), root, { artifacts: createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") }), timeoutMs: 30_000 });
			expect(tolerant.records.find((entry) => entry.kind === "screenshot_compare")?.status).toBe("pass");
		} finally {
			setBrowserFacility(undefined);
			await server.close();
		}
	});

	it("records unavailable, naming the path, when the baseline is gone", async () => {
		const { root, server } = await pageWorkspace();
		setBrowserFacility(fakeBrowser({ page: PAGE, capture: UNCHANGED }).facility);
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-runtime-artifacts-") });
		try {
			// Control: with the stored baseline present the identical fixture passes, so
			// the `unavailable` below is caused by the deletion and nothing else.
			const before = await verifyRuntime(shotContract(server.url), root, { artifacts, timeoutMs: 30_000 });
			expect(before.records.find((entry) => entry.kind === "screenshot_compare")?.status).toBe("pass");
			expect(existsSync(BASELINE)).toBe(true);

			rmSync(join(root, "web", "baseline.png"));

			const result = await verifyRuntime(shotContract(server.url), root, { artifacts, timeoutMs: 30_000 });

			const record = result.records.find((entry) => entry.kind === "screenshot_compare");
			expect(record?.status).toBe("unavailable");
			const message = artifactText(artifacts, record!.artifactRef!);
			expect(message).toContain(join(root, "web", "baseline.png"));
			expect(message).toContain("no comparison was made");
		} finally {
			setBrowserFacility(undefined);
			await server.close();
		}
	});
});
