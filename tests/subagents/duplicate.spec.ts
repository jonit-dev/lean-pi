/**
 * PRD-041 AC-1/AC-2 — one callable upstream package when the same `pi-subagents`
 * is both configured globally and selected by LeanPi.
 *
 * The real duplication seam is now Pi's native resource loading: a global
 * settings package resolves to `<pkg>/index.js`, and LeanPi passes the exact same
 * resolved path through `additionalExtensionPaths`. Pi's loader merges CLI paths
 * with settings paths by canonical path, so one copy loads. This spec configures
 * the installed package for real and boots `createLeanPiSession`; it does not
 * inject synthetic inline factories, because an arbitrary extra inline factory is
 * outside the resource loader and is not what LeanPi promises to dedupe.
 *
 * It attends to the failure modes a double registration causes: a suffixed
 * duplicate command (`run:1`), two `subagent` tools, or a second `loadConfig()`.
 * Registration alone cannot show a second copy's shared-bus listeners, so the
 * same fixture also runs the host `/run` for real: upstream's command emits one
 * `subagent:slash:request` on `pi.events`, and every loaded copy's bridge would
 * answer it with its own child provider request.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLeanPiSession, type LeanPiSession } from "../../src/index.js";
import { subagentConfigPath, SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT } from "../../src/subagents/index.js";
import { fixtureRepo, headlessUIContext, isolateAgentDir, nativeBackend, toolNamesOf, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend, type StubStep } from "../helpers/stub-backend.js";

const require = createRequire(import.meta.url);

const CHILD_TOOLS = new Set(["bash", "grep", "find", "ls", "glob", "contact_supervisor"]);
const SLASH_RESULT_TYPE = "subagent-slash-result";

const isChildRequest = (body: Record<string, unknown>): boolean => toolNamesOf(body).some((name) => CHILD_TOOLS.has(name));

function terminalSlashCards(session: LeanPiSession): string[] {
	return (session.session.sessionManager.getEntries?.() ?? [])
		.filter((entry) => (entry as { customType?: string }).customType === SLASH_RESULT_TYPE)
		.map((entry) => JSON.stringify(entry))
		.filter((text) => !text.includes("Running subagent..."));
}

/** Await the terminal slash card, never the initial "Running subagent..." one; bounded. */
async function waitForSlashResult(session: LeanPiSession, needle: string, timeoutMs = 60_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const card = terminalSlashCards(session).find((text) => text.includes(needle));
		if (card !== undefined) return card;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`no terminal slash result within ${timeoutMs}ms`);
}

describe("a configured pi-subagents and LeanPi's selection load one copy (AC-1, AC-2)", () => {
	let native: StubBackend;
	let cwd: string;
	let agentDir: string;
	let restoreAgentDir: () => void;
	let session: LeanPiSession | undefined;

	beforeAll(async () => {
		native = await startStubBackend([{ text: "x" }], {
			respond: (body): StubStep => (isChildRequest(body) ? { text: "run child answer" } : { text: "parent done" }),
		});
		const repo = fixtureRepo();
		cwd = repo.cwd;
		agentDir = repo.agentDir;
		restoreAgentDir = isolateAgentDir(agentDir);
		process.env.LEANPI_SAFETY = "low";
		// Configure the real installed package globally, exactly as `pi install`
		// would: a local package source in the agent dir's settings. Beside it, an
		// unrelated global extension whose command must stay callable.
		const installed = dirname(require.resolve("pi-subagents"));
		const ping = join(agentDir, "fixture-ping.ts");
		writeFileSync(ping, 'export default function (pi) {\n\tpi.registerCommand("fixture-ping", { description: "unrelated fixture command", handler: async (args, ctx) => ctx.ui.notify(`fixture-ping ${args}`, "info") });\n}\n');
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [installed], extensions: [ping] }, null, 2));
		writeConfig(cwd, {
			backends: { local: nativeBackend(native.baseUrl) },
			models: {
				quick: { backend: "local", model: "cheap-fast" },
				balanced: { backend: "local", model: "cheap-fast" },
				strong: { backend: "local", model: "cheap-fast" },
			},
			jev: { mode: "disabled" },
			lsp: { mode: "off" },
		});
		session = await createLeanPiSession({ cwd, agentDir });
	}, 60_000);

	afterAll(async () => {
		try {
			session?.session.dispose();
		} finally {
			restoreAgentDir();
			delete process.env.LEANPI_SAFETY;
			await native.close();
		}
	});

	it("loads upstream exactly once with one run command and one tool set", () => {
		const loaded = session!.session.resourceLoader.getExtensions();
		expect(loaded.errors.map((failure: { path: string; error: unknown }) => `${failure.path}: ${failure.error}`)).toEqual([]);
		const upstream = loaded.extensions.filter((extension: { path: string }) => extension.path.includes("pi-subagents"));
		expect(upstream.map((extension: { path: string }) => extension.path)).toHaveLength(1);

		const active = session!.session.getActiveToolNames();
		expect(active).toContain("subagent");
		expect(active).toContain("bg_wait");
		expect(active).not.toContain("subagent_supervisor");

		const runCommands = loaded.extensions
			.flatMap((extension: { commands: Map<string, unknown> }) => [...extension.commands.keys()])
			.filter((name) => name === "run" || name.startsWith("run:"));
		expect(runCommands, "the host /run command must resolve to exactly one name").toEqual(["run"]);

		expect(JSON.parse(readFileSync(subagentConfigPath(agentDir), "utf8")).globalConcurrencyLimit).toBe(SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT);
	});

	it("runs the host /run through one copy: one child request, one terminal card, then an ordinary parent turn", { timeout: 120_000 }, async () => {
		const live = session!;
		const notes: string[] = [];
		// Pi's headless UI, with `notify` captured so command output is observable.
		await live.session.bindExtensions({ uiContext: { ...headlessUIContext(), notify: (message: string) => void notes.push(message) } });

		await live.session.prompt("/subagents-limit");
		const limit = SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT;
		expect(notes.join("\n"), "the captured active value is the shipped default upstream read").toContain(`subagent concurrency: active ${limit}, saved ${limit}`);

		await live.session.prompt("/fixture-ping hello");
		expect(notes, "an unrelated global command stays registered and callable").toContain("fixture-ping hello");

		await live.session.prompt("/run delegate answer this question");
		expect(await waitForSlashResult(live, "run child answer")).toContain("run child answer");
		expect(native.requests.filter((request) => isChildRequest(request.body)), "a second copy's bridge would dispatch a second child").toHaveLength(1);
		expect(terminalSlashCards(live).filter((text) => text.includes("run child answer"))).toHaveLength(1);

		await live.session.prompt("an ordinary follow-up");
		expect(live.session.getLastAssistantText()).toBe("parent done");
		expect(isChildRequest(native.requests.at(-1)!.body), "the continuation is a parent request").toBe(false);
		expect(native.requests.filter((request) => isChildRequest(request.body)), "no second child dispatch after the continuation").toHaveLength(1);
	});
});
