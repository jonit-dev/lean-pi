/**
 * PRD-041 AC-1/AC-10, CLI half — the real launcher entry registers the package.
 *
 * The interactive CLI attaches `dist/leanpi.js` (compiled from `src/leanpi.ts`) as
 * LeanPi's own hooks and, separately, the exact resource path selected by the
 * global-only preflight via `--extension`. This spec drives both exactly as the
 * launcher does: it invokes `prepareCliSubagents` for the real entry path and
 * hands that path to the real SDK loader, rather than asserting that a shipped
 * export merely exists.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cliEntry from "../../src/leanpi.js";
import { launchPlan } from "../../src/cli/launch.js";
import { BASELINE_TOOL_NAMES } from "../../src/index.js";
import { prepareCliSubagents, SUBAGENT_PARENT_TOOL_NAMES, SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT, subagentConfigPath } from "../../src/subagents/index.js";
import { fixtureRepo, isolateAgentDir, nativeBackend, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";

describe("the real launcher entry registers pi-subagents (AC-1, AC-10)", () => {
	let native: StubBackend;
	let cwd: string;
	let agentDir: string;
	let restoreAgentDir: () => void;
	const previousCwd = process.env.LEANPI_CWD;

	beforeAll(async () => {
		native = await startStubBackend([{ text: "ok" }]);
		const repo = fixtureRepo();
		cwd = repo.cwd;
		agentDir = repo.agentDir;
		restoreAgentDir = isolateAgentDir(agentDir);
		// The loader-driven entry resolves its cwd from `LEANPI_CWD` (the
		// documented override); the launcher's child inherits the operator's
		// `process.cwd()` instead, which a fixture cannot reproduce.
		process.env.LEANPI_CWD = cwd;
		writeConfig(cwd, {
			backends: { local: nativeBackend(native.baseUrl) },
			models: {
				quick: { backend: "local", model: "cheap-fast" },
				balanced: { backend: "local", model: "cheap-fast" },
				strong: { backend: "local", model: "cheap-fast" },
			},
			jev: { mode: "disabled" },
		});
	});

	afterAll(async () => {
		restoreAgentDir();
		if (previousCwd === undefined) delete process.env.LEANPI_CWD;
		else process.env.LEANPI_CWD = previousCwd;
		await native.close();
	});

	it("registers subagent/bg_wait and writes the operator default through the real loader", async () => {
		// The launcher's global-only preflight yields the exact resource path it
		// appends as Pi's `--extension`.
		const selection = await prepareCliSubagents(cwd);
		expect(selection.origin).toBe("bundled");
		expect(existsSync(selection.entry), `selected entry ${selection.entry} must exist`).toBe(true);

		let captured: ExtensionAPI | undefined;
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: {
				skillsOverride: (base) => ({ skills: [], diagnostics: base.diagnostics }),
				additionalExtensionPaths: [selection.entry],
				extensionFactories: [
					(pi: ExtensionAPI) => {
						captured = pi;
						cliEntry(pi);
					},
				],
			},
		});
		// The extension runtime is only initialized once a session exists, and
		// `getAllTools()` is an action method: it is exactly the seam
		// `createLeanPiSession` reads after building the session.
		const model = services.modelRuntime.getModel("local", "cheap-fast");
		if (!model) throw new Error("the fixture's local/cheap-fast model did not register");
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			model,
			noTools: "builtin",
			tools: [...BASELINE_TOOL_NAMES, ...SUBAGENT_PARENT_TOOL_NAMES],
		});
		try {
			const names = (captured?.getAllTools() ?? []).map((tool) => tool.name);
			expect(names, "the launcher entry did not register subagent").toContain("subagent");
			expect(names, "the launcher entry did not register bg_wait").toContain("bg_wait");
			expect(existsSync(subagentConfigPath(agentDir)), "the launcher entry did not write the operator default").toBe(true);
			expect(JSON.parse(readFileSync(subagentConfigPath(agentDir), "utf8")).globalConcurrencyLimit).toBe(SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT);
		} finally {
			session.dispose();
		}
	});

	it("appends the selected raw path once, never a source spec", async () => {
		// A configured global copy: the preflight must yield that exact installed
		// path, and the argv must carry that path rather than `npm:pi-subagents`.
		const installed = dirname(createRequire(import.meta.url).resolve("pi-subagents"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [installed] }));
		try {
			const selection = await prepareCliSubagents(cwd);
			expect(selection.origin).toBe("configured");
			expect(selection.entry).toBe(join(installed, "index.js"));
			const plan = launchPlan([], undefined, undefined, "compact", true, selection.entry);
			const appended = plan.args.filter((argument) => argument === selection.entry);
			expect(appended).toEqual([selection.entry]);
			expect(plan.args.some((argument) => argument.startsWith("npm:"))).toBe(false);
		} finally {
			writeFileSync(join(agentDir, "settings.json"), "{}");
		}
	});
});
