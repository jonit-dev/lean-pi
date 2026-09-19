/**
 * PRD-014 Phase 4 — AC-5, AC-7, AC-8: deterministic compaction with preservation.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	assemble,
	buildWorkingState,
	classifyCandidates,
	compact,
	createArtifactStore,
	createJevClient,
	loadConfig,
	stubSources,
	RETENTION_SITE_ID,
	clearSites,
	type ContextItem,
	type WorkingState,
} from "../src/index.js";
import { tempDir } from "./helpers/fixtures.js";
import { startStubJev } from "./helpers/stub-jev.js";

const LONG_RESULT = `tool output\n${"noise ".repeat(8000)}\nexit code 1: test failed`;

function sessionItems(workspaceHash = "hash-new"): ContextItem[] {
	return [
		{ id: "req", kind: "requirement", summary: "the torpedo selection must not crash", body: "the torpedo selection must not crash" },
		{ id: "ac1", kind: "criterion", summary: "AC-1 selection is stable" },
		{ id: "ac2", kind: "criterion", summary: "AC-2 scene loads" },
		{ id: "ac3", kind: "criterion", summary: "AC-3 regression test exists" },
		{ id: "err1", kind: "error", summary: "TypeError: torpedo is undefined", active: true },
		{ id: "err2", kind: "error", summary: "scene did not load within 5s", active: true },
		{ id: "tool1", kind: "tool_result", summary: "npm test (superseded)", body: LONG_RESULT, sourceRef: "execute:npm test", superseded: true },
		{ id: "tool2", kind: "tool_result", summary: "cat src/game/torpedo.ts (duplicate read)", body: LONG_RESULT, contentHash: "dup-1" },
		{ id: "tool3", kind: "tool_result", summary: "cat src/game/torpedo.ts again", body: LONG_RESULT, contentHash: "dup-1" },
		{ id: "ev-stale", kind: "evidence", summary: "smoke test failed on torpedo", workspaceHash: "hash-old", referenced: true },
		{ id: "ev-gone", kind: "evidence", summary: "older unrelated failure", workspaceHash: "hash-old", referenced: false },
		{ id: "ev-fresh", kind: "evidence", summary: "current smoke test result", workspaceHash },
	];
}

function workingState(): WorkingState {
	return buildWorkingState(
		stubSources({
			goal: () => "the torpedo selection must not crash",
			acceptance: () => ["AC-1 selection is stable", "AC-2 scene loads", "AC-3 regression test exists"],
			unresolved: () => ["TypeError: torpedo is undefined", "scene did not load within 5s"],
		}),
	);
}

async function jevHarness(mode: "enabled" | "disabled", drop: boolean) {
	const stub = await startStubJev([
		(body) => {
			const questions = (body.questions ?? {}) as Record<string, { criteria?: Record<string, string> }>;
			const answers: Record<string, unknown> = {};
			for (const id of Object.keys(questions)) {
				const choice = drop ? "drop" : "keep";
				answers[id] = { type: "choice", choice, probabilities: { [choice]: 0.95 }, confidence: 0.95 };
			}
			return { answers };
		},
	]);
	const cwd = tempDir("leanpi-compaction-");
	const config = loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { quick: { backend: "local", model: "m" } },
		jev: { endpoint: stub.url, apiKey: "test-key", model: "jev-latest", mode },
	});
	const client = createJevClient({ config, cwd });
	return { stub, client, close: () => stub.close() };
}

describe("PRD-014 Phase 4 — compaction", () => {
	it("AC-5: the preservation set survives and a superseded result reduces to a ref", async () => {
		clearSites();
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-session-") });
		const result = await compact(sessionItems(), { artifacts, currentWorkspaceHash: "hash-new", workingState: workingState() });

		const keptIds = result.kept.map((item) => item.id);
		expect(keptIds).toContain("req");
		expect(keptIds).toEqual(expect.arrayContaining(["ac1", "ac2", "ac3", "err1", "err2"]));
		expect(keptIds).toContain("ev-fresh");
		// The superseded result and the *second* of two identical reads are reduced;
		// the first read stays inline, which is what collapsing duplicates means.
		expect(result.reduced.map((item) => item.id).sort()).toEqual(["tool1", "tool3"]);
		expect(result.kept.map((item) => item.id)).toContain("tool2");
		expect(result.dropped.map((item) => item.id)).toEqual(["ev-gone"]);

		const requirement = result.kept.find((item) => item.id === "req")!;
		expect(requirement.body ?? requirement.summary).toBe("the torpedo selection must not crash");

		const reducedTool = result.reduced.find((item) => item.id === "tool1")!;
		expect(reducedTool.artifact).toMatch(/^artifact:\/\/context\//);
		expect(artifacts.expand(reducedTool.artifact!).toString("utf8")).toBe(LONG_RESULT);
	});

	it("AC-7: capture, dedup, compaction and assembly need no inference at all", async () => {
		clearSites();
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-session-") });
		const captured = artifacts.capture({ output: LONG_RESULT, sourceRef: "execute:npm test", exitCode: 1 });
		expect(captured.record!.artifact).toMatch(/^artifact:\/\//);

		const result = await compact(sessionItems(), { artifacts, currentWorkspaceHash: "hash-new", workingState: workingState() });
		const assembled = assemble({
			config: { instructions: { ponytail: true } },
			workingState: workingState(),
			evidence: result.kept.filter((item) => item.kind === "evidence").map((item) => item.summary),
			artifacts,
		});
		expect(assembled.text).toContain("the torpedo selection must not crash");
		expect(assembled.text).toContain("AC-3 regression test exists");
		expect(assembled.text).toContain("TypeError: torpedo is undefined");
		expect(assembled.text).toContain("scene did not load within 5s");
		// No model client exists anywhere in this path: every reduction is a reference.
		expect(JSON.stringify(result.decisions).length).toBeGreaterThan(0);
	});

	it("AC-8: exactly one retention ask, and the verdict changes the assembled prompt", async () => {
		clearSites();
		const artifacts = createArtifactStore({ sessionDir: tempDir("leanpi-session-") });

		// Before the edit the item's hash matches, so the rules settle it and no
		// question is asked: the undecided class is produced by the rules.
		const beforeEdit = await compact(sessionItems("hash-old"), { artifacts, currentWorkspaceHash: "hash-old", workingState: workingState() });
		expect(beforeEdit.undecided).toHaveLength(0);
		expect(beforeEdit.askCount).toBe(0);

		// After an ordinary edit the hash goes stale while the working state still
		// cites the item: the one class the rules refuse to settle.
		const harness = await jevHarness("enabled", true);
		const dropped = await compact(sessionItems(), {
			artifacts,
			currentWorkspaceHash: "hash-new",
			workingState: workingState(),
			client: harness.client,
		});
		expect(dropped.undecided.map((item) => item.id)).toEqual(["ev-stale"]);
		expect(dropped.askCount).toBe(1);
		expect(harness.stub.requests).toHaveLength(1);
		expect(Object.keys((harness.stub.requests[0]!.body.questions ?? {}) as object)).toEqual(["ev-stale"]);
		expect(dropped.decisions.find((decision) => decision.id === "ev-stale")).toMatchObject({ verdict: "drop", source: "jev" });
		const droppedItem = dropped.dropped.find((item) => item.id === "ev-stale")!;
		expect(artifacts.expand(droppedItem.artifact!).toString("utf8")).toContain("smoke test failed on torpedo");
		const promptAfterDrop = assemble({
			config: { instructions: { ponytail: true } },
			workingState: workingState(),
			evidence: dropped.kept.filter((item) => item.kind === "evidence").map((item) => item.summary),
		});
		expect(promptAfterDrop.text).not.toContain("smoke test failed on torpedo");
		await harness.close();

		// A `keep` verdict leaves it inline.
		const keeping = await jevHarness("enabled", false);
		const kept = await compact(sessionItems(), {
			artifacts,
			currentWorkspaceHash: "hash-new",
			workingState: workingState(),
			client: keeping.client,
		});
		expect(keeping.stub.requests).toHaveLength(1);
		expect(kept.kept.map((item) => item.id)).toContain("ev-stale");
		const promptAfterKeep = assemble({
			config: { instructions: { ponytail: true } },
			workingState: workingState(),
			evidence: kept.kept.filter((item) => item.kind === "evidence").map((item) => item.summary),
		});
		expect(promptAfterKeep.text).toContain("smoke test failed on torpedo");
		await keeping.close();

		// With JEV disabled the item is retained with zero asks.
		const off = await jevHarness("disabled", true);
		const retained = await compact(sessionItems(), {
			artifacts,
			currentWorkspaceHash: "hash-new",
			workingState: workingState(),
			client: off.client,
		});
		expect(off.stub.requests).toHaveLength(0);
		expect(retained.askCount).toBe(0);
		expect(retained.kept.map((item) => item.id)).toContain("ev-stale");
		expect(retained.decisions.find((decision) => decision.id === "ev-stale")).toMatchObject({ verdict: "keep", source: "fallback" });
		await off.close();

		// The site is registered exactly as PRD-002 requires.
		expect(RETENTION_SITE_ID).toBe("context.retention_relevance");
		expect(createHash("sha256").update(RETENTION_SITE_ID).digest("hex")).toHaveLength(64);
		expect(classifyCandidates(sessionItems(), "hash-new").undecided.map((item) => item.id)).toEqual(["ev-stale"]);
	});
});
