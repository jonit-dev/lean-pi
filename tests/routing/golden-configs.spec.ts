/**
 * PRD-054 G1: Auto on real config shapes, loaded the way a user's machine loads them.
 *
 * Each golden config is written as the user's *global* file (the path that
 * shipped v0.1.10's regression) and booted into a real Pi session with the real
 * bundled ranking. A LOW, a MEDIUM and a HIGH message (JEV off, so the keyword
 * heuristic decides deterministically) each assert which provider and model
 * Pi's loop runs. A routing change that moves a normal turn off the native
 * model — onto a headless vendor CLI that shows nothing until done — fails here.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearLanes, type LeanPiSession } from "../../src/index.js";
import { clearRoutePins } from "../../src/compiler/pins.js";
import { bootHarnessSession, fixtureRepo, tempDir } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { installStubCli, setStubScript, type StubCli } from "../backends/helpers.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "configs");

const NATIVE = { provider: "opencode-go", id: "deepseek-v4.1-flash" };

/** One message per band; the heuristic's markers decide it. */
const MESSAGES = {
	LOW: "rename the label",
	MEDIUM: "suggest me a task based on past commits",
	HIGH: "fix the race condition in the scheduler",
} as const;

/** What each golden config must run, per band. HIGH on a vendor CLI is intended (PRD-053 AC-3). */
const EXPECTED: Record<string, Record<keyof typeof MESSAGES, { provider: string; id: string }>> = {
	"onboarding.yaml": { LOW: NATIVE, MEDIUM: NATIVE, HIGH: { provider: "claude-cli", id: "opus[1m]" } },
	"operator.yaml": { LOW: NATIVE, MEDIUM: NATIVE, HIGH: { provider: "claude-cli", id: "opus" } },
};

let restore: (() => void) | undefined;
let native: StubBackend | undefined;
let session: LeanPiSession | undefined;

afterEach(async () => {
	session?.session.dispose();
	session = undefined;
	restore?.();
	await native?.close();
	clearRoutePins();
	clearLanes();
});

/** Writes the fixture as the user's global config, with the stubs substituted in. */
function installGlobalConfig(file: string, cli: StubCli, baseUrl: string): NodeJS.ProcessEnv {
	const home = tempDir("leanpi-golden-home-");
	const dir = join(home, ".config", "leanpi");
	mkdirSync(dir, { recursive: true });
	const yaml = readFileSync(join(FIXTURES, file), "utf8")
		.replaceAll("STUB_URL", baseUrl)
		.replaceAll("STUB_CLAUDE", cli.bin.claude)
		.replaceAll("STUB_CODEX", cli.bin.codex)
		.replaceAll("STUB_OPENCODE", cli.bin.opencode)
		// No network in tests: the keyword heuristic classifies instead of JEV.
		.replaceAll("STUB_JEV_MODE", "disabled");
	writeFileSync(join(dir, "leanpi.config.yaml"), yaml);
	return { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
}

describe("PRD-054 G1 — Auto on golden config shapes", () => {
	for (const file of Object.keys(EXPECTED)) {
		for (const band of Object.keys(MESSAGES) as (keyof typeof MESSAGES)[]) {
			it(`${file}: a ${band} message runs ${EXPECTED[file]![band].provider}/${EXPECTED[file]![band].id}`, async () => {
				native = await startStubBackend([{ text: "ok" }]);
				const cli = installStubCli();
				restore = setStubScript(cli.recordPath, { summary: "ok" });
				const env = installGlobalConfig(file, cli, native.baseUrl);
				const { cwd, agentDir } = fixtureRepo();
				// No `config`: the session loads the global file from disk, as the binary does.
				session = await bootHarnessSession({ cwd, agentDir, env });

				await session.session.prompt(MESSAGES[band]);

				const expected = EXPECTED[file]![band];
				expect(session.session.model).toMatchObject(expected);
				if (expected.provider === NATIVE.provider) {
					expect(native.requests.map((request) => request.model)).toEqual([NATIVE.id]);
					expect(cli.records()).toHaveLength(0);
				} else {
					expect(native.requests).toHaveLength(0);
					expect(cli.records().map((record) => record.vendor)).toEqual(["claude"]);
				}
			}, 60_000);
		}
	}
});
