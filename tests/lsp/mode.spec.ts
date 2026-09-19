/**
 * PRD-018 Phase 1 — AC-1, AC-2, AC-3, AC-4 (contract side) and AC-9.
 *
 * Every assertion is made against the contract the *real* PRD-004 compiler
 * produced with the real LSP provider registered — never against the selector
 * called directly — so the wiring is covered with the logic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ChildProcessModule from "node:child_process";
import { lspProcessStats, lspSelectionOf, lspTelemetryOf, lspToolsForTurn } from "../../src/lsp/index.js";
import type { ExecutionContract } from "../../src/index.js";
import { verifyTask } from "../../src/verify/index.js";
import { typedAnswers, type StubJevResponder } from "../helpers/stub-jev.js";
import { harness, lintOnlyRepo, onSystemPath, taskPacket, tsRepo, type LspHarness } from "./harness.js";

/** Every process this file's code tried to start, so "zero spawns" is measured. */
const spawnCalls: string[] = [];

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcessModule>();
	return {
		...actual,
		spawn: (...args: Parameters<typeof actual.spawn>) => {
			spawnCalls.push(String(args[0]));
			return actual.spawn(...args);
		},
	};
});

let active: LspHarness | undefined;

afterEach(async () => {
	await active?.close();
	active = undefined;
	spawnCalls.length = 0;
});

const RENAME_REQUEST = "rename the exported greet symbol across the repository";
const RENAME_PACKET = taskPacket(RENAME_REQUEST);

const MARKDOWN_REQUEST = "update the readme section headings";
const MARKDOWN_PACKET = taskPacket(MARKDOWN_REQUEST, {
	workspace: { changed_files: ["README.md"], likely_modules: ["."], test_runners: [], lsp_available: true, git_branch: "main" },
});

/** A rename task with a Markdown report alongside it: mixed set, rename is decisive. */
const MIXED_RENAME_PACKET = taskPacket(RENAME_REQUEST, {
	workspace: { changed_files: ["src/symbols.ts", "src/caller.ts", "README.md"], likely_modules: ["src"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
});

/** Keyword-free: PRD-004's classifier leaves it `task`, so the table cannot decide. */
const AMBIGUOUS_REQUEST = "adjust the greeting text so it reads more naturally";
const AMBIGUOUS_PACKET = taskPacket(AMBIGUOUS_REQUEST, {
	workspace: { changed_files: ["README.md", "src/symbols.ts"], likely_modules: ["src"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
});

const BUGFIX_REQUEST = "fix the wrong port constant in src/symbols.ts";
const BUGFIX_PACKET = taskPacket(BUGFIX_REQUEST);

/** The JEV answer AC-9 asserts on: the site chooses navigation for the ambiguous task. */
const chooseNavigation: StubJevResponder = (body) => ({
	answers: typedAnswers(body, { lsp_mode: { type: "choice", choice: "LSP_NAVIGATION", probabilities: { LSP_NAVIGATION: 1 }, confidence: 0.95 } }),
});

/** The parts of a turn's LSP decision that must not depend on JEV being reachable. */
function lspOutcome(contract: ExecutionContract) {
	const selection = lspSelectionOf(contract);
	return {
		mode: selection?.mode,
		reason: selection?.reason,
		tied: selection?.tied,
		jevSiteUsed: selection?.jevSiteUsed,
		capability: contract.capabilities.lsp,
		tools: lspToolsForTurn(contract),
	};
}

describe("PRD-018 Phase 1 — deterministic mode selection", () => {
	it("AC-1: a Markdown-only change is LSP_OFF with zero servers, identically with JEV on and off", async () => {
		const spawnedBefore = lspProcessStats.spawned;

		active = await harness({ lsp: { mode: "auto" }, jev: "enabled" });
		const withJev = await active.compile(MARKDOWN_REQUEST, MARKDOWN_PACKET);
		expect(lspSelectionOf(withJev)!.mode).toBe("LSP_OFF");
		expect(lspSelectionOf(withJev)!.reason).toBe("no-server-for-changed-language");
		expect(withJev.capabilities.lsp).toBe(false);
		expect(lspToolsForTurn(withJev)).toEqual([]);
		await active.close();
		active = undefined;

		active = await harness({ lsp: { mode: "auto" }, jev: "disabled" });
		const withoutJev = await active.compile(MARKDOWN_REQUEST, MARKDOWN_PACKET);

		expect(lspOutcome(withoutJev)).toEqual(lspOutcome(withJev));
		expect(spawnCalls.filter((command) => command.includes("language-server"))).toEqual([]);
		expect(spawnCalls).toEqual([]);
		expect(lspProcessStats.spawned).toBe(spawnedBefore);
	});

	it("AC-2: a TypeScript exported-symbol rename is LSP_NAVIGATION, identically with JEV on and off", async () => {
		active = await harness({ lsp: { mode: "auto" }, jev: "enabled" });
		const withJev = await active.compile(RENAME_REQUEST, RENAME_PACKET);
		expect(lspSelectionOf(withJev)!.mode).toBe("LSP_NAVIGATION");
		expect(withJev.capabilities.lsp).toBe(true);
		expect(lspToolsForTurn(withJev)).toEqual([
			"lsp_definition",
			"lsp_references",
			"lsp_hover",
			"lsp_document_symbols",
			"lsp_workspace_symbols",
			"lsp_call_hierarchy",
		]);
		await active.close();
		active = undefined;

		active = await harness({ lsp: { mode: "auto" }, jev: "disabled" });
		const withoutJev = await active.compile(RENAME_REQUEST, RENAME_PACKET);
		expect(lspOutcome(withoutJev)).toEqual(lspOutcome(withJev));

		// A Markdown report alongside the rename does not soften it: the task type decides.
		const mixed = await active.compile(RENAME_REQUEST, MIXED_RENAME_PACKET);
		expect(lspSelectionOf(mixed)!.mode).toBe("LSP_NAVIGATION");
	});

	it("AC-3: `lsp: off` overrides the navigation outcome, with no tools and no server", async () => {
		const spawnedBefore = lspProcessStats.spawned;
		active = await harness({ lsp: { mode: "off" }, jev: "enabled" });
		const contract = await active.compile(RENAME_REQUEST, RENAME_PACKET);

		expect(lspSelectionOf(contract)!.mode).toBe("LSP_OFF");
		expect(lspSelectionOf(contract)!.reason).toBe("project-config:off");
		expect(contract.capabilities.lsp).toBe(false);
		expect(lspToolsForTurn(contract)).toEqual([]);
		expect(lspProcessStats.spawned).toBe(spawnedBefore);
	});

	it("AC-4: a type-checking script turns diagnostics into a mandatory one-shot verifier, a linter does not", async () => {
		// Fixture exposing `npm run typecheck`.
		active = await harness({ cwd: tsRepo().cwd, lsp: { mode: "auto" }, jev: "enabled" });
		const withTypecheck = await active.compile(BUGFIX_REQUEST, BUGFIX_PACKET);
		const targeted = lspSelectionOf(withTypecheck)!;
		expect(targeted.mode).toBe("LSP_OFF");
		expect(targeted.reason).toBe("fr-094-targeted-typecheck");
		expect(targeted.targetedCheck).toEqual({ kind: "typecheck", command: "npm run typecheck", source: "package.json" });
		expect(withTypecheck.verification.required).toContain("typecheck");
		expect(withTypecheck.capabilities.lsp).toBe(false);
		await active.close();
		active = undefined;

		// Control: a `lint` script is style output, not type feedback — diagnostics stand.
		active = await harness({ cwd: lintOnlyRepo().cwd, lsp: { mode: "auto" }, jev: "enabled" });
		const withLint = await active.compile(BUGFIX_REQUEST, BUGFIX_PACKET);
		const selected = lspSelectionOf(withLint)!;
		expect(selected.mode).toBe("LSP_DIAGNOSTICS");
		expect(selected.targetedCheck).toBeUndefined();
		expect(withLint.capabilities.lsp).toBe(true);
		expect(lspToolsForTurn(withLint)).toEqual(["lsp_diagnostics"]);
	});

	it.skipIf(!onSystemPath("npm") || !onSystemPath("tsc"))(
		"AC-4: PRD-009 turns the mandatory marker into a real typecheck evidence record",
		async () => {
			active = await harness({ cwd: tsRepo().cwd, lsp: { mode: "auto" }, jev: "enabled" });
			const contract = await active.compile(BUGFIX_REQUEST, BUGFIX_PACKET);
			expect(lspSelectionOf(contract)!.targetedCheck).toEqual({ kind: "typecheck", command: "npm run typecheck", source: "package.json" });
			expect(contract.verification.required).toContain("typecheck");

			const result = await verifyTask(contract, active.cwd, { commands: { typecheck: "npm run typecheck" }, timeoutMs: 120_000 });
			const records = [...result.records, ...result.staleRecords].filter((record) => record.kind === "typecheck");
			expect(records.length).toBeGreaterThan(0);
			expect(records[0]!.status).toBe("pass");
		},
		120_000,
	);

	it("AC-9: the ambiguous turn reaches `lsp.usefulness` — JEV's answer, or the cheapest fallback", async () => {
		active = await harness({ lsp: { mode: "auto" }, jev: "enabled", responders: [chooseNavigation] });
		const answered = await active.compile(AMBIGUOUS_REQUEST, AMBIGUOUS_PACKET);
		const answeredSelection = lspSelectionOf(answered)!;
		expect(answeredSelection.jevSiteUsed).toBe(true);
		expect(answeredSelection.tied).toEqual(["LSP_OFF", "LSP_DIAGNOSTICS", "LSP_NAVIGATION"]);
		expect(answeredSelection.mode).toBe("LSP_NAVIGATION");
		expect(answeredSelection.fallbackUsed).toBe(false);
		expect(lspTelemetryOf(answered)).toEqual([
			{ site_id: "lsp.usefulness", answer: "LSP_NAVIGATION", confidence: 0.95, fallback_used: false, tokens: { inputTokens: 120, outputTokens: 8 } },
		]);
		await active.close();
		active = undefined;

		active = await harness({ lsp: { mode: "auto" }, jev: "disabled" });
		const fallenBack = await active.compile(AMBIGUOUS_REQUEST, AMBIGUOUS_PACKET);
		const fallbackSelection = lspSelectionOf(fallenBack)!;
		expect(fallbackSelection.jevSiteUsed).toBe(true);
		expect(fallbackSelection.fallbackUsed).toBe(true);
		expect(fallbackSelection.mode).toBe("LSP_OFF");
		expect(lspTelemetryOf(fallenBack)).toEqual([
			{ site_id: "lsp.usefulness", answer: "LSP_OFF", confidence: 0, fallback_used: true, tokens: { inputTokens: 0, outputTokens: 0 } },
		]);
		expect(fallenBack.capabilities.lsp).toBe(false);
	});
});
