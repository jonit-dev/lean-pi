/**
 * PRD-004 Phase 3 — AC-8: the four state containers stay independent.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compileRecordOf, compileTask } from "../../src/index.js";
import { answerScript, harness, packet, type CompilerHarness } from "./helpers.js";

let active: CompilerHarness | undefined;

afterEach(async () => {
	await active?.close();
	active = undefined;
});

describe("PRD-004 AC-8 — separated task state", () => {
	it("recording an execution attempt leaves the other three containers untouched", async () => {
		active = await harness([answerScript({ choices: { localized: "yes" } })]);
		const contract = await compileTask("change the button text from Deploy to Publish", packet({
			task: { user_request: "change the button text from Deploy to Publish" },
			workspace: { changed_files: ["src/button.ts"], likely_modules: ["src"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
		}));
		const state = compileRecordOf(contract)!.state;

		const before = state.snapshot();
		state.recordAttempt("first attempt failed");
		const after = state.snapshot();

		expect(after.execution.attempts).toBe(1);
		expect(after.execution.last_error).toBe("first attempt failed");
		expect(JSON.stringify(after.planning)).toBe(JSON.stringify(before.planning));
		expect(JSON.stringify(after.verification)).toBe(JSON.stringify(before.verification));
		expect(JSON.stringify(after.review)).toBe(JSON.stringify(before.review));

		// Reads are frozen snapshots: a lane cannot mutate the record through them.
		const execution = state.execution();
		expect(Object.isFrozen(execution)).toBe(true);
		expect(() => {
			(execution as { attempts: number }).attempts = 99;
		}).toThrow();
		expect(state.execution().attempts).toBe(1);
	});

	it("the assembled contract is frozen: writing the snapshot throws", async () => {
		active = await harness([answerScript({ choices: { localized: "yes" } })]);
		const request = "change the button text from Deploy to Publish";
		const contract = await compileTask(request, packet({
			task: { user_request: request },
			workspace: { changed_files: ["src/button.ts"], likely_modules: ["src"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
		}));

		expect(Object.isFrozen(contract)).toBe(true);
		expect(Object.isFrozen(contract.task)).toBe(true);
		expect(() => {
			(contract.task as { prd_required: boolean }).prd_required = true;
		}).toThrow();
		expect(() => {
			contract.verification.required.push("invented");
		}).toThrow();
		expect(contract.task.prd_required).toBe(false);
	});
});
