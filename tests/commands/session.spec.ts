/**
 * E4 (PRD-016 Phase 4): the session tree and the context surface over Pi.
 *
 * Covers AC-10 (a new session and a resume that restores an earlier history),
 * AC-11 (a fork whose child inherits the prefix while the parent stays
 * untouched) and AC-12 (per-section context accounting, real compaction, a
 * strictly lower total afterwards). The parent-lacks-child assertion is the
 * self-comparison guard: a fork implemented as an alias of the same session
 * would fail it.
 */
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterAll, describe, expect, it } from "vitest";
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

/** `/context`'s section rows plus its total, so the sum can be checked as a number. */
function sectionsOf(text: string): { sections: Array<{ name: string; tokens: number }>; total: number } {
	const sections: Array<{ name: string; tokens: number }> = [];
	for (const line of text.split("\n")) {
		if (line.startsWith("total:") || line.startsWith("artifact-backed share:")) continue;
		const match = /^(.+?)\s+(\d+) tokens$/.exec(line);
		if (match) sections.push({ name: match[1]!.trim(), tokens: Number(match[2]) });
	}
	const total = /total: (\d+) tokens/.exec(text);
	return { sections, total: Number(total?.[1]) };
}

describe("/new, /resume, /tree, /context and /compact (PRD-016 Phase 4)", () => {
	afterAll(() => {
		// Nothing global to reset: every fixture owns its Pi session directory.
	});

	it("starts a new session and resumes an earlier one through Pi's store (AC-10)", async () => {
		const fixture = surfaceFixture({ config: CONFIG, name: "alpha" });
		say(fixture, "the cache key must survive a restart");
		const alphaId = fixture.manager.getSessionId();
		const alphaPath = fixture.manager.getSessionFile();

		const created = await fixture.dispatch("/new beta");
		expect(created.ok).toBe(true);
		expect(created.text).toContain("beta");
		expect(fixture.host.current().getSessionId()).not.toBe(alphaId);
		expect(fixture.host.current().buildSessionContext().messages).toHaveLength(0);
		say(fixture, "beta only work");

		const resumed = await fixture.dispatch("/resume alpha");
		expect(resumed.ok).toBe(true);
		expect(resumed.text).toContain(alphaId);
		expect(fixture.host.current().getSessionId()).toBe(alphaId);
		const history = fixture.host.current().buildSessionContext().messages;
		expect(JSON.stringify(history)).toContain("the cache key must survive a restart");
		expect(JSON.stringify(history)).not.toContain("beta only work");
		expect(fixture.host.current().getSessionFile()).toBe(alphaPath);

		const missing = await fixture.dispatch("/resume nope");
		expect(missing.ok).toBe(false);
		expect(missing.text).toContain('no session named or identified "nope"');
	});

	it("forks the current session from its head without sharing state with the parent (AC-11)", async () => {
		const fixture = surfaceFixture({ config: CONFIG, name: "alpha" });
		say(fixture, "shared prefix work");
		const parentId = fixture.manager.getSessionId();
		const parentPath = fixture.manager.getSessionFile()!;

		const forked = await fixture.dispatch("/tree fork side");
		expect(forked.ok).toBe(true);
		expect(forked.text).toContain("forked side from alpha");
		const childId = fixture.host.current().getSessionId();
		expect(childId).not.toBe(parentId);
		expect(JSON.stringify(fixture.host.current().buildSessionContext().messages)).toContain("shared prefix work");

		say(fixture, "side-only work");
		expect(JSON.stringify(fixture.host.current().buildSessionContext().messages)).toContain("side-only work");

		// The parent's own file never received the child's message.
		const parent = SessionManager.open(parentPath, fixture.manager.getSessionDir(), fixture.cwd);
		const parentText = JSON.stringify(parent.buildSessionContext().messages);
		expect(parentText).toContain("shared prefix work");
		expect(parentText).not.toContain("side-only work");

		const tree = await fixture.dispatch("/tree");
		expect(tree.ok).toBe(true);
		expect(tree.text).toContain("alpha");
		expect(tree.text).toContain("side");
		expect(tree.text).toMatch(/side[^\n]*child of alpha/);
		expect(tree.text).toMatch(/\(current\)/);

		const bad = await fixture.dispatch("/tree sideways");
		expect(bad.ok).toBe(false);
		expect(bad.text).toContain("unknown /tree subcommand");
	});

	it("accounts for the context per section, then compacts it to a strictly lower total (AC-12)", async () => {
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
		expect(parsed.sections.map((section) => section.name)).toEqual([
			"static prefix",
			"working state",
			"artifact references",
			"live tool output",
			"message history",
		]);
		expect(parsed.sections.reduce((sum, section) => sum + section.tokens, 0)).toBe(parsed.total);
		expect(parsed.total).toBeGreaterThan(0);

		const compacted = await fixture.dispatch("/compact");
		expect(compacted.ok).toBe(true);
		const beforeTotal = Number(/before: (\d+) tokens/.exec(compacted.text)![1]);
		const afterTotal = Number(/after:\s+(\d+) tokens/.exec(compacted.text)![1]);
		expect(afterTotal).toBeLessThan(beforeTotal);
		expect(compacted.text).toMatch(/reduced: [1-9]\d* to artifact refs/);

		const after = await fixture.dispatch("/context");
		const reparsed = sectionsOf(after.text);
		expect(reparsed.sections.reduce((sum, section) => sum + section.tokens, 0)).toBe(reparsed.total);
		expect(reparsed.total).toBeLessThan(parsed.total);
		expect(after.text).toContain("working state");
		expect(after.text).toContain("artifact references");

		// Nothing new since the compaction: a second one refuses rather than re-summarizing.
		const again = await fixture.dispatch("/compact");
		expect(again.ok).toBe(false);
		expect(again.text).toContain("nothing to compact");
	});

	it("refuses to report a no-op compaction as success", async () => {
		const fixture = surfaceFixture({ config: CONFIG, name: "alpha" });
		say(fixture, "one unique message, nothing to reduce");

		const compacted = await fixture.dispatch("/compact");
		expect(compacted.ok).toBe(false);
		expect(compacted.text).toContain("nothing to compact");
	});
});
