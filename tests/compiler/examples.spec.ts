/**
 * PRD-004 Phase 4 — AC-9, AC-10: the three worked examples and the capability slots.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearCapabilityProviders,
	compileRecordOf,
	compileTask,
	registerCapabilityProvider,
	type CapabilityProvider,
	type TaskPacket,
} from "../../src/index.js";
import { answerScript, harness, packet, type AnswerSpec, type CompilerHarness } from "./helpers.js";

let active: CompilerHarness | undefined;

beforeEach(() => {
	clearCapabilityProviders();
});

afterEach(async () => {
	clearCapabilityProviders();
	await active?.close();
	active = undefined;
});

const EXAMPLES: Array<{
	name: string;
	request: string;
	packet: TaskPacket;
	answers: AnswerSpec;
	executor: string;
	reviewer: string;
	prdRequired: boolean;
	verification: string[];
}> = (() => {
	const trivial: TaskPacket = packet({
		task: { user_request: "Change the button text from Deploy to Publish" },
		workspace: { changed_files: ["src/button.tsx"], likely_modules: ["src"], test_runners: ["vitest"], lsp_available: false, git_branch: "main" },
	});
	const medium: TaskPacket = packet({
		task: { user_request: "Selecting the torpedo sometimes crashes the aircraft game" },
		workspace: { changed_files: ["src/game/torpedo.ts", "src/game/scene.ts"], likely_modules: ["src/game"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
	});
	const major: TaskPacket = packet({
		task: { user_request: "Replace the networking implementation while maintaining compatibility" },
		repository: { languages: ["typescript"], project_type: "monorepo", package_manager: "npm", dirty: true },
		workspace: { changed_files: ["src/net/a.ts", "src/net/b.ts", "src/net/c.ts"], likely_modules: ["src/net", "src/api"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
	});
	return [
		{
			name: "§62 trivial",
			request: trivial.task.user_request,
			packet: trivial,
			answers: { choices: { localized: "yes", ambiguous: "no", architecture: "no", multi_behavior: "no", multi_stage: "no", mechanical: "yes", explicit_result: "yes", deterministic_sufficient: "yes", alters_visible: "no", wide_blast: "no" } },
			executor: "quick",
			reviewer: "none",
			prdRequired: false,
			// B1: the packet's changed files name no test and the harness configures no
			// scope-free targeted command, so the contract must not require a check no
			// surface can name — it would resolve no command and record `not_run`.
			verification: ["typecheck"],
		},
		{
			name: "§63 medium bug",
			request: medium.task.user_request,
			packet: medium,
			answers: { choices: { localized: "yes", ambiguous: "no", architecture: "no", multi_behavior: "no", multi_stage: "no", mechanical: "no", explicit_result: "yes", several_modules: "yes", deterministic_sufficient: "yes", alters_visible: "yes", wide_blast: "yes" } },
			executor: "balanced",
			reviewer: "review_quick",
			prdRequired: false,
			verification: ["typecheck", "runtime_smoke"],
		},
		{
			name: "§64 major feature",
			request: major.task.user_request,
			packet: major,
			answers: { choices: { architecture: "yes", localized: "no", ambiguous: "yes", multi_behavior: "yes", multi_stage: "yes", concurrency_perf: "yes", deterministic_sufficient: "no", alters_visible: "yes", wide_blast: "yes" } },
			executor: "strong",
			reviewer: "review_strong",
			prdRequired: true,
			verification: ["typecheck", "full_suite", "runtime_smoke"],
		},
	];
})();

describe("PRD-004 Phase 4 — worked examples", () => {
	it("AC-9: each example compiles to its documented route", async () => {
		for (const example of EXAMPLES) {
			active = await harness([answerScript(example.answers)]);
			const contract = await compileTask(example.request, example.packet);
			expect(contract.task.prd_required, example.name).toBe(example.prdRequired);
			expect(contract.routing.executor_class, example.name).toBe(example.executor);
			expect(contract.routing.reviewer_class, example.name).toBe(example.reviewer);
			expect(contract.verification.required, example.name).toEqual(example.verification);
			// B1's other half, asserted rather than left implicit in the row above:
			// these packets name no test surface and the harness configures no
			// scope-free targeted command, so the targeted kind is absent and no
			// criterion claims a scope it cannot name.
			expect(contract.verification.required, example.name).not.toContain("affected_tests");
			expect(contract.verification.criteria, example.name).toBeUndefined();
			expect(contract.limits.execution_attempts, example.name).toBeGreaterThan(0);
			expect(compileRecordOf(contract)!.next_stage, example.name).toBe(example.prdRequired ? "prd_lane" : "executor_lane");
			if (example.reviewer === "none") expect(contract.limits.semantic_review_rounds, example.name).toBe(0);
			await active.close();
			active = undefined;
		}
	});

	it("AC-10: capability slots default to empty and are filled by a registered provider", async () => {
		const example = EXAMPLES[0]!;
		active = await harness([answerScript(example.answers)]);
		const bare = await compileTask(example.request, example.packet);
		expect(bare.capabilities.skills).toEqual([]);
		expect(bare.capabilities.mcps).toEqual([]);
		expect(bare.capabilities.lsp).toBe(example.packet.workspace.lsp_available);
		expect(bare.capabilities.rtk).toBe("auto");

		// Negative control: with no provider registered the skill slot stays empty,
		// so the assertion below cannot pass on a value populated elsewhere.
		expect(bare.capabilities.skills).toHaveLength(0);
		await active.close();
		active = undefined;

		const debuggingSim: CapabilityProvider = {
			kind: "skills",
			supply: (draft) =>
				draft.task.type === "bugfix" ? [{ name: "debugging", source: "fixture", body: "debugging body" }] : [],
		};
		const mcpStub: CapabilityProvider = { kind: "mcps", supply: () => [{ name: "filesystem" }] };
		registerCapabilityProvider(debuggingSim);
		registerCapabilityProvider(mcpStub);

		active = await harness([answerScript(EXAMPLES[1]!.answers)]);
		const filled = await compileTask(EXAMPLES[1]!.request, EXAMPLES[1]!.packet);
		expect(filled.task.type).toBe("bugfix");
		expect(filled.capabilities.skills).toEqual([{ name: "debugging", source: "fixture", body: "debugging body" }]);
		expect(filled.capabilities.mcps).toEqual([{ name: "filesystem" }]);
	});
});
