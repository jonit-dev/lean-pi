/**
 * PRD-041 — the shipped default and the public parent entry (AC-2, AC-6).
 *
 * Two real paths the concurrency suite does not cover:
 *  - the host `/run` command, whose workflow body spawns a child with no explicit
 *    `async` field; with upstream's async default that child is an external
 *    process that cannot see LeanPi's registered-only provider, so the shipped
 *    default config must force the foreground path;
 *  - the public `LeanPiSession.runTurn`, whose per-mode `setActiveToolsByName`
 *    must leave the package's delegation tools active.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as yaml } from "yaml";
import { createLeanPiSession, type LeanPiSession } from "../../src/index.js";
import { fixtureRepo, bindHeadlessUI, isolateAgentDir, nativeBackend } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend, type StubStep } from "../helpers/stub-backend.js";

const CHILD_TOOLS = new Set(["bash", "grep", "find", "ls", "glob", "contact_supervisor"]);
const SLASH_RESULT_TYPE = "subagent-slash-result";

function toolNames(body: Record<string, unknown>): string[] {
	const tools = body.tools as Array<{ function?: { name?: string } }> | undefined;
	return (tools ?? []).map((tool) => tool.function?.name ?? "");
}

const isChildRequest = (body: Record<string, unknown>): boolean => toolNames(body).some((name) => CHILD_TOOLS.has(name));

function workflowScript(fanOut: number): string {
	const runs = Array.from({ length: fanOut }, (_, index) => `  { key: "c${index}", agent: "delegate", task: "child task ${index}", async: false }`).join(",\n");
	return `\nconst results = await runs.all([\n${runs}\n]);\nreturn results.map(r => r.output);\n`;
}

function config(cwd: string, baseUrl: string): void {
	writeFileSync(
		join(cwd, "leanpi.config.yaml"),
		yaml({
			backends: { local: nativeBackend(baseUrl) },
			models: {
				quick: { backend: "local", model: "cheap-fast" },
				balanced: { backend: "local", model: "cheap-fast" },
				strong: { backend: "local", model: "cheap-fast" },
			},
			jev: { mode: "disabled" },
			lsp: { mode: "off" },
		}),
	);
}

function slashCards(session: LeanPiSession): Array<{ text: string }> {
	const entries = session.session.sessionManager.getEntries?.() ?? [];
	return entries
		.filter((entry) => (entry as { customType?: string }).customType === SLASH_RESULT_TYPE)
		.map((entry) => ({ text: JSON.stringify(entry) }));
}

/** Await the terminal slash card, never the initial "Running subagent..." one. */
async function waitForSlashResult(session: LeanPiSession, needle: string | RegExp, timeoutMs = 60_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < deadline) {
		const cards = slashCards(session);
		last = cards.at(-1)?.text ?? "";
		if (last && !last.includes("Running subagent...") && (typeof needle === "string" ? last.includes(needle) : needle.test(last))) return last;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`no terminal slash result within ${timeoutMs}ms; last=${last.slice(0, 600)}`);
}

describe("the shipped default runs /run in the foreground (AC-6 default)", () => {
	let native: StubBackend | undefined;
	let session: LeanPiSession | undefined;
	let restoreAgentDir: (() => void) | undefined;

	afterEach(async () => {
		session?.session.dispose();
		await native?.close();
		restoreAgentDir?.();
		restoreAgentDir = undefined;
		delete process.env.LEANPI_SAFETY;
	});

	it("completes a real /run delegation and answers a native continuation turn", { timeout: 120_000 }, async () => {
		native = await startStubBackend([{ text: "x" }], {
			respond: (body): StubStep => (isChildRequest(body) ? { text: "run child answer" } : { text: "parent done" }),
		});
		const repo = fixtureRepo();
		process.env.LEANPI_SAFETY = "low";
		config(repo.cwd, native.baseUrl);
		restoreAgentDir = isolateAgentDir(repo.agentDir);
		session = await createLeanPiSession({ cwd: repo.cwd, agentDir: repo.agentDir });
		// The host-owned `/run` handler runs on the command path, not the model
		// loop: it needs Pi's UI surface bound (`ctx.hasUI`) before it dispatches.
		await bindHeadlessUI(session);

		await session.session.prompt("/run delegate answer this question");
		const card = await waitForSlashResult(session, "run child answer");
		expect(card).toContain("run child answer");

		// The session is still healthy: an ordinary parent turn completes through Pi's loop.
		await session.session.prompt("an ordinary follow-up");
		expect(native.requests.filter((request) => isChildRequest(request.body))).toHaveLength(1);
	});
});

describe("the public runTurn keeps the delegation tools active (AC-2)", () => {
	let native: StubBackend | undefined;
	let session: LeanPiSession | undefined;
	let restoreAgentDir: (() => void) | undefined;

	afterEach(async () => {
		session?.session.dispose();
		await native?.close();
		restoreAgentDir?.();
		restoreAgentDir = undefined;
		delete process.env.LEANPI_SAFETY;
	});

	it("runs a delegation through runTurn and leaves subagent/bg_wait active", { timeout: 120_000 }, async () => {
		let parentCalls = 0;
		let children = 0;
		native = await startStubBackend([{ text: "x" }], {
			respond: (body): StubStep => {
				if (isChildRequest(body)) {
					children += 1;
					return { text: `child answer ${children}` };
				}
				parentCalls += 1;
				if (parentCalls === 1) {
					return { toolCalls: [{ id: "call_sub", name: "subagent", args: { async: false, workflowScript: workflowScript(2) } }] };
				}
				return { text: "parent done" };
			},
		});
		const repo = fixtureRepo();
		process.env.LEANPI_SAFETY = "low";
		config(repo.cwd, native.baseUrl);
		restoreAgentDir = isolateAgentDir(repo.agentDir);
		session = await createLeanPiSession({ cwd: repo.cwd, agentDir: repo.agentDir });

		const before = session.session.getActiveToolNames();
		expect(before).toContain("subagent");
		expect(before).toContain("bg_wait");

		await session.runTurn("delegate the work");

		expect(children).toBe(2);
		const after = session.session.getActiveToolNames();
		expect(after).toContain("subagent");
		expect(after).toContain("bg_wait");
	});
});
