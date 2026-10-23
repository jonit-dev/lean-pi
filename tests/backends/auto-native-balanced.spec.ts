/**
 * Regression (v0.1.10): a normal Auto turn ran as a headless vendor-CLI run.
 *
 * The operator's global config binds `balanced` to `claude/opus[1m]` (a vendor
 * CLI) beside a native `opencode-go/deepseek-v4.1-flash`. Through v0.1.9 the
 * capability ranking resolved `balanced` to the cheapest model clearing its
 * floor — the native deepseek, which streams in Pi's loop. v0.1.10 made the
 * binding win, so every MEDIUM turn ran `claude -p` and showed nothing until
 * the whole task was done. The ranking decides again.
 *
 * Real Pi session and model registry, the real bundled ranking, the real
 * classifier (JEV off, so the heuristic decides), a real HTTP stub for the
 * native model and the stub vendor CLI for Claude — the operator's config shape.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearLanes, type LeanPiSession } from "../../src/index.js";
import { clearRoutePins, routePins } from "../../src/compiler/pins.js";
import { loadConfig } from "../../src/core/config.js";
import { bindHeadlessUI, bootHarnessSession, fixtureRepo, nativeBackend, tempDir } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { installStubCli, setStubScript } from "./helpers.js";

let restore: (() => void) | undefined;
let native: StubBackend | undefined;
let session: LeanPiSession | undefined;

afterEach(async () => {
	session?.session.dispose();
	restore?.();
	await native?.close();
	clearRoutePins();
	clearLanes();
});

describe("Auto on the operator's config shape", () => {
	it("a normal turn runs the native deepseek in Pi's loop, not the Claude CLI bound to balanced", async () => {
		native = await startStubBackend([{ text: "answered by deepseek" }, { text: "answered by deepseek again" }]);
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
					"opencode-go": nativeBackend(native.baseUrl),
					claude: { type: "external_harness", vendor: "claude", command: cli.bin.claude },
				},
				models: {
					quick: { backend: "opencode-go", model: "deepseek-v4.1-flash" },
					balanced: { backend: "claude", model: "opus[1m]" },
					strong: { backend: "claude", model: "opus" },
					review_quick: { backend: "opencode-go", model: "deepseek-v4.1-flash" },
				},
				jev: { apiKey: null, endpoint: "http://127.0.0.1:1/v1/systemone", model: "jev", mode: "disabled", usd_per_mtok: 0 },
			},
			env,
		);
		// The launcher passes no `--model` when `balanced` is a vendor CLI, so Pi boots on its native default.
		session = await bootHarnessSession({ cwd, agentDir, config, env, model: { provider: "opencode-go", model: "deepseek-v4.1-flash" } });

		// No marker for the heuristic: MEDIUM, so `balanced`.
		await session.session.prompt("suggest me a task based on past commits");

		expect(session.session.model).toMatchObject({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
		expect(native.requests.map((request) => request.model)).toEqual(["deepseek-v4.1-flash"]);
		expect(cli.records()).toHaveLength(0);

		// Mid-session switch to Manual on the native model. A HIGH task — which Auto
		// routes to `strong: claude/opus` — must stay on the pin, in Pi's own loop.
		await bindHeadlessUI(session);
		await session.session.prompt("/model opencode-go:deepseek-v4.1-flash");
		expect(routePins().model).toMatchObject({ backend: "opencode-go", model: "deepseek-v4.1-flash" });
		await session.session.prompt("fix the race condition in the scheduler");

		expect(session.session.model).toMatchObject({ provider: "opencode-go", id: "deepseek-v4.1-flash" });
		expect(native.requests.map((request) => request.model)).toEqual(["deepseek-v4.1-flash", "deepseek-v4.1-flash"]);
		expect(cli.records()).toHaveLength(0);
	}, 60_000);
});
