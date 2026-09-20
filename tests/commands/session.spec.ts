/**
 * E4 (PRD-016 Phase 4): the context surface over Pi.
 *
 * Covers AC-12 (per-layer context accounting, real compaction, a strictly lower
 * estimate afterwards) and F12.5 (LeanPi's bytes/4 figure is never presented as
 * Pi's measurement). `/new`, `/resume` and `/tree` are Pi's own commands, so
 * there is no LeanPi re-implementation left here to test.
 */
import { describe, expect, it } from "vitest";
import { nativeBackend } from "../helpers/fixtures.js";
import { surfaceFixture, type SurfaceFixture } from "./helpers.js";

const CONFIG = {
	backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
	models: { quick: { backend: "local", model: "stub-model" }, strong: { backend: "local", model: "stub-model" } },
};

/** One user turn through Pi's own store: the messages a live model would have written. */
function say(fixture: SurfaceFixture, text: string): void {
	fixture.append("user", text);
	fixture.appendAssistant(`ack: ${text}`);
}

/** `/context`'s layer rows plus the estimated total, so the sum can be checked as a number. */
function sectionsOf(text: string): { sections: Array<{ name: string; tokens: number }>; estimate: number } {
	const sections: Array<{ name: string; tokens: number }> = [];
	for (const line of text.split("\n")) {
		const match = /^ {2}(.+?)\s+(\d+) tokens$/.exec(line);
		if (match && match[1]!.trim() !== "estimated total") sections.push({ name: match[1]!.trim(), tokens: Number(match[2]) });
	}
	const estimate = /estimated total\s+(\d+) tokens/.exec(text);
	return { sections, estimate: Number(estimate?.[1]) };
}

describe("/context and /compact-refs (PRD-016 Phase 4)", () => {
	it("accounts for the context per layer, then compacts it to a strictly lower estimate (AC-12)", async () => {
		const fixture = surfaceFixture({ config: CONFIG, name: "alpha" });
		say(fixture, "keep the working state visible");
		// Two identical long tool outputs: the reducible class PRD-014 settles by rule.
		const toolOutput = `read src/app.ts\n${"export const value = 1;\n".repeat(240)}`;
		fixture.append("toolResult", toolOutput, { toolCallId: "call-1" });
		fixture.append("toolResult", toolOutput, { toolCallId: "call-2" });
		// The tail Pi keeps verbatim, so the summary replaces exactly the prefix.
		say(fixture, "the repeated read is the thing to reduce");

		const before = await fixture.dispatch("/context");
		expect(before.ok).toBe(true);
		const parsed = sectionsOf(before.text);
		expect(parsed.sections.map((section) => section.name)).toEqual(["static prefix", "artifact references", "live tool output", "message history"]);
		expect(parsed.sections.reduce((sum, section) => sum + section.tokens, 0)).toBe(parsed.estimate);
		expect(parsed.estimate).toBeGreaterThan(0);
		// Dispatched without Pi's session facts, so there is no measured figure to print.
		expect(before.text).toContain("pi context usage: unavailable");

		const compacted = await fixture.dispatch("/compact-refs");
		expect(compacted.ok).toBe(true);
		const beforeTotal = Number(/before: ~(\d+) tokens/.exec(compacted.text)![1]);
		const afterTotal = Number(/after:\s+~(\d+) tokens/.exec(compacted.text)![1]);
		expect(afterTotal).toBeLessThan(beforeTotal);
		expect(compacted.text).toMatch(/reduced: [1-9]\d* to artifact refs/);

		const after = await fixture.dispatch("/context");
		const reparsed = sectionsOf(after.text);
		expect(reparsed.sections.reduce((sum, section) => sum + section.tokens, 0)).toBe(reparsed.estimate);
		expect(reparsed.estimate).toBeLessThan(parsed.estimate);
		expect(after.text).toContain("artifact references");

		// Nothing new since the compaction: a second one refuses rather than re-summarizing.
		const again = await fixture.dispatch("/compact-refs");
		expect(again.ok).toBe(false);
		expect(again.text).toContain("nothing to compact");
	});

	it("prints Pi's measured usage when the invocation carried one, and never a fabricated total", async () => {
		const fixture = surfaceFixture({ config: CONFIG, name: "alpha" });
		say(fixture, "one turn of history");

		const measured = await fixture.registry.dispatch("/context", {
			cwd: fixture.cwd,
			session: { id: "pi-1", contextTokens: 4242, contextWindow: 200000 },
		});
		expect(measured.text).toContain("pi context usage: 4242 of 200000 tokens");
		// LeanPi's own arithmetic stays labelled as the estimate it is.
		expect(measured.text).toContain("leanpi estimate (bytes/4), by layer:");
		expect(measured.text).not.toMatch(/^total:/m);

		// Pi attached, but it has no figure yet: the window is known, the usage is not.
		const unknown = await fixture.registry.dispatch("/context", {
			cwd: fixture.cwd,
			session: { id: "pi-1", contextTokens: null, contextWindow: 200000 },
		});
		expect(unknown.text).toContain("pi context usage: not yet reported (window 200000 tokens)");
	});

	it("refuses to report a no-op compaction as success", async () => {
		const fixture = surfaceFixture({ config: CONFIG, name: "alpha" });
		say(fixture, "one unique message, nothing to reduce");

		const compacted = await fixture.dispatch("/compact-refs");
		expect(compacted.ok).toBe(false);
		expect(compacted.text).toContain("nothing to compact");
	});
});
