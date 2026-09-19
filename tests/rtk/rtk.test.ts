/**
 * PRD-019 Phases 1 and 2 — AC-1 to AC-5: optional reduction with guaranteed raw
 * recovery, the per-call records, and the default-off JEV site.
 *
 * Every case drives the real PRD-014 artifact store and real child processes; the
 * spawn counter wraps the real spawn rather than replacing it, which is what makes
 * AC-2's "zero reducer spawns" and AC-1's "reduced" assertions refer to the same
 * code path.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createArtifactStore } from "../../src/context/artifacts.js";
import { buildWorkingState, stubSources } from "../../src/context/working-state.js";
import {
	appendRtkCall,
	armOf,
	reduceToolOutput,
	rtkCallsOf,
	RTK_POLICY_QUESTION_ID,
	RTK_SITE_ID,
	rtkPolicyQuestion,
	spawnReducerProcess,
} from "../../src/rtk/index.js";
import { getSite, listSites } from "../../src/jev/registry.js";
import type { JevQuestion, JevResult } from "../../src/jev/types.js";
import { tempDir } from "../helpers/fixtures.js";
import { countingSpawn, FAILING_REDUCER, HANGING_REDUCER, REDUCING_REDUCER, reducerCommand, rtkConfig } from "./helpers.js";

/** ~104 KB, 2000 lines: above the 64 KB floor §57 and AC-1 both speak of. */
const BIG_OUTPUT = Array.from({ length: 2000 }, (_, index) => `line ${index}: ${"x".repeat(40)}`).join("\n");

/** ~25 KB of grep matches: inside the default ambiguous band, and reference material by class. */
const AMBIGUOUS_OUTPUT = Array.from({ length: 800 }, (_, index) => `src/file${index}.ts:${index}: TODO fix me`).join("\n");

const SMALL_OUTPUT = "ok\n".repeat(20);

function store() {
	return createArtifactStore({ sessionDir: tempDir("leanpi-rtk-"), thresholdBytes: 1 << 20 });
}

function jevStub(choice: string, confidence: number) {
	const calls: Array<{ siteId: string; questions: JevQuestion[]; state: unknown }> = [];
	return {
		calls,
		client: {
			ask: async (siteId: string, questions: JevQuestion[], state: unknown): Promise<JevResult[]> => {
				calls.push({ siteId, questions, state });
				return [{ kind: "Choice", questionId: RTK_POLICY_QUESTION_ID, choice, probabilities: {}, confidence }];
			},
			fallbackCount: () => 0,
		},
	};
}

describe("PRD-019 Phase 1 — optional reduction with guaranteed raw recovery", () => {
	it("AC-1: rtk: on reduces >64 KB and the artifact expands to the identical bytes", async () => {
		const artifacts = store();
		const counted = countingSpawn();
		const result = await reduceToolOutput(
			{ output: BIG_OUTPUT, kind: "test", sourceRef: "execute:pnpm vitest run", exitCode: 1 },
			{ store: artifacts, config: rtkConfig({ mode: "on", ...reducerCommand(REDUCING_REDUCER) }), spawn: counted.spawn },
		);

		expect(counted.count()).toBe(1);
		expect(result.record.decision).toBe("reduce");
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThan(Buffer.byteLength(BIG_OUTPUT, "utf8"));
		expect(result.text).toMatch(/\[full output: artifact:\/\/test\/[0-9a-f]{64}\]$/);
		expect(result.text).toContain("lines summarized");

		const expanded = artifacts.expand(result.artifact!.artifact!);
		expect(createHash("sha256").update(expanded).digest("hex")).toBe(createHash("sha256").update(Buffer.from(BIG_OUTPUT, "utf8")).digest("hex"));
		expect(result.artifact!.exitCode).toBe(1);
		expect(Number.isNaN(Date.parse(result.artifact!.timestamp))).toBe(false);
		expect(result.record.bytes_out).toBe(Buffer.byteLength(result.text, "utf8"));
		expect(result.record.bytes_in).toBe(Buffer.byteLength(BIG_OUTPUT, "utf8"));
	});

	it("AC-2: rtk: off leaves the output untouched and spawns no reducer", async () => {
		const artifacts = store();
		const counted = countingSpawn();
		const result = await reduceToolOutput(
			{ output: BIG_OUTPUT, kind: "test", sourceRef: "execute:pnpm vitest run", exitCode: 1 },
			{ store: artifacts, config: rtkConfig({ mode: "off", ...reducerCommand(REDUCING_REDUCER) }), spawn: counted.spawn },
		);

		expect(counted.count()).toBe(0);
		expect(result.text).toBe(BIG_OUTPUT);
		expect(result.artifact).toBeNull();
		expect(result.record).toMatchObject({ mode: "off", decision: "keep_raw", decided_by: "mode", bytes_in: Buffer.byteLength(BIG_OUTPUT, "utf8"), unavailable: null });

		// The hook is behavior-preserving at PRD-014's boundary: with `rtk: off` the
		// store's own text reaches the executor byte for byte, at any store threshold.
		// Both captures share one clock so the comparison is about content, not about
		// which millisecond each call happened in.
		const fixedNow = () => new Date("2026-09-19T00:00:00.000Z");
		const compacting = createArtifactStore({ sessionDir: tempDir("leanpi-rtk-off-"), thresholdBytes: 1024, now: fixedNow });
		const plain = compacting.capture({ output: BIG_OUTPUT, kind: "test", sourceRef: "execute:1", exitCode: 1 });
		const hooked = await reduceToolOutput(
			{ output: BIG_OUTPUT, kind: "test", sourceRef: "execute:1", exitCode: 1 },
			{ store: compacting, config: rtkConfig({ mode: "off", ...reducerCommand(REDUCING_REDUCER) }), spawn: counted.spawn, now: fixedNow },
		);
		expect(plain.record).not.toBeNull();
		expect(hooked.text).toBe(plain.text);
		expect(counted.count()).toBe(0);
	});

	it("AC-3: absent, failing and timing-out reducers return raw output and record unavailability", async () => {
		const cases: Array<{ name: string; config: Record<string, unknown>; unavailable: string }> = [
			{ name: "ENOENT", config: { mode: "on", binary: "definitely-not-a-real-rtk-binary", args: [] }, unavailable: "spawn_failed" },
			{ name: "non-zero exit", config: { mode: "on", ...reducerCommand(FAILING_REDUCER) }, unavailable: "nonzero_exit" },
			{ name: "timeout", config: { mode: "on", timeout_ms: 200, ...reducerCommand(HANGING_REDUCER) }, unavailable: "timeout" },
		];

		for (const testCase of cases) {
			const artifacts = store();
			const counted = countingSpawn();
			const result = await reduceToolOutput(
				{ output: BIG_OUTPUT, kind: "test", sourceRef: "execute:pnpm vitest run", exitCode: 1 },
				{ store: artifacts, config: rtkConfig(testCase.config), spawn: counted.spawn },
			);

			expect(counted.count(), testCase.name).toBe(1);
			expect(result.text, testCase.name).toBe(BIG_OUTPUT);
			expect(result.record.decision, testCase.name).toBe("unavailable");
			expect(result.record.unavailable, testCase.name).toBe(testCase.unavailable);
			// Reversible even when the reducer failed: the raw bytes are still expandable.
			expect(createHash("sha256").update(artifacts.expand(result.artifact!.artifact!)).digest("hex")).toBe(createHash("sha256").update(Buffer.from(BIG_OUTPUT, "utf8")).digest("hex"));

			const state = appendRtkCall(buildWorkingState(stubSources({ goal: () => "reduce tool output" })), result.record);
			expect(rtkCallsOf(state)).toHaveLength(1);
			expect(rtkCallsOf(state)[0]!.unavailable).toBe(testCase.unavailable);
		}
	});
});

describe("PRD-019 Phase 2 — auto/experiment modes and the default-off JEV site", () => {
	it("AC-4: auto reduces above the rule's threshold, passes below it through, and records every call", async () => {
		const config = rtkConfig({ mode: "auto", ...reducerCommand(REDUCING_REDUCER) });
		const counted = countingSpawn();
		const artifacts = store();

		const below = await reduceToolOutput({ output: SMALL_OUTPUT, kind: "test", sourceRef: "execute:true" }, { store: artifacts, config, spawn: counted.spawn });
		expect(below.text).toBe(SMALL_OUTPUT);
		expect(below.record).toMatchObject({ mode: "auto", decision: "keep_raw", decided_by: "rule" });

		const above = await reduceToolOutput(
			{ output: BIG_OUTPUT, kind: "test", sourceRef: "execute:pnpm vitest run", exitCode: 1 },
			{ store: artifacts, config, spawn: counted.spawn },
		);
		expect(above.record).toMatchObject({ mode: "auto", decision: "reduce", decided_by: "rule", unavailable: null });
		expect(counted.count()).toBe(1);
		expect(createHash("sha256").update(artifacts.expand(above.artifact!.artifact!)).digest("hex")).toBe(createHash("sha256").update(Buffer.from(BIG_OUTPUT, "utf8")).digest("hex"));

		const state = buildWorkingState(stubSources({ goal: () => "reduce tool output" }));
		appendRtkCall(state, below.record);
		appendRtkCall(state, above.record);
		const records = rtkCallsOf(state);
		expect(records.map((record) => [record.mode, record.decision])).toEqual([
			["auto", "keep_raw"],
			["auto", "reduce"],
		]);
		expect(records[0]!.bytes_in).toBe(Buffer.byteLength(SMALL_OUTPUT, "utf8"));
		expect(records[1]!.bytes_in).toBe(Buffer.byteLength(BIG_OUTPUT, "utf8"));
		expect(records[1]!.bytes_out).toBeLessThan(records[1]!.bytes_in);
	});

	it("AC-4: the experiment arm is stable per task id and selects the arm the hash names", async () => {
		const config = rtkConfig({ mode: "experiment", ...reducerCommand(REDUCING_REDUCER) });
		const artifacts = store();
		const counted = countingSpawn();
		const onId = ["task-0", "task-1", "task-2", "task-3", "task-4"].find((id) => armOf(id) === "on")!;
		const offId = ["task-0", "task-1", "task-2", "task-3", "task-4"].find((id) => armOf(id) === "off")!;

		const first = await reduceToolOutput({ output: BIG_OUTPUT, kind: "test", sourceRef: "execute:1" }, { store: artifacts, config, spawn: counted.spawn, taskId: onId });
		const second = await reduceToolOutput({ output: BIG_OUTPUT, kind: "test", sourceRef: "execute:2" }, { store: artifacts, config, spawn: counted.spawn, taskId: onId });
		const other = await reduceToolOutput({ output: BIG_OUTPUT, kind: "test", sourceRef: "execute:3" }, { store: artifacts, config, spawn: counted.spawn, taskId: offId });

		expect(first.record).toMatchObject({ mode: "experiment", arm: "on", decision: "reduce" });
		expect(second.record.arm).toBe(first.record.arm);
		expect(other.record).toMatchObject({ arm: "off", decision: "keep_raw" });
		expect(other.text).toBe(BIG_OUTPUT);
		expect(counted.count()).toBe(2);
	});

	it("AC-5: the site overrides the rule in the ambiguous band only when enabled, and never fires when disabled", async () => {
		const artifacts = store();
		const counted = countingSpawn();
		const stub = jevStub("reduce", 0.9);

		const enabled = await reduceToolOutput(
			{ output: AMBIGUOUS_OUTPUT, kind: "grep", sourceRef: "execute:grep -rn TODO src" },
			{ store: artifacts, config: rtkConfig({ mode: "auto", jev_policy: true, ...reducerCommand(REDUCING_REDUCER) }), spawn: counted.spawn, jev: stub.client },
		);
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]!.siteId).toBe(RTK_SITE_ID);
		expect(stub.calls[0]!.questions[0]!.id).toBe(RTK_POLICY_QUESTION_ID);
		expect(enabled.record).toMatchObject({ decision: "reduce", decided_by: "site", fallback_used: false });
		expect(createHash("sha256").update(artifacts.expand(enabled.artifact!.artifact!)).digest("hex")).toBe(createHash("sha256").update(Buffer.from(AMBIGUOUS_OUTPUT, "utf8")).digest("hex"));

		const disabledStub = jevStub("reduce", 0.9);
		const disabled = await reduceToolOutput(
			{ output: AMBIGUOUS_OUTPUT, kind: "grep", sourceRef: "execute:grep -rn TODO src" },
			{ store: artifacts, config: rtkConfig({ mode: "auto", ...reducerCommand(REDUCING_REDUCER) }), spawn: counted.spawn, jev: disabledStub.client },
		);
		expect(disabledStub.calls).toHaveLength(0);
		expect(disabled.text).toBe(AMBIGUOUS_OUTPUT);
		expect(disabled.record).toMatchObject({ decision: "keep_raw", decided_by: "rule", fallback_used: true });

		const shyStub = jevStub("reduce", 0.2);
		const shy = await reduceToolOutput(
			{ output: AMBIGUOUS_OUTPUT, kind: "grep", sourceRef: "execute:grep -rn TODO src" },
			{ store: artifacts, config: rtkConfig({ mode: "auto", jev_policy: true, ...reducerCommand(REDUCING_REDUCER) }), spawn: counted.spawn, jev: shyStub.client },
		);
		expect(shyStub.calls).toHaveLength(1);
		expect(shy.record).toMatchObject({ decision: "keep_raw", decided_by: "rule", fallback_used: true });

		// The site is registered with PRD-002's registry, and its non-null fallback answers the rule.
		expect(listSites().map((site) => site.id)).toContain(RTK_SITE_ID);
		const site = getSite(RTK_SITE_ID);
		expect(site.consequence).toBe("low");
		expect(site.telemetryTag).toBe(RTK_SITE_ID);
		expect(
			site.fallback({
				siteId: RTK_SITE_ID,
				reason: "disabled",
				state: { kind: "grep", bytes: Buffer.byteLength(AMBIGUOUS_OUTPUT, "utf8"), lines: 800, structured: true, min_bytes: 16_384, min_lines: 200, ambiguous_band_bytes: [16_384, 65_536] },
				questions: [rtkPolicyQuestion()],
			})[0],
		).toMatchObject({ kind: "Choice", choice: "keep_raw" });
	});

	it("the counter wraps the real spawn, so keep_raw cases cannot have spawned unnoticed", async () => {
		// A negative control for the counter itself: it counts the real spawn, so the
		// off/keep_raw cases above cannot have spawned anything unnoticed.
		const counted = countingSpawn(spawnReducerProcess);
		const artifacts = store();
		await reduceToolOutput({ output: BIG_OUTPUT, kind: "test", sourceRef: "execute:1" }, { store: artifacts, config: rtkConfig({ mode: "auto", ...reducerCommand(REDUCING_REDUCER) }), spawn: counted.spawn });
		expect(counted.commands).toEqual([process.execPath]);
	});
});
