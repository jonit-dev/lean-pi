/**
 * A turn routed to a subscription (external-harness) role runs on it.
 *
 * Pi registers a CLI backend's models under `<backend>-cli`, so looking the
 * routed model up under the bare backend name found nothing, `setModel` was
 * skipped, and every `strong` turn silently ran on the session's native model.
 *
 * Real Pi session, real model registry, a real HTTP stub for the native model
 * and the real stub vendor CLI. Red before the fix: the native stub answers
 * and the CLI never runs.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearLanes } from "../../src/index.js";
import { clearRoutePins, setRoutePins } from "../../src/compiler/pins.js";
import { loadConfig } from "../../src/core/config.js";
import { bootHarnessSession, fixtureRepo, nativeBackend, tempDir } from "../helpers/fixtures.js";
import { startStubBackend } from "../helpers/stub-backend.js";
import { installStubCli, setStubScript } from "./helpers.js";

afterEach(() => {
	clearRoutePins();
	clearLanes();
});

describe("a routed external-harness role", () => {
	it("installs the CLI model, so a strong turn runs on the subscription and not the native model", async () => {
		const flash = await startStubBackend([{ text: "answered by flash" }]);
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { summary: "answered by opus" });
		const { cwd, agentDir } = fixtureRepo();
		// A clean HOME: the machine's own vendor logins and global config stay out.
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
		const session = await bootHarnessSession({ cwd, agentDir, config, env });
		try {
			// What `/route executor strong` sets: the class the classifier picks for a HIGH task.
			setRoutePins({ executor_class: "strong" });
			// The interactive path: the prompt reaches Pi, and `before_agent_start` installs the route.
			await session.session.prompt("redesign the scheduler");

			expect(session.session.model).toMatchObject({ provider: "claude-cli", id: "leanpi-test-opus" });
			expect(flash.requests).toHaveLength(0);
			const calls = cli.records();
			expect(calls.map((record) => record.vendor)).toEqual(["claude"]);
			expect(calls[0]?.argv.join(" ")).toContain("--model leanpi-test-opus");
		} finally {
			session.session.dispose();
			restore();
			await flash.close();
		}
	}, 30_000);
});
