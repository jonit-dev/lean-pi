/**
 * PRD-018 Phase 3 — AC-6, AC-7, AC-8 and AC-10.
 *
 * A real `typescript-language-server` runs against the fixture through the same
 * invocation path the executor uses. The suite skips (never fails) when that
 * binary is not on the machine: LSP degrades to `LSP_OFF` there, and so does its
 * proof.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	applyLspTools,
	closeLspClients,
	invokeLspTool,
	NAVIGATION_TOOL_NAMES,
	lspProcessStats,
	lspSelectionOf,
	type LspDiagnostic,
	type LspToolOutcome,
} from "../../src/lsp/index.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { bootLspToolsSession, harness, lintOnlyRepo, onSystemPath, taskPacket, tsRepo, type Fixture, type LspHarness, type LspToolsSession } from "./harness.js";

const SERVER_COMMAND = "typescript-language-server";
/** These specs need the real server on PATH; on a machine without one they skip. */
const serverAvailable = onSystemPath(SERVER_COMMAND);
const TIMEOUT_MS = 60_000;

const RENAME_REQUEST = "rename the exported greet symbol across the repository";
const RENAME_PACKET = taskPacket(RENAME_REQUEST);
const BUGFIX_REQUEST = "fix the wrong port constant in src/symbols.ts";
const BUGFIX_PACKET = taskPacket(BUGFIX_REQUEST);

/** The declaration of `greet` in the fixture: line 3, column 17. */
const GREET = { file: "src/symbols.ts", line: 3, column: 17 };
/** The declaration of `PORT`: line 1, column 14. */
const PORT = { file: "src/symbols.ts", line: 1, column: 14 };

function fileName(path: string): string {
	return path.split("/").pop() ?? path;
}

/** The text block a tool result carried. */
function textOf(result: AgentToolResult<unknown>): string {
	for (const block of result.content) if (block.type === "text") return block.text;
	return "";
}

function resultOf<T>(outcome: LspToolOutcome): T {
	if (!outcome.ok) throw new Error(`expected a result, got: ${outcome.unavailable}`);
	return outcome.result as T;
}

describe.skipIf(!serverAvailable)("PRD-018 Phase 3 — navigation and diagnostics under mode gating", () => {
	let fixture: Fixture;
	let options: { root: string; timeoutMs: number };
	let active: LspHarness | undefined;

	beforeAll(() => {
		// No local stub: these tests need the *real* server, resolved from PATH.
		fixture = tsRepo({ typecheck: "tsc --noEmit" }, undefined, { server: false });
		options = { root: fixture.cwd, timeoutMs: 30_000 };
	});

	afterEach(async () => {
		await active?.close();
		active = undefined;
	});

	afterAll(async () => {
		await closeLspClients();
	});

	const invoke = (mode: "LSP_NAVIGATION" | "LSP_DIAGNOSTICS" | "LSP_FULL", tool: Parameters<typeof invokeLspTool>[2], args: Record<string, unknown>) =>
		invokeLspTool(options, mode, tool, args);

	it(
		"AC-6: references return every referencing file, omit the non-referencing one, and hover returns the declared type",
		async () => {
			const spawnedBefore = lspProcessStats.spawned;
			const references = await invoke("LSP_NAVIGATION", "lsp_references", GREET);
			const locations = resultOf<Array<{ path: string }>>(references);
			const files = locations.map((location) => fileName(location.path));
			expect(files).toContain("symbols.ts");
			expect(files).toContain("caller.ts");
			expect(files).toContain("other-caller.ts");
			expect(files).not.toContain("unrelated.ts");
			// The server really started on first use — laziness, not a stub.
			expect(lspProcessStats.spawned).toBeGreaterThan(spawnedBefore);

			const hover = await invoke("LSP_NAVIGATION", "lsp_hover", PORT);
			const hovered = resultOf<{ contents: string }>(hover);
			expect(hovered.contents).toContain("PORT");
			expect(hovered.contents).toContain("number");
		},
		TIMEOUT_MS,
	);

	it(
		"AC-7: document symbols list the file's declarations, a workspace query resolves elsewhere, and call hierarchy finds the caller",
		async () => {
			const symbols = resultOf<Array<{ name: string }>>(await invoke("LSP_NAVIGATION", "lsp_document_symbols", { file: "src/symbols.ts" }));
			const names = symbols.map((symbol) => symbol.name);
			expect(names).toContain("PORT");
			expect(names).toContain("greet");

			const workspace = resultOf<Array<{ name: string; path?: string }>>(await invoke("LSP_NAVIGATION", "lsp_workspace_symbols", { query: "runTwice" }));
			const match = workspace.find((symbol) => symbol.name === "runTwice");
			expect(match).toBeDefined();
			expect(fileName(match!.path ?? "")).toBe("other-caller.ts");

			const callers = resultOf<Array<{ name: string; path: string }>>(await invoke("LSP_NAVIGATION", "lsp_call_hierarchy", GREET));
			const callerNames = callers.map((caller) => caller.name);
			expect(callerNames).toContain("run");
			expect(callerNames).toContain("runTwice");
		},
		TIMEOUT_MS,
	);

	it(
		"AC-8: a seeded type error surfaces with file, line and message, and is cleared after the fix",
		async () => {
			const broken = join(fixture.cwd, "src/broken.ts");
			writeFileSync(broken, 'export const broken: number = "not a number";\n');

			const first = resultOf<LspDiagnostic[]>(await invoke("LSP_DIAGNOSTICS", "lsp_diagnostics", { file: "src/broken.ts" }));
			expect(first.length).toBeGreaterThan(0);
			expect(first[0]!.file.endsWith("src/broken.ts")).toBe(true);
			expect(first[0]!.line).toBe(1);
			expect(first[0]!.message).toMatch(/not assignable/i);

			// LeanPi's own edit fixes the file; the next request must not replay the old error.
			writeFileSync(broken, "export const broken: number = 1;\n");
			const second = resultOf<LspDiagnostic[]>(await invoke("LSP_DIAGNOSTICS", "lsp_diagnostics", { file: "src/broken.ts" }));
			expect(second).toEqual([]);
		},
		TIMEOUT_MS,
	);

	it(
		"AC-10: a live navigation turn exposes exactly the six navigation tools, a diagnostics turn inverts the set",
		async () => {
			const navStub = await startStubBackend([{ text: "ok" }]);
			const diagStub = await startStubBackend([{ text: "ok" }]);
			let navSession: LspToolsSession | undefined;
			let diagSession: LspToolsSession | undefined;
			try {
				// The navigation turn: the mode comes from the compiler, not the test.
				navSession = await bootLspToolsSession({ cwd: fixture.cwd, baseUrl: navStub.baseUrl });
				active = await harness({ cwd: fixture.cwd, lsp: { mode: "auto" }, jev: "enabled" });
				const navigated = await active.compile(RENAME_REQUEST, RENAME_PACKET);
				const navigationMode = lspSelectionOf(navigated)!.mode;
				expect(navigationMode).toBe("LSP_NAVIGATION");

				const exposed = applyLspTools(navSession.session, navigationMode);
				expect(exposed).toEqual([...NAVIGATION_TOOL_NAMES]);
				const activeNames = navSession.session.getActiveToolNames();
				for (const name of NAVIGATION_TOOL_NAMES) expect(activeNames).toContain(name);
				expect(activeNames).not.toContain("lsp_diagnostics");
				// The baseline surface is untouched; only the LSP group changes.
				expect(activeNames).toContain("read");

				const references = await navSession.session.getToolDefinition("lsp_references")!.execute("call-1", { ...GREET }, undefined, undefined, undefined);
				expect(JSON.stringify(references.content)).toContain("caller.ts");

				const rejected = await navSession.session.getToolDefinition("lsp_diagnostics")!.execute(
					"call-2",
					{ file: "src/symbols.ts" },
					undefined,
					undefined,
					undefined,
				);
				expect(JSON.stringify(rejected.content)).toMatch(/unavailable/);
				await active.close();
				active = undefined;

				// The contrast turn needs a repository with no type-checking command,
				// and the real server rather than a fixture-local stub.
				const lintOnly = lintOnlyRepo({ server: false });
				diagSession = await bootLspToolsSession({ cwd: lintOnly.cwd, baseUrl: diagStub.baseUrl });
				active = await harness({ cwd: lintOnly.cwd, lsp: { mode: "auto" }, jev: "enabled" });
				const diagnosticsTurn = await active.compile(BUGFIX_REQUEST, BUGFIX_PACKET);
				const diagnosticsMode = lspSelectionOf(diagnosticsTurn)!.mode;
				expect(diagnosticsMode).toBe("LSP_DIAGNOSTICS");

				applyLspTools(diagSession.session, diagnosticsMode);
				const contrast = diagSession.session.getActiveToolNames();
				expect(contrast).toContain("lsp_diagnostics");
				for (const name of NAVIGATION_TOOL_NAMES) expect(contrast).not.toContain(name);

				const diagnostics = await diagSession.session.getToolDefinition("lsp_diagnostics")!.execute(
					"call-3",
					{ file: "src/symbols.ts" },
					undefined,
					undefined,
					undefined,
				);
				// A real diagnostic list from the server, not an unavailability note.
				expect(Array.isArray(JSON.parse(textOf(diagnostics)))).toBe(true);

				const inverted = await diagSession.session.getToolDefinition("lsp_references")!.execute(
					"call-4",
					{ ...GREET },
					undefined,
					undefined,
					undefined,
				);
				expect(textOf(inverted)).toMatch(/unavailable/);
			} finally {
				navSession?.dispose();
				diagSession?.dispose();
				await navStub.close();
				await diagStub.close();
			}
		},
		TIMEOUT_MS,
	);
});
