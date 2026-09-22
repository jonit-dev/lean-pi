/**
 * E3 (PRD-036 Phase 3): `/recap` reaches the generator, is listed by `/help`,
 * toggles generation for the session, and names the session exactly once.
 *
 * The command-level cases drive the real registry; the toggle and title cases
 * drive the real controller with a scripted runner, because those are decisions
 * the controller makes, not the command.
 */
import { describe, expect, it } from "vitest";
import { createRecap, type RecapController, type RecapRequest } from "../../src/recap/index.js";
import { surfaceFixture, type SurfaceFixture } from "./helpers.js";

const CONFIG = {
	backends: { local: { type: "native", baseUrl: "https://example.test" } },
	models: {
		quick: { backend: "local", model: "cheap" },
		balanced: { backend: "local", model: "cheap" },
		strong: { backend: "local", model: "cheap" },
	},
	lsp: { mode: "off" },
	jev: { mode: "disabled" },
};

interface RecapHarness {
	recap: RecapController;
	ctx: { hasUI: boolean; ui: { setWidget: (key: string, content: string[] | undefined) => void } };
	calls: RecapRequest[];
	widgets: Array<string[] | undefined>;
	sessionNames: string[];
}

function recapHarness(fixture: SurfaceFixture, script: string | undefined, existingName?: string): RecapHarness {
	const calls: RecapRequest[] = [];
	const widgets: Array<string[] | undefined> = [];
	const sessionNames: string[] = [];
	let name = existingName;
	const pi = {
		setSessionName: (value: string) => {
			sessionNames.push(value);
			name = value;
		},
		getSessionName: () => name,
		appendEntry: () => {},
	};
	const ctx = { hasUI: true, ui: { setWidget: (_key: string, content: string[] | undefined) => widgets.push(content) } };
	const recap = createRecap({
		config: fixture.config,
		cwd: fixture.cwd,
		sessionId: "recap-session",
		pi,
		run: async (request) => {
			calls.push(request);
			return script;
		},
	});
	return { recap, ctx, calls, widgets, sessionNames };
}

describe("/recap (PRD-036 Phase 3)", () => {
	it("regenerates from the last turn through the command (AC-6)", async () => {
		const fixture = surfaceFixture({ config: CONFIG });
		const harness = recapHarness(fixture, "RECAP: Regenerated on demand.");
		const fixtureWithRecap = surfaceFixture({ cwd: fixture.cwd, config: CONFIG, writeConfigFile: false, recap: () => harness.recap });

		// Seed the last turn so `/recap` has something to say again.
		await harness.recap.recapTurn(harness.ctx, { ask: "do the thing", did: "did the thing" });
		expect(harness.calls).toHaveLength(1);

		const result = await fixtureWithRecap.registry.dispatch("/recap", { cwd: fixture.cwd, recapHost: harness.ctx });
		expect(result.ok).toBe(true);
		expect(harness.calls).toHaveLength(2);
		expect(result.text).toContain("Regenerated on demand.");
		expect(harness.widgets.at(-1)?.[0]).toContain("Regenerated on demand.");
	});

	it("is listed by /help and registered with Pi (AC-6)", async () => {
		const fixture = surfaceFixture({ config: CONFIG, recap: () => undefined });
		const help = await fixture.dispatch("/help");
		expect(help.ok).toBe(true);
		expect(help.text).toContain("/recap");
	});

	it("'/recap off' suppresses automatic generation for the session (AC-6)", async () => {
		const fixture = surfaceFixture({ config: CONFIG });
		const harness = recapHarness(fixture, "RECAP: Should not run.");
		const fixtureWithRecap = surfaceFixture({ cwd: fixture.cwd, config: CONFIG, writeConfigFile: false, recap: () => harness.recap });

		const off = await fixtureWithRecap.registry.dispatch("/recap off", { cwd: fixture.cwd, recapHost: harness.ctx });
		expect(off.ok).toBe(true);
		expect(harness.recap.isEnabled()).toBe(false);

		await harness.recap.recapTurn(harness.ctx, { ask: "do the thing", did: "did the thing" });
		// The negative control: no model call, because the switch is off.
		expect(harness.calls).toHaveLength(0);

		await fixtureWithRecap.registry.dispatch("/recap on", { cwd: fixture.cwd, recapHost: harness.ctx });
		expect(harness.recap.isEnabled()).toBe(true);
	});

	it("prints one usage line for an unknown argument", async () => {
		const fixture = surfaceFixture({ config: CONFIG });
		const harness = recapHarness(fixture, "RECAP: never runs.");
		const withRecap = surfaceFixture({ cwd: fixture.cwd, config: CONFIG, writeConfigFile: false, recap: () => harness.recap });
		const result = await withRecap.registry.dispatch("/recap maybe", { cwd: fixture.cwd, recapHost: harness.ctx });
		expect(result.ok).toBe(false);
		expect(result.text).toContain("usage: /recap [on|off]");
	});

	it("names the session once across two consecutive recaps, and never when a name exists (AC-7)", async () => {
		const fixture = surfaceFixture({ config: CONFIG });

		const first = recapHarness(fixture, "RECAP: one.\nTITLE: First Title");
		await first.recap.recapTurn(first.ctx, { ask: "a", did: "b" });
		await first.recap.recapTurn(first.ctx, { ask: "a", did: "b" });
		expect(first.sessionNames).toEqual(["First Title"]);

		const named = recapHarness(fixture, "RECAP: two.\nTITLE: Should Not Apply", "Existing Name");
		await named.recap.recapTurn(named.ctx, { ask: "a", did: "b" });
		expect(named.sessionNames).toHaveLength(0);
	});
});
