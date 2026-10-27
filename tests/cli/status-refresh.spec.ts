/**
 * The footer's cost and ctx chips describe the turn that just ran.
 *
 * Both used to be read once in `before_agent_start`, before the turn spent a
 * token: the line showed the previous turn's bill and context for the whole
 * turn after it, so the first task always read `$0.00` and the numbers lagged
 * one task behind. Drives the real session, so only a redraw after settlement
 * can pass.
 */
import { describe, expect, it } from "vitest";
import { clearLanes, registerLane } from "../../src/commands/session.js";
import { LEANPI_STATUS_KEY } from "../../src/cli/statusline.js";
import { fixtureContract } from "../routing/fixture.js";
import { bootSession, headlessUIContext, nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend } from "../helpers/stub-backend.js";

describe("status line after a turn", () => {
	it("shows the cost of the task that just ran", async () => {
		const backend = await startStubBackend([{ text: "done", usage: { prompt_tokens: 100_000, completion_tokens: 50_000 } }]);
		const cwd = tempDir("leanpi-status-");
		writeConfig(cwd, {
			backends: { first: nativeBackend(backend.baseUrl) },
			models: { quick: { backend: "first", model: "leanpi-first" }, balanced: { backend: "first", model: "leanpi-first" }, strong: { backend: "first", model: "leanpi-first" } },
			// $10/$20 per Mtok: 100k in + 50k out is $2.00.
			cost: { models: { "leanpi-first": { input: 10, output: 20 } } },
			lsp: { mode: "off" }, jev: { mode: "disabled" },
		});
		const app = await bootSession({ cwd });
		const statuses: (string | undefined)[] = [];
		await app.session.bindExtensions({
			uiContext: { ...headlessUIContext(), setStatus: (key: string, text: string | undefined) => { if (key === LEANPI_STATUS_KEY) statuses.push(text); } },
		});
		registerLane({ name: "test.status-contract", run(_turn, context) {
			context.contract = fixtureContract({ complexity: "MEDIUM", executor_class: "balanced" });
		} });
		try {
			await app.session.prompt("first task");
			expect(statuses.at(-1)).toContain("$2.00");
		} finally {
			app.session.dispose();
			clearLanes();
			await backend.close();
		}
	});
});
