/**
 * The reviewer packet's criterion list, after B1 gave compiled contracts a
 * `verification.criteria` block.
 *
 * `acceptanceCriteriaOf` reads both blocks, and a compiled contract now names
 * the same id in each: the reviewer must still see one criterion per id, with
 * the task's own text — a second entry texted as the bare id would ask the
 * reviewer to judge a criterion that says nothing.
 */
import { describe, expect, it } from "vitest";
import { compileTask } from "../../src/compiler/index.js";
import type { ExecutionContract } from "../../src/compiler/contract.js";
import type { TaskPacket } from "../../src/scout/index.js";
import { acceptanceCriteriaOf } from "../../src/review/packet.js";

const REQUEST = "fix the off-by-one in the ring buffer";

/** A packet that names a changed test file, so the compiler declares a targeted scope. */
const PACKET: TaskPacket = {
	repository: { languages: ["typescript"], project_type: "single", package_manager: "pnpm", dirty: true },
	task: { user_request: REQUEST },
	workspace: {
		changed_files: ["src/ring.ts", "tests/ring.spec.ts"],
		likely_modules: ["src"],
		test_runners: ["vitest"],
		lsp_available: false,
		git_branch: "main",
	},
};

describe("the reviewer packet's criterion list", () => {
	it("lists a compiled contract's criterion once, with the task's text", async () => {
		const contract = await compileTask(REQUEST, PACKET);
		// Non-vacuous: the contract really does carry the id in both blocks.
		expect(contract.task.acceptance_criteria.map((criterion) => criterion.id)).toEqual(["AC-1"]);
		expect(contract.verification.criteria?.map((criterion) => criterion.id)).toEqual(["AC-1"]);

		expect(acceptanceCriteriaOf(contract)).toEqual([{ id: "AC-1", text: REQUEST }]);
	});

	it("still collects a criterion the verification block alone declares", () => {
		const contract = {
			task: { acceptance_criteria: [{ id: "AC-1", text: REQUEST }] },
			verification: { required: ["typecheck"], criteria: [{ id: "AC-2", scope: "tests/ring.spec.ts" }] },
		} as unknown as ExecutionContract;

		expect(acceptanceCriteriaOf(contract)).toEqual([
			{ id: "AC-1", text: REQUEST },
			{ id: "AC-2", text: "AC-2" },
		]);
	});
});
