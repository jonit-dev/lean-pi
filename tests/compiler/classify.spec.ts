/**
 * PRD-004 Phase 2 — AC-4 and AC-11: independent axes and the capability annotation.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compileRecordOf, compileTask } from "../../src/index.js";
import { typedAnswers } from "../helpers/stub-jev.js";
import { answerScript, harness, packet, unavailableHarness, type CompilerHarness } from "./helpers.js";

let active: CompilerHarness | undefined;

afterEach(async () => {
	await active?.close();
	active = undefined;
});

const CODEMOD_REQUEST = "rename the public Button API across the codebase";
const CODEMOD_PACKET = packet({
	task: { user_request: CODEMOD_REQUEST },
	workspace: {
		changed_files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts"],
		likely_modules: ["src"],
		test_runners: ["vitest"],
		lsp_available: true,
		git_branch: "main",
	},
});

const ALGORITHM_REQUEST = "optimise the sorting algorithm in the scheduler";
const ALGORITHM_PACKET = packet({
	task: { user_request: ALGORITHM_REQUEST },
	workspace: {
		changed_files: ["src/sort.ts"],
		likely_modules: ["src"],
		test_runners: ["vitest"],
		lsp_available: true,
		git_branch: "main",
	},
});

describe("PRD-004 Phase 2 — independent classification axes", () => {
	it("AC-4: a mechanical codemod is LOW/wide-risk and a tested algorithm is HIGH/narrow-risk", async () => {
		active = await harness([
			answerScript({
				choices: {
					mechanical: "yes",
					explicit_result: "yes",
					several_modules: "no",
					unfamiliar_coupled: "no",
					concurrency_perf: "no",
					deterministic_sufficient: "no",
					alters_visible: "yes",
					wide_blast: "yes",
				},
			}),
		]);
		const codemod = await compileTask(CODEMOD_REQUEST, CODEMOD_PACKET);
		expect(codemod.task.execution_complexity).toBe("LOW");
		expect(compileRecordOf(codemod)!.classification.execution_band).toBe("E0");
		expect(Number(codemod.task.review_risk.slice(1))).toBeGreaterThanOrEqual(2);
		await active.close();
		active = undefined;

		active = await harness([
			answerScript({
				choices: {
					mechanical: "no",
					explicit_result: "yes",
					several_modules: "no",
					unfamiliar_coupled: "yes",
					concurrency_perf: "yes",
					deterministic_sufficient: "yes",
					alters_visible: "no",
					wide_blast: "no",
				},
			}),
		]);
		const algorithm = await compileTask(ALGORITHM_REQUEST, ALGORITHM_PACKET);
		expect(algorithm.task.execution_complexity).toBe("HIGH");
		expect(compileRecordOf(algorithm)!.classification.execution_band).toBe("E3");
		expect(algorithm.task.review_risk).toBe("R0");
	});

	it("AC-4: the axes still diverge when every JEV call fails", async () => {
		active = await unavailableHarness();
		const codemod = await compileTask(CODEMOD_REQUEST, CODEMOD_PACKET);
		expect(codemod.task.execution_complexity).toBe("LOW");
		expect(Number(codemod.task.review_risk.slice(1))).toBeGreaterThanOrEqual(2);

		const algorithm = await compileTask(ALGORITHM_REQUEST, ALGORITHM_PACKET);
		expect(algorithm.task.execution_complexity).toBe("HIGH");
		expect(algorithm.task.review_risk).toBe("R0");
	});

	it("AC-11: the contract carries a numeric coding-index floor and no model id", async () => {
		active = await harness([answerScript({ choices: { localized: "yes" }, scores: { index: 0 } })]);
		const cheap = await compileTask("change the button text from Deploy to Publish", packet({
			task: { user_request: "change the button text from Deploy to Publish" },
			workspace: { changed_files: ["src/button.ts"], likely_modules: ["src"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
		}));
		await active.close();
		active = undefined;

		active = await harness([answerScript({ choices: { architecture: "yes", specialization: "runtime" }, scores: { index: 3 } })]);
		const strong = await compileTask("replace the networking implementation while maintaining compatibility", packet({
			task: { user_request: "replace the networking implementation while maintaining compatibility" },
			repository: { languages: ["rust"], project_type: "single", package_manager: "cargo", dirty: true },
			workspace: { changed_files: ["src/net.rs"], likely_modules: ["src"], test_runners: ["cargo test"], lsp_available: true, git_branch: "main" },
		}));

		expect(typeof cheap.task.required_capability.min_coding_index).toBe("number");
		expect(cheap.task.required_capability.min_coding_index).toBeLessThan(strong.task.required_capability.min_coding_index);
		expect(strong.task.required_capability.specialization).toBe("runtime");
		await active.close();
		active = undefined;

		// With JEV off the specialization falls back to the scout's dominant language.
		active = await unavailableHarness();
		const offline = await compileTask("replace the networking implementation while maintaining compatibility", packet({
			task: { user_request: "replace the networking implementation while maintaining compatibility" },
			repository: { languages: ["rust"], project_type: "single", package_manager: "cargo", dirty: true },
			workspace: { changed_files: ["src/net.rs"], likely_modules: ["src"], test_runners: ["cargo test"], lsp_available: true, git_branch: "main" },
		}));
		expect(offline.task.required_capability.specialization).toBe("rust");
		expect(typeof offline.task.required_capability.min_coding_index).toBe("number");
		// The annotation is not a model: no vendor or model id appears on the contract.
		const serialized = JSON.stringify(strong);
		expect(serialized).not.toMatch(/claude|gpt-|opus|sonnet|kimi|qwen/i);
		expect(strong.routing.executor_backend).toBe("unresolved");
	});

	it("AC-6 (serial): a failing sibling cannot contaminate decisions or token usage", async () => {
		// Distinguishable per-site usage. Under overlapping asks, the shared
		// `lastUsage()` would let the risk fallback (zero) overwrite the capability
		// site's 222, and the shared `fallbackCount()` would flip a successful
		// sibling to heuristics.
		const usageFor = (ids: string[]): number =>
			ids.includes("mechanical") ? 111 : ids.includes("specialization") ? 222 : ids.includes("wide_blast") ? 333 : 55;
		active = await harness([
			(body) => {
				const ids = Object.keys((body.questions ?? {}) as Record<string, unknown>);
				if (ids.includes("wide_blast")) return { status: 500 };
				return { answers: typedAnswers(body), usage: { input_tokens: usageFor(ids), output_tokens: 1 } };
			},
		]);
		const contract = await compileTask("add a helper and its test", packet({
			task: { user_request: "add a helper and its test" },
			workspace: { changed_files: ["src/helper.ts"], likely_modules: ["src"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
		}));
		const rows = compileRecordOf(contract)!.telemetry;
		const byId = Object.fromEntries(rows.map((row) => [row.site_id, row]));

		// Each site carries its own usage: sequential asks cannot attribute a sibling's.
		expect(byId["classify.execution_complexity"]!.tokens.inputTokens).toBe(111);
		expect(byId["classify.required_capability"]!.tokens.inputTokens).toBe(222);
		// The risk site failed; its fallback is deterministic and spends nothing.
		expect(byId["classify.review_risk_input"]!.fallback_used).toBe(true);
		expect(byId["classify.review_risk_input"]!.tokens.inputTokens).toBe(0);
		// And the successful siblings are not marked as fallbacks.
		expect(byId["classify.execution_complexity"]!.fallback_used).toBe(false);
		expect(byId["classify.required_capability"]!.fallback_used).toBe(false);
	});
});
