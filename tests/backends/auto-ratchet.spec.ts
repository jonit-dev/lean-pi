/**
 * PRD-053 AC-2/AC-3: Auto decides the model on the first message and only moves
 * it up from there; `/route executor` overrides it; `/new` starts over.
 *
 * Real Pi session and model registry, the real classifier (JEV disabled, so the
 * keyword heuristic decides the band deterministically), a real HTTP stub for
 * the native model and the stub vendor CLI for the subscription model.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearLanes, type LeanPiSession } from "../../src/index.js";
import { clearRoutePins } from "../../src/compiler/pins.js";
import { loadConfig } from "../../src/core/config.js";
import { bindHeadlessUI, bootHarnessSession, fixtureRepo, nativeBackend, tempDir } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { installStubCli, setStubScript, type StubCli } from "./helpers.js";

const HIGH = "fix the race condition in the scheduler";
const LOW = "rename the label";

const FLASH = { provider: "local", id: "leanpi-test-flash" };
const OPUS = { provider: "claude-cli", id: "leanpi-test-opus" };

let restore: (() => void) | undefined;
let flash: StubBackend | undefined;
let session: LeanPiSession | undefined;

afterEach(async () => {
	session?.session.dispose();
	restore?.();
	await flash?.close();
	clearRoutePins();
	clearLanes();
});

async function boot(): Promise<{ session: LeanPiSession; cli: StubCli }> {
	flash = await startStubBackend([{ text: "answered by flash" }]);
	const cli = installStubCli();
	restore = setStubScript(cli.recordPath, { summary: "answered by opus" });
	const { cwd, agentDir } = fixtureRepo();
	const home = tempDir("leanpi-home-");
	const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
	const config = loadConfig(
		cwd,
		{
			configPath: null,
			backends: {
				local: nativeBackend(flash.baseUrl),
				claude: { type: "external_harness", vendor: "claude", command: cli.bin.claude },
			},
			models: {
				quick: { backend: "local", model: "leanpi-test-flash" },
				balanced: { backend: "local", model: "leanpi-test-flash" },
				strong: { backend: "claude", model: "leanpi-test-opus" },
			},
			jev: { apiKey: null, endpoint: "http://127.0.0.1:1/v1/systemone", model: "jev", mode: "disabled", usd_per_mtok: 0 },
		},
		env,
	);
	session = await bootHarnessSession({ cwd, agentDir, config, env });
	await bindHeadlessUI(session);
	return { session, cli };
}

describe("PRD-053 — Auto decides on the first message, then only escalates", () => {
	it("AC-2: a HIGH first message installs strong, a LOW follow-up keeps it, and /new starts over", async () => {
		const { session } = await boot();

		await session.session.prompt(HIGH);
		expect(session.session.model).toMatchObject(OPUS);

		await session.session.prompt(LOW);
		expect(session.session.model).toMatchObject(OPUS);

		// What `/new` does to the extension: Pi starts the next session with reason "new".
		await session.session.extensionRunner.emit({ type: "session_start", reason: "new" });
		await session.session.prompt(LOW);
		expect(session.session.model).toMatchObject(FLASH);
	}, 60_000);

	it("AC-2 control: a LOW first message stays on the cheap model", async () => {
		const { session, cli } = await boot();
		await session.session.prompt(LOW);
		expect(session.session.model).toMatchObject(FLASH);
		expect(cli.records()).toHaveLength(0);
	}, 60_000);

	it("AC-3: `/route executor strong` typed as a command moves the next LOW message onto strong", async () => {
		const { session, cli } = await boot();
		await session.session.prompt("/route executor strong");
		await session.session.prompt(LOW);
		expect(session.session.model).toMatchObject(OPUS);
		expect(cli.records().map((record) => record.vendor)).toEqual(["claude"]);
	}, 60_000);
});
