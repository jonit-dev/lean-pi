/**
 * PRD-048 Phase 1 — a `/model` pick reaches the turn.
 *
 * AC-1: a CLI pin on a native config hands the turn to the executor lane and the
 * pinned backend/model is what dispatches; Pi's own loop is never the path.
 * AC-6: the same config with no pin leaves the executor lane out, so a native
 * turn behaves exactly as before.
 */
import { afterEach, describe, expect, it } from "vitest";
import { clearLanes, ownsTurn, registerTurnLanesIfOwned, runTurn, setCompilerContext } from "../../src/index.js";
import { clearRoutePins, setRoutePins } from "../../src/compiler/pins.js";
import type { LeanPiConfig } from "../../src/core/types.js";
import { nativeBackend } from "../helpers/fixtures.js";
import { execConfig, fakeExec, harness, VERIFY_COMMANDS } from "../executor/helpers.js";

/** Native executor roles plus one vendor CLI the pin can hand the turn to. */
function pinnedConfig(cwd: string): LeanPiConfig {
	return execConfig(cwd, {
		backends: {
			local: nativeBackend("http://127.0.0.1:1/v1"),
			claude: { type: "external_harness", vendor: "claude", command: "/bin/true" },
		},
		models: {
			quick: { backend: "local", model: "cheap" },
			balanced: { backend: "local", model: "mid" },
			strong: { backend: "local", model: "big" },
		},
	});
}

const review = async () => ({ status: "ok", changedFiles: [], summary: JSON.stringify({ decision: "PASS", findings: [] }) });

afterEach(() => {
	clearRoutePins();
	clearLanes();
});

describe("a manual model pin owns the turn (PRD-048)", () => {
	it("AC-1: pins an external model, the executor lane dispatches it, and Pi's loop does not run", async () => {
		const h = await harness({ config: pinnedConfig });
		setCompilerContext({ config: h.config, cwd: h.cwd });
		setRoutePins({ model: { backend: "claude", model: "sonnet", type: "external_harness" } }, "manual-spec");

		// A CLI pin makes LeanPi own the turn even though the roles are native.
		expect(ownsTurn(h.config)).toBe(true);

		const packets: Array<{ model?: string; backend?: string }> = [];
		expect(
			registerTurnLanesIfOwned({
				cwd: h.cwd,
				config: h.config,
				exec: fakeExec({ pass: true }),
				verifyCommands: VERIFY_COMMANDS,
				reviewRunner: review,
				worker: async (packet) => {
					packets.push({ model: packet.model, backend: (packet as { backend?: string }).backend });
					return { status: "completed", backend: "claude", result: { status: "ok", changedFiles: [], summary: "done" }, attempts: [] };
				},
			}),
		).toBe(true);

		const context = await runTurn({ text: "rename the helper" }, { config: h.config, cwd: h.cwd });

		// The pinned model reached the worker, and the pinned backend is the one
		// that ran — the router's own pick was excluded.
		expect(packets).toHaveLength(1);
		expect(packets[0]?.model).toBe("sonnet");
		expect(context.executor?.invocations[0]?.backend).toBe("claude");
	});

	it("AC-6: a native config with no pin leaves the executor lane out of the turn", async () => {
		const h = await harness({ config: pinnedConfig });
		setCompilerContext({ config: h.config, cwd: h.cwd });
		expect(ownsTurn(h.config)).toBe(false);

		let called = false;
		expect(
			registerTurnLanesIfOwned({
				cwd: h.cwd,
				config: h.config,
				exec: fakeExec({ pass: true }),
				verifyCommands: VERIFY_COMMANDS,
				reviewRunner: review,
				worker: async () => {
					called = true;
					return { status: "completed", backend: "claude", result: { status: "ok", changedFiles: [], summary: "done" }, attempts: [] };
				},
			}),
		).toBe(false);

		const context = await runTurn({ text: "rename the helper" }, { config: h.config, cwd: h.cwd });

		expect(called).toBe(false);
		expect(context.executor).toBeUndefined();
	});
});
