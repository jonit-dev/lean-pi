/**
 * PRD-044 through the real extension boot: a native turn JEV classifies
 * PRD_REQUIRED asks "Yes / No / No, don't ask again" before Pi's loop runs.
 */
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { clearLanes } from "../../src/index.js";
import { prdSuggestEnabled, setPrdSuggest } from "../../src/cli/ui-settings.js";
import { readPrdState } from "../../src/prd/state.js";
import { answerScript } from "../compiler/helpers.js";
import { bootSession, fixtureRepo, headlessUIContext, nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubStep } from "../helpers/stub-backend.js";
import { startStubJev } from "../helpers/stub-jev.js";
import { artifactStoreFor, FIXTURE_PRD_BODY, stagedPrd } from "./helpers.js";

const OPTIONS = ["Yes, write a plan first", "No, just do it", "No, and don't ask again"];
const PRD_WORTHY = { architecture: "yes" };
const DIRECT = { localized: "yes" };

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	clearLanes();
});

/** A native session whose JEV answers the gate with `choices`, and whose `ui.select` answers `pick`. */
async function suggestFixture(options: { choices: Record<string, string>; pick?: string; ui?: boolean; steps?: StubStep[]; env?: { XDG_CONFIG_HOME: string } }) {
	const backend = await startStubBackend(options.steps ?? [{ text: "ok" }]);
	const jev = await startStubJev([answerScript({ choices: options.choices })]);
	closers.push(() => backend.close(), () => jev.close());
	const { cwd, agentDir } = fixtureRepo();
	writeConfig(cwd, {
		backends: { local: nativeBackend(backend.baseUrl) },
		// `/prd create` authors on the strong role.
		models: { balanced: { backend: "local", model: "cheap-fast" }, strong: { backend: "local", model: "cheap-fast" } },
		jev: { endpoint: jev.url, apiKey: "test-key" },
	});
	const env = options.env ?? { XDG_CONFIG_HOME: tempDir("leanpi-xdg-") };
	const asked: Array<{ title: string; options: string[] }> = [];
	const notes: string[] = [];
	const boot = async () => {
		const session = await bootSession({ cwd, agentDir, env });
		closers.push(() => session.session.dispose());
		if (options.ui !== false) {
			await session.session.bindExtensions({
				uiContext: {
					...headlessUIContext(),
					select: async (title: string, choices: string[]) => {
						asked.push({ title, options: choices });
						return options.pick;
					},
					notify: (message: string) => notes.push(message),
				},
			});
		}
		return session;
	};
	return { backend, cwd, env, asked, notes, boot };
}

/** The turn's own request: the one carrying the session's system prompt, not the authoring or recap call. */
function turnRequest(backend: { requests: Array<{ body: unknown }> }): string {
	return JSON.stringify(backend.requests.find((request) => JSON.stringify(request.body).includes("ponytail@"))?.body ?? null);
}

describe("PRD suggestion prompt (PRD-044)", () => {
	it("never asks after the session's first prompt, e.g. mid-session or resumed (AC-3)", async () => {
		const f = await suggestFixture({ choices: PRD_WORTHY, pick: OPTIONS[1] });
		setPrdSuggest(false, f.env);
		const session = await f.boot();
		await session.session.prompt("fix the typo in the header");
		setPrdSuggest(true, f.env);
		await session.session.prompt("rework the storage layer");
		expect(f.asked).toEqual([]);
	});

	it("asks once on a PRD-worthy turn, and not again this session after No (AC-1, AC-3)", async () => {
		const f = await suggestFixture({ choices: PRD_WORTHY, pick: OPTIONS[1] });
		const session = await f.boot();
		await session.session.prompt("rework the storage layer");
		expect(f.asked).toEqual([{ title: expect.stringContaining("plan"), options: OPTIONS }]);
		expect(f.backend.requests.length).toBeGreaterThan(0);
		await session.session.prompt("rework the cache layer too");
		expect(f.asked).toHaveLength(1);
		expect(readPrdState(f.cwd)).toBeNull();
	});

	it("never asks on a direct turn, without a UI, with an active PRD, or when switched off (AC-1)", async () => {
		const direct = await suggestFixture({ choices: DIRECT, pick: OPTIONS[1] });
		await (await direct.boot()).session.prompt("fix the typo in the header");
		expect(direct.asked).toEqual([]);

		const off = await suggestFixture({ choices: PRD_WORTHY, pick: OPTIONS[1] });
		setPrdSuggest(false, off.env);
		await (await off.boot()).session.prompt("rework the storage layer");
		expect(off.asked).toEqual([]);

		const active = await suggestFixture({ choices: PRD_WORTHY, pick: OPTIONS[1] });
		stagedPrd(active.cwd, { artifactStore: artifactStoreFor(tempDir("leanpi-agent-")) });
		await (await active.boot()).session.prompt("rework the storage layer");
		expect(active.asked).toEqual([]);

		const headless = await suggestFixture({ choices: PRD_WORTHY, pick: OPTIONS[1], ui: false });
		await (await headless.boot()).session.prompt("rework the storage layer");
		expect(headless.asked).toEqual([]);
	});

	it("does not ask when the gate fell back to its heuristic (AC-1)", async () => {
		const f = await suggestFixture({ choices: PRD_WORTHY, pick: OPTIONS[1] });
		writeConfig(f.cwd, {
			backends: { local: nativeBackend(f.backend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			jev: { endpoint: "http://127.0.0.1:9/v1", apiKey: "test-key" },
		});
		await (await f.boot()).session.prompt("rework the storage layer across stages");
		expect(f.asked).toEqual([]);
	});

	it("\"No, don't ask again\" persists, and /prd suggest on brings it back (AC-4, AC-5)", async () => {
		const f = await suggestFixture({ choices: PRD_WORTHY, pick: OPTIONS[2] });
		const first = await f.boot();
		await first.session.prompt("rework the storage layer");
		expect(f.asked).toHaveLength(1);
		expect(prdSuggestEnabled(f.env)).toBe(false);

		const second = await f.boot();
		await second.session.prompt("rework the storage layer");
		expect(f.asked).toHaveLength(1);

		expect((await second.commands.dispatch("prd suggest on", { cwd: f.cwd })).ok).toBe(true);
		const third = await f.boot();
		await third.session.prompt("rework the storage layer");
		expect(f.asked).toHaveLength(2);
	});

	it("Yes authors the PRD and the turn proceeds from it (AC-2)", async () => {
		const f = await suggestFixture({ choices: PRD_WORTHY, pick: OPTIONS[0], steps: [{ text: FIXTURE_PRD_BODY }, { text: "ok" }] });
		const session = await f.boot();
		await session.session.prompt("rework the storage layer");
		const state = readPrdState(f.cwd);
		expect(state).not.toBeNull();
		expect(existsSync(state!.prdPath)).toBe(true);
		expect(turnRequest(f.backend)).toContain(state!.prdId);
	});

	it("Yes whose authoring fails warns and proceeds as a plain prompt (AC-2)", async () => {
		const f = await suggestFixture({ choices: PRD_WORTHY, pick: OPTIONS[0], steps: [{ text: "not a PRD" }, { text: "ok" }] });
		const session = await f.boot();
		await session.session.prompt("rework the storage layer");
		expect(readPrdState(f.cwd)).toBeNull();
		expect(f.notes.some((note) => note.includes("Continuing without a plan"))).toBe(true);
		expect(turnRequest(f.backend)).toContain("rework the storage layer");
		expect(turnRequest(f.backend)).not.toContain("was written for this task");
	});
});
