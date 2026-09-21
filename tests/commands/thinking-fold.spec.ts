/**
 * `/thinking-fold` decides which reasoning display the next session attaches,
 * and stores it outside the repository so the launcher can read it first.
 */
import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../src/index.js";
import { registerThinkingFoldCommand } from "../../src/commands/thinking-fold.js";
import { bundledExtensions, launchPlan } from "../../src/cli/launch.js";
import { thinkingFoldEnabled } from "../../src/cli/ui-settings.js";
import { tempDir } from "../helpers/fixtures.js";

function fixture(): { run: (args: string) => Promise<{ ok: boolean; text: string }>; env: { XDG_CONFIG_HOME: string } } {
	const env = { XDG_CONFIG_HOME: tempDir("leanpi-thinking-") };
	const registry = createCommandRegistry();
	registerThinkingFoldCommand(registry, env);
	return { run: (args) => registry.dispatch(`/thinking-fold ${args}`.trim(), { cwd: process.cwd() }), env };
}

describe("/thinking-fold", () => {
	it("folds by default, and says so before anything is stored", async () => {
		const { run, env } = fixture();
		expect(thinkingFoldEnabled(env)).toBe(true);
		expect((await run("")).text).toContain("on");
	});

	it("stores off, and reads it back", async () => {
		const { run, env } = fixture();
		const off = await run("off");
		expect(off.ok).toBe(true);
		expect(thinkingFoldEnabled(env)).toBe(false);
		expect((await run("")).text).toContain("off");
		expect(await run("on").then((result) => result.ok)).toBe(true);
		expect(thinkingFoldEnabled(env)).toBe(true);
	});

	it("refuses anything but on and off", async () => {
		const { run } = fixture();
		expect((await run("maybe")).ok).toBe(false);
	});

	it("is the extension the launcher attaches, and the only thing it changes", () => {
		// Off leaves the compact UI attached: Pi's own live reasoning is what the
		// user then sees, rendered by `pi-claude-code-ui`.
		const folded = launchPlan([], undefined, undefined, "compact", true);
		const live = launchPlan([], undefined, undefined, "compact", false);
		// `.ts`, and that is the whole point: Pi native-imports a `.js` extension
		// instead of routing it through jiti, so the vendor's `index.min.js`
		// patched a second copy of `AssistantMessageComponent` and folded nothing
		// while loading without error. The vendored copy is the same bytes renamed.
		expect(folded.bundled.filter((path) => path.includes("pi-thinking-fold"))).toEqual([expect.stringMatching(/\.ts$/)]);
		expect(live.bundled.some((path) => path.includes("pi-thinking-fold"))).toBe(false);
		expect(live.bundled.some((path) => path.includes("pi-claude-code-ui"))).toBe(true);
		// Every attached path is a real file, so Pi is never handed a missing one.
		for (const path of bundledExtensions()) expect(path).toBeTruthy();
	});
});
