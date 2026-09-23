/**
 * PRD-014 Phase 2 — AC-4: the structured working state.
 */
import { describe, expect, it } from "vitest";
import { buildWorkingState, serializeWorkingState, stubSources, WORKING_STATE_MAX_BYTES } from "../src/index.js";
import { runLanes } from "../src/commands/session.js";
import { loadConfig } from "../src/core/config.js";
import { tempDir } from "./helpers/fixtures.js";

const SOURCES = () =>
	stubSources({
		goal: () => "make the torpedo selection stop crashing",
		acceptance: () => ["AC-1 selection is stable", "AC-2 scene loads", "AC-3 regression test exists"],
		filesTouched: () => ["src/game/torpedo.ts", "src/game/scene.ts"],
		failingEvidence: () => ({ summary: "runtime smoke test: scene did not load", workspaceHash: "abc123" }),
		verificationByKind: () => ({ typecheck: "pass", affected_tests: "pass", runtime_smoke: "fail" }),
		attempts: () => 2,
		unresolved: () => ["is the crash deterministic on the first selection?"],
	});

describe("PRD-014 Phase 2 — working state", () => {
	it("AC-4: all seven fields serialize inside the ceiling and do not depend on chat history", () => {
		const state = buildWorkingState(SOURCES());
		const serialized = serializeWorkingState(state);

		expect(Object.keys(state).sort()).toEqual([
			"acceptance",
			"attempts",
			"current_failure",
			"files_touched",
			"goal",
			"unresolved",
			"verification",
		]);
		expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(3000);
		expect(state.current_failure).toContain("scene did not load");

		// Rebuilding is byte-identical: the record is sourced, never replayed. Chat
		// history is not an input to the builder at all — emptying the transcript
		// cannot change a byte of this output.
		const rebuilt = serializeWorkingState(buildWorkingState(SOURCES()));
		expect(rebuilt).toBe(serialized);
		expect(Object.keys(buildWorkingState(SOURCES()))).not.toContain("transcript");
	});

	it("AC-4: an inflated list is truncated with a marker and no named field is lost", () => {
		const files = Array.from({ length: 400 }, (_, index) => `src/game/deeply/nested/module-${index}/file-${index}.ts`);
		const state = buildWorkingState(stubSources({ ...SOURCES(), filesTouched: () => files }), {}, 800);
		const serialized = serializeWorkingState(state);

		expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(800);
		expect(state.files_touched.some((entry) => /^\+\d+ more files$/.test(entry))).toBe(true);
		for (const field of ["goal", "acceptance", "current_failure", "verification", "attempts", "unresolved"]) {
			expect(serialized, field).toContain(field);
		}
	});

	it("AC-4: `context.working_state_max_bytes` bounds the working-state block a session assembles", async () => {
		// The config key was parsed and then never read: `runLanes` called
		// `buildWorkingState` without its third argument, so the block was always
		// cut at the 3000-byte default whatever the operator configured.
		const cwd = tempDir("leanpi-working-state-");
		const config = loadConfig(cwd, {
			configPath: null,
			backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
			models: { quick: { backend: "local", model: "stub-model" } },
			context: { artifact_threshold_bytes: 32_768, compaction_threshold_bytes: 48_000, working_state_max_bytes: 400 },
		});
		const files = Array.from({ length: 400 }, (_, index) => `src/game/deeply/nested/module-${index}/file-${index}.ts`);

		const context = await runLanes(
			{ text: "keep the working state visible" },
			{
				turn: { text: "keep the working state visible" },
				role: "balanced",
				cwd,
				config,
				modelRef: { backend: "local", model: "stub-model", type: "native" },
				skills: [],
				prefix: "",
				workingStateSources: stubSources({ ...SOURCES(), filesTouched: () => files }),
			},
		);

		const block = /working state:\n([\s\S]*)$/.exec(context.prefix)![1]!.trimEnd();
		expect(Buffer.byteLength(block, "utf8")).toBeLessThanOrEqual(400);
	});
});
