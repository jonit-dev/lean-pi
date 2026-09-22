/**
 * `/thinking-fold` decides which reasoning display the next session attaches,
 * and stores it outside the repository so the launcher can read it first.
 *
 * `scripts/vendor-thinking-fold.mjs` patches the vendored copy of
 * `@99percentpeople/pi-thinking-fold`; the last suites drive that patched copy's
 * real `AssistantMessageComponent` render/toggle boundary and its
 * `message_update` working-status hook with synthetic messages, no model.
 */
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { MouseRegion } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { applyThinkingFoldPatches } from "../../scripts/vendor-thinking-fold.mjs";
import { createCommandRegistry } from "../../src/index.js";
import { registerThinkingFoldCommand } from "../../src/commands/thinking-fold.js";
import { bundledExtensions, dependencyDir, foldCacheExtension, launchPlan, packageRoot, thinkingFoldExtension } from "../../src/cli/launch.js";
import { installFoldCacheInvalidation } from "../../src/cli/fold-cache.js";
import installThinkingFoldExtension from "../../vendor/pi-thinking-fold/index.min.ts";
import { installThinkingFoldPatch, resolveThinkingDisplayBehavior } from "../../vendor/pi-thinking-fold/index.min.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
		// Before the compact UI, and that order is the fix: folding delegates to
		// whichever `updateContent` was on the prototype when it loaded, and only
		// Pi's own honours `hideThinkingBlock`. Attached after `pi-claude-code-ui`,
		// every trace streamed in full under the default `--ui compact`.
		const order = folded.bundled.map((path) => (path.includes("pi-thinking-fold") ? "fold" : path.includes("pi-claude-code-ui") ? "cc-ui" : "other"));
		expect(order.indexOf("fold")).toBeLessThan(order.indexOf("cc-ui"));
		expect(live.bundled.some((path) => path.includes("pi-thinking-fold"))).toBe(false);
		expect(live.bundled.some((path) => path.includes("pi-claude-code-ui"))).toBe(true);
		// Every attached path is a real file, so Pi is never handed a missing one.
		// `existsSync`, not `toBeTruthy`: `bundledExtensions` drops the fold when
		// the vendored copy is missing, which is the silent no-op this whole
		// change exists to kill, and a joined path is truthy either way.
		for (const path of bundledExtensions()) expect(existsSync(path), path).toBe(true);
	});

	it("clears the compact UI's render cache, but only where both are attached", () => {
		// Ctrl+T rebuilds the folded block without going through `updateContent`,
		// so the compact UI's per-width cache keeps serving the pre-toggle lines
		// and the expand does nothing. Pointless with either half missing.
		const args = (ui: "compact" | "plain", fold: boolean) => launchPlan([], undefined, undefined, ui, fold).args.join(" ");
		expect(args("compact", true)).toContain(foldCacheExtension());
		expect(args("plain", true)).not.toContain(foldCacheExtension());
		expect(args("compact", false)).not.toContain(foldCacheExtension());
		// Last, so it wraps the compact UI's own `render` patch rather than sitting under it.
		const plan = launchPlan([], undefined, undefined, "compact", true);
		const attached = plan.args.filter((argument, index) => plan.args[index - 1] === "--extension");
		expect(attached[attached.length - 1]).toBe(foldCacheExtension());
	});

	it("ships the installed build with exactly the binary-collapse patch, reproducibly", () => {
		// `vendor/` is committed and only `npm run build` regenerates it. The patch
		// is the contract, so the check is the transform: re-running it on the
		// installed build must reproduce the committed copy, and a dependency bump
		// that moves a claimed string makes the transform throw, not silently stop
		// collapsing. `applyThinkingFoldPatches`' guard is the drift test.
		const installed = dependencyDir(join("@99percentpeople", "pi-thinking-fold", "index.min.js"), packageRoot());
		expect(installed, "@99percentpeople/pi-thinking-fold is not installed").toBeTruthy();
		const upstream = readFileSync(installed as string, "utf8");
		const expected = applyThinkingFoldPatches(upstream);
		expect(expected).not.toBe(upstream);
		expect(readFileSync(thinkingFoldExtension(), "utf8")).toBe(expected);
		// The working-status label is forced generic at the call site; the summary
		// lookup that drives the linger timing is left in place.
		expect(expected).toContain("let n=U;if(n===V)return");
		expect(expected).not.toContain("let n=D(J,u.options.mode)");
		// The preview controls are gone, not turned into a single-value menu, and no
		// persisted preview/full value is shown.
		expect(expected).toContain('settings:()=>[{id:"reasoning"');
		expect(expected).not.toContain("Fold after lines");
		expect(expected).not.toContain("terminal-visible lines in a preview");
		expect(expected).not.toContain("previews traces");
		expect(expected).not.toContain('values:["auto","preview","collapse"]');
		expect(expected).not.toContain('values:["auto","collapse","preview","full"]');
		expect(() => applyThinkingFoldPatches("upstream changed")).toThrow(/expected exactly one match/);
	});
});

/** ANSI SGR and OSC 133 markers stripped, so assertions read as the user's text. */
function plain(lines: string[]): string {
	return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

const ANSWER = "the answer stays visible";
const TRACE_LINES = Array.from({ length: 12 }, (_, index) => `TRACE_LINE_${String(index + 1).padStart(2, "0")}`);
const TRACE = TRACE_LINES.join("\n");
const TRACE_HEAD = TRACE_LINES[0];
const TRACE_MIDDLE = TRACE_LINES[Math.floor(TRACE_LINES.length / 2)];
const TRACE_TAIL = TRACE_LINES[TRACE_LINES.length - 1];
/** Matches every trace line, so an assertion cannot miss one. */
const TRACE_MARKER = "TRACE_LINE_";
const APPENDED_LINE = "TRACE_LINE_APPENDED";
const SECOND_LEAK_LINE = "SECOND_LEAK_LINE";

function assistant(thinking: string, text: string, timestamp = 1, api?: string): Parameters<AssistantMessageComponent["updateContent"]>[0] {
	return { role: "assistant", timestamp, ...(api ? { api } : {}), content: [{ type: "thinking", thinking }, { type: "text", text }] } as Parameters<AssistantMessageComponent["updateContent"]>[0];
}

const mounted: Array<ReturnType<typeof installThinkingFoldPatch>> = [];
const mouseRegionProto = MouseRegion.prototype as unknown as Record<string, unknown>;
const originalHandleMouse = mouseRegionProto.handleMouse;

/** Disposes fold ownership and any prototype a test clobbered. */
afterEach(() => {
	mouseRegionProto.handleMouse = originalHandleMouse;
	while (mounted.length > 0) mounted.pop()?.dispose();
});

/** The patched installed extension, mounted on a fresh component, collapsed. */
function mount(): { fold: ReturnType<typeof installThinkingFoldPatch>; component: AssistantMessageComponent } {
	initTheme("dark");
	const fold = installThinkingFoldPatch();
	fold.setExpanded(false);
	mounted.push(fold);
	return { fold, component: new AssistantMessageComponent() };
}

describe("the vendored fold at its render boundary", () => {
	it("resolves every non-expanded block to collapse, even with persisted preview or full", () => {
		const message = assistant(TRACE, ANSWER);
		for (const mode of ["auto", "summary"] as const) {
			for (const streamingBehavior of ["auto", "preview"] as const) {
				for (const completedBehavior of ["auto", "preview", "full"] as const) {
					expect(resolveThinkingDisplayBehavior(message, { mode, previewLines: 5, streamingBehavior, completedBehavior, toggleKey: "ctrl+t" }, false)).toBe("collapse");
				}
			}
		}
	});

	it("shows zero trace from the first streaming frame, and the label to expand", () => {
		const { component } = mount();
		component.updateContent(assistant(TRACE, ANSWER), true);
		const rendered = plain(component.render(100));
		expect(rendered).toContain("Thinking");
		expect(rendered).toContain("ctrl+t to expand");
		expect(rendered).toContain(ANSWER);
		expect(rendered).not.toContain(TRACE_MARKER);
	});

	it("stays hidden as more chunks arrive and when the turn completes", () => {
		const { fold, component } = mount();
		const message = assistant(TRACE, ANSWER);
		component.updateContent(message, true);
		component.updateContent(assistant(`${TRACE}\n${APPENDED_LINE}`, ANSWER), true);
		expect(plain(component.render(100))).not.toContain(TRACE_MARKER);
		fold.completeMessage(message, 0);
		component.updateContent(message, false);
		const done = plain(component.render(100));
		expect(done).toContain("Thought for");
		expect(done).not.toContain(TRACE_MARKER);
	});

	it("Ctrl+T reveals the full trace mid-stream and after completion, and hides it again", () => {
		const { fold, component } = mount();
		const message = assistant(TRACE, ANSWER);
		component.updateContent(message, true);

		fold.toggle();
		const midStream = plain(component.render(100));
		for (const line of [TRACE_HEAD, TRACE_MIDDLE, TRACE_TAIL]) expect(midStream).toContain(line);
		expect(midStream).toContain(ANSWER);

		// Chunks appended while expanded stay full.
		component.updateContent(assistant(`${TRACE}\n${APPENDED_LINE}`, ANSWER), true);
		expect(plain(component.render(100))).toContain(APPENDED_LINE);

		// After completion, still full rather than a 5-line tail preview: head,
		// middle and tail all survive, then the re-collapse hides them.
		fold.completeMessage(message, 0);
		component.updateContent(message, false);
		const completed = plain(component.render(100));
		for (const line of [TRACE_HEAD, TRACE_MIDDLE, TRACE_TAIL]) expect(completed).toContain(line);
		expect(completed).toContain(ANSWER);

		fold.toggle();
		expect(plain(component.render(100))).not.toContain(TRACE_MARKER);
		// Chunks appended after the re-collapse stay hidden.
		component.updateContent(assistant(`${TRACE}\n${APPENDED_LINE}`, ANSWER), false);
		expect(plain(component.render(100))).not.toContain(APPENDED_LINE);

		// A second, separately-timestamped collapsed message does not inherit the
		// first message's trace.
		const second = assistant(SECOND_LEAK_LINE, "second answer", 2);
		component.updateContent(second, false);
		const secondRendered = plain(component.render(100));
		expect(secondRendered).toContain("second answer");
		expect(secondRendered).not.toContain(SECOND_LEAK_LINE);
		expect(secondRendered).not.toContain(TRACE_MARKER);
	});

	it("honours Ctrl+T pressed before any thinking is present", () => {
		const { fold, component } = mount();
		fold.toggle();
		component.updateContent(assistant(TRACE, ANSWER), true);
		const expanded = plain(component.render(100));
		expect(expanded).toContain(TRACE_HEAD);
		expect(expanded).toContain(TRACE_TAIL);
		fold.toggle();
		expect(plain(component.render(100))).not.toContain(TRACE_MARKER);
	});

	it("falls back to the collapsed label when a child cannot be rewrapped", () => {
		// `ru` recognises a rewrappable child by its `handleMouse`; without it the
		// rewrap fails and the patched fallback must render collapsed, never the
		// raw trace. The prototype is restored by `afterEach`.
		const { component } = mount();
		mouseRegionProto.handleMouse = undefined;
		component.updateContent(assistant(TRACE, ANSWER), true);
		const rendered = plain(component.render(100));
		expect(rendered).toContain(ANSWER);
		expect(rendered).toContain("ctrl+t to expand");
		for (const line of [TRACE_HEAD, TRACE_MIDDLE, TRACE_TAIL]) expect(rendered).not.toContain(line);
	});

	it("clears the compact UI's render cache so the hidden toggle survives it", () => {
		// Under `--ui compact`, Ctrl+T rebuilds the block outside `updateContent`,
		// and the compact UI keeps serving its per-width cache. LeanPi's wrapper
		// drops that cache on every reasoning render; simulate the stale entry.
		const cache = Symbol.for("pi-claude-style-tools:message-render-cache");
		const { fold, component } = mount();
		installFoldCacheInvalidation();
		component.updateContent(assistant(TRACE, ANSWER), true);
		(component as unknown as Record<symbol, unknown>)[cache] = [["stale"]];
		component.render(100);
		expect((component as unknown as Record<symbol, unknown>)[cache]).toBeUndefined();
		fold.toggle();
		(component as unknown as Record<symbol, unknown>)[cache] = [["stale"]];
		component.render(100);
		expect((component as unknown as Record<symbol, unknown>)[cache]).toBeUndefined();
		expect(plain(component.render(100))).toContain(TRACE_HEAD);
	});
});

describe("the vendored fold's working status", () => {
	it("keeps the working status generic through the extension's message_update hook", () => {
		// `Yu`'s `message_update` handler fed `createThinkingCursorLabel` into
		// `ui.setWorkingMessage`, so a `summary` model rule put the first trace
		// line in the working status while the block was collapsed. Drive the
		// registered hook directly: no model, no TUI.
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tempDir("leanpi-agent-");
		const working: Array<string | undefined> = [];
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
		const on = (event: string, handler: (event: unknown, ctx: unknown) => void): void => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		};
		const fire = (event: string, payload: unknown, ctx: unknown): void => {
			for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
		};
		const ui = {
			setWorkingMessage: (value?: string) => {
				working.push(value);
			},
			setWidget: () => ({}),
			notify: () => {},
			onTerminalInput: () => () => {},
		};
		const message = assistant(TRACE, ANSWER, 1, "responses");
		try {
			installThinkingFoldExtension({ on, registerCommand: () => {} } as never);
			fire("message_start", { message }, { mode: "tui", ui });
			fire("message_update", { message, assistantMessageEvent: { type: "thinking_delta" } }, { mode: "tui", ui, model: { reasoning: false } });
			expect(working.length).toBeGreaterThan(0);
			expect(working.at(-1)).toBe("Thinking...");
			expect(working.join("|")).not.toContain(TRACE_MARKER);
		} finally {
			fire("session_shutdown", {}, { mode: "tui", hasUI: false, ui });
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});
});
