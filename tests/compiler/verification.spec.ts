/**
 * PRD-004 §8 / PRD-009 FR-124 — B1: the contract names the surface it requires.
 *
 * A contract may not demand a check no surface can name: `affected_tests` is
 * required only when the packet's own changed files name a test surface, or when
 * the configured command runs without one. Where the surface is named, the
 * contract carries it in `verification.criteria` — the only place the selector
 * can read a scope for the targeted test from.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compileTask } from "../../src/index.js";
import { packet, unavailableHarness, type CompilerHarness } from "./helpers.js";

let active: CompilerHarness | undefined;

afterEach(async () => {
	await active?.close();
	active = undefined;
});

describe("B1 — the compiled verification block names its targeted surface", () => {
	it("requires affected_tests with the changed test files as its scope", async () => {
		active = await unavailableHarness();
		const contract = await compileTask(
			"fix the parse bug",
			packet({
				workspace: {
					changed_files: ["src/parse.ts", "tests/parse.spec.ts"],
					likely_modules: ["src"],
					test_runners: ["vitest"],
					lsp_available: true,
					git_branch: "main",
				},
			}),
		);

		expect(contract.verification.required).toContain("affected_tests");
		// The surface is structured literal data, quoted only at the shell boundary.
		expect(contract.verification.criteria).toEqual([{ id: "AC-1", verifiers: ["affected_tests"], scope: ["tests/parse.spec.ts"] }]);
	});

	it("does not require a targeted test no surface can name", async () => {
		active = await unavailableHarness();
		const contract = await compileTask(
			"fix the parse bug",
			packet({
				workspace: { changed_files: ["src/parse.ts"], likely_modules: ["src"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
			}),
		);

		expect(contract.verification.required).toContain("typecheck");
		expect(contract.verification.required).not.toContain("affected_tests");
		// No surface is named, so no criterion may claim one.
		expect(contract.verification.criteria).toBeUndefined();
	});

	it("requires it when the configured command resolves without a scope", async () => {
		active = await unavailableHarness({ verify: { commands: { targeted_test: "npm run test:unit" } } });
		const contract = await compileTask(
			"fix the parse bug",
			packet({
				workspace: { changed_files: ["src/parse.ts"], likely_modules: ["src"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
			}),
		);

		expect(contract.verification.required).toContain("affected_tests");
		expect(contract.verification.criteria).toBeUndefined();
	});
});
