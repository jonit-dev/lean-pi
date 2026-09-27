/**
 * The compact tool rows and LeanPi's baseline surface have to agree on who
 * registers `read`, `edit` and `write`: Pi refuses a duplicate registration and
 * drops the whole extension with it, which is how the renderer silently failed
 * to load at all.
 *
 * The second half drives the real packages: `pi-claude-code-ui` patched in load
 * order and LeanPi's own subagent row on top of it, which is the only place a
 * card title can be fixed without forking either package.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { BASELINE_TOOL_NAMES, YIELDED_TOOL_NAMES, registerBaselineTools } from "../../src/core/tools.js";
import { loadConfig } from "../../src/index.js";
import { registerSubagentRouting } from "../../src/subagents/route.js";
import { installSubagentCard } from "../../src/cli/subagent-card.js";
import { resetSubagentCard } from "../../src/subagents/card.js";
import { tempDir } from "../helpers/fixtures.js";

function registered(yielded: readonly string[]): string[] {
	const names: string[] = [];
	registerBaselineTools({ registerTool: (definition: { name: string }) => names.push(definition.name) } as never, process.cwd(), yielded);
	return names;
}

describe("the baseline surface under the compact UI", () => {
	it("registers all five when nothing is yielded", () => {
		expect(registered([])).toEqual([...BASELINE_TOOL_NAMES]);
	});

	it("leaves the yielded names to the extension that took them, and keeps them on the allowlist", () => {
		const names = registered(YIELDED_TOOL_NAMES);
		for (const name of YIELDED_TOOL_NAMES) expect(names).not.toContain(name);
		// `search` and `execute` are LeanPi's under both names — `execute` carries
		// the command timeout and the spawn environment, which nothing else does.
		expect(names).toEqual(["search", "execute"]);
		const allowlist = registerBaselineTools({ registerTool: () => {} } as never, process.cwd(), YIELDED_TOOL_NAMES);
		expect(allowlist).toEqual([...BASELINE_TOOL_NAMES]);
	});
});

/** The card as the operator reads it: one line, no theme escapes. */
function cardLine(component: { render(width: number): string[] }): string {
	return component
		.render(120)
		.join(" ")
		.replace(/\[[0-9;]*m/g, "");
}

const THEME = { fg: (_key: string, text: string) => text, bold: (text: string) => text };

/** The same theme with the color key kept, so a row's state can be read back. */
const KEYED_THEME = { fg: (key: string, text: string) => `[${key}]${text}[/${key}]`, bold: (text: string) => text };

type Renderer = (args: unknown, theme: unknown, context: unknown) => { render(width: number): string[] };

/**
 * The compact UI loaded and patched as it is in a real session, then LeanPi's own
 * subagent row installed on top of it: the loader's order is what makes ours the
 * outer wrapper, and the card can only be fixed there without forking either.
 */
async function compactUiLoad(): Promise<() => Renderer | undefined> {
	const mod = await import("pi-claude-code-ui/extensions/index.ts");
	const pi = new Proxy({} as Record<string, unknown>, { get: (target, key: string) => target[key] ?? (() => undefined) });
	(mod.default as unknown as (pi: unknown) => void)(pi);
	// What the attached entry does, on the classes Pi itself renders with.
	installSubagentCard(ToolExecutionComponent.prototype);
	return (ToolExecutionComponent.prototype as unknown as { getCallRenderer: () => Renderer | undefined }).getCallRenderer;
}

/** One `subagent` call through the production route hook, rendered as a card. */
async function spawnCard(pick: () => Renderer | undefined, input: Record<string, unknown>, toolCallId: string, render: Record<string, unknown> = {}, theme: unknown = THEME): Promise<string> {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
	const cwd = tempDir("leanpi-card-");
	const config = loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: {
			quick: { backend: "local", model: "m-quick" },
			balanced: { backend: "local", model: "m-balanced" },
			strong: { backend: "local", model: "m-strong" },
		},
	});
	registerSubagentRouting({ on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => void handlers.set(event, handler) } as never, {
		config,
		cwd,
		client: { ask: async () => Promise.reject(new Error("jev off")), fallbackCount: () => 0 },
	});
	const ctx = {
		hasUI: false,
		ui: { notify: () => {} },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id, name: id === "m-strong" ? "Opus 5.5" : id }) },
	};
	await handlers.get("tool_call")?.({ toolName: "subagent", toolCallId, input }, ctx);
	const args = { ...input };
	const renderer = pick.call({ toolName: "subagent", args });
	if (renderer === undefined) throw new Error("no renderer for the subagent row");
	return cardLine(renderer(args, theme, { toolCallId, args, lastComponent: undefined, state: {}, cwd, isPartial: false, argsComplete: true, ...render }));
}

describe("the subagent row under the compact UI", () => {
	let pick: () => Renderer | undefined;

	beforeAll(async () => {
		pick = await compactUiLoad();
		resetSubagentCard();
	});

	it("names the child, the model it was routed to and the effort (AC-2)", async () => {
		// `Subagent Subagent` is what the package's own generic row rendered: the
		// humanized tool name is the label, and the summary falls back to the same
		// humanized name. The operator wants the child's name and what it runs on,
		// and a call that names no agent gets a call sign in spawn order.
		const first = await spawnCard(pick, { task: "fix the typo in the README label" }, "call-1");
		expect(first).toContain("Subagent Alpha: m-quick (Low)");
		const second = await spawnCard(pick, { task: "fix the race condition in the runtime lock" }, "call-2");
		expect(second).toContain("Subagent Bravo: Opus 5.5 (High)");
		const named = await spawnCard(pick, { agent: "reviewer", task: "fix the race condition in the runtime lock" }, "call-3");
		expect(named).toContain("Subagent reviewer: Opus 5.5 (High)");
		expect(first).not.toContain("Subagent Subagent");
		expect(second).not.toContain("Subagent Subagent");
		expect(named).not.toContain("Subagent Subagent");
	});

	it("labels an external-runner agent by what it is, with no model to show (AC-2)", async () => {
		// `claude-code` is `runner.type: external-cli`: no Pi model and no effort to
		// route, so the card names the harness instead of an empty colon.
		const card = await spawnCard(pick, { agent: "claude-code", task: "fix the race condition in the runtime lock" }, "call-4");
		expect(card).toContain("Subagent Claude Code");
		expect(card).not.toContain("Subagent Subagent");
	});

	it("keeps the package's own status dot, so a failed card still reads as failed (AC-2)", async () => {
		// The row was once redrawn from scratch, which dropped the live dot: the dot
		// and its pending/success/error state are the package's, drawn from the call's
		// own state, and only the duplicate title is ours to replace.
		const done = await spawnCard(pick, { agent: "reviewer", task: "fix the typo in the README label" }, "call-5", {}, KEYED_THEME);
		expect(done.startsWith("[success]")).toBe(true);
		expect(done).toContain("reviewer: m-quick (Low)");
		const failed = await spawnCard(pick, { agent: "reviewer", task: "fix the race condition in the runtime lock" }, "call-6", { isError: true }, KEYED_THEME);
		expect(failed.startsWith("[error]")).toBe(true);
		expect(failed).toContain("reviewer: Opus 5.5 (High)");
	});
});
