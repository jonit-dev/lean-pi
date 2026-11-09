/**
 * PRD-052 AC-4 — what the backgrounded shell says about a command that produced
 * no output.
 *
 * `pi-patty-bg-tasks` reads an empty command log as the sentinel `(no output yet)`
 * and hands that sentinel back as the result: on success it is the whole result,
 * and on a non-zero exit it *is* the error message, so the exit code was lost and
 * "yet" read as still running. LeanPi's adapter owns the registration, so it is
 * where the report is corrected — upstream is untouched, and the exit code stays
 * upstream's to keep.
 *
 * The tool is the real bundled one, not a stand-in: the sentinel comes from the
 * package's log reader, and a fake `execute` would prove nothing about it.
 */
import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { backgroundTasksAdapter, compactUiAdapter, type BackgroundPi } from "../../src/cli/background.js";

type BundledTool = {
	name: string;
	execute?: (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content?: Array<{ type?: string; text?: string }> }>;
};

const SESSION = { cwd: process.cwd(), hasUI: false, ui: {} };

/** The real package's `bash`, through the adapter that attaches it. */
async function bundledBash(): Promise<BundledTool> {
	const bundled = (await import("pi-patty-bg-tasks/index.ts")).default as unknown as (pi: BackgroundPi) => void;
	const tools: BundledTool[] = [];
	const starts: Array<(event: unknown, ctx: unknown) => Promise<void>> = [];
	const raw: Record<string, unknown> = {
		registerTool: (tool: BundledTool) => void tools.push(tool),
		on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => event === "session_start" && starts.push(handler),
	};
	const pi = new Proxy(raw, { get: (target, key: string) => target[key] ?? (() => undefined) });
	backgroundTasksAdapter(bundled)(pi as unknown as BackgroundPi);
	for (const start of starts) await start({}, { sessionManager: { getEntries: () => [] } });
	const bash = tools.find((tool) => tool.name === "bash");
	if (bash?.execute === undefined) throw new Error("the adapter registered no bash tool with an execute");
	return bash;
}

describe("a command with no output (AC-4)", () => {
	it("fails with a message, and succeeds with none of the sentinel", async () => {
		const bash = await bundledBash();
		// `sh -c 'exit 3'` exits non-zero and writes nothing: exactly the shape the
		// operator met as `isError` text `(no output yet)`.
		const failed = await bash
			.execute!("call-1", { command: "sh -c 'exit 3'" }, undefined, undefined, SESSION)
			.then(() => undefined, (error: Error) => error.message);
		expect(failed).toBe("Command failed (non-zero exit) with no output");

		const done = await bash.execute!("call-2", { command: "true" }, undefined, undefined, SESSION);
		expect(done.content?.map((block) => block.text)).toEqual(["(no output)"]);
	}, 30_000);
});

/**
 * The backgrounding `bash` wins the name, so under the compact UI it used to
 * render with Pi's own row: every command printed in full, wrapped over half the
 * screen. The compact UI's `bash` row — one headline, script behind Ctrl+O — is
 * handed to it instead, through the compact UI's adapter.
 */
describe("the backgrounding bash under the compact UI", () => {
	it("renders the compact UI's one-line row, not the full command", async () => {
		initTheme("dark");
		const tools: Array<{ name: string; renderCall?: (...args: unknown[]) => { render(width: number): string[] } }> = [];
		const starts: Array<(event: unknown, ctx: unknown) => Promise<void>> = [];
		const raw: Record<string, unknown> = {
			registerTool: (tool: (typeof tools)[number]) => void tools.push(tool),
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => event === "session_start" && starts.push(handler),
			getAllTools: () => [],
		};
		const pi = new Proxy(raw, { get: (target, key: string) => target[key] ?? (() => undefined) });
		// Launch order: the background adapter ahead of the compact UI.
		const background = (await import("pi-patty-bg-tasks/index.ts")).default as unknown as (pi: BackgroundPi) => void;
		backgroundTasksAdapter(background)(pi as unknown as BackgroundPi);
		const compact = (await import("pi-claude-code-ui/extensions/index.ts")).default as unknown as (pi: unknown) => void;
		compactUiAdapter(compact)(pi);
		for (const start of starts) await start({}, { sessionManager: { getEntries: () => [] } });

		// The runtime owner is the first `bash` registered after load: the adapter's.
		const bash = tools.filter((tool) => tool.name === "bash").at(-1);
		const tail = "for w in a b c d e f g; do echo $w; done";
		const command = `cd /tmp && gh pr list --state open --json number,mergeStateStatus --limit 50 --jq '.[] | .number' | sort -n; echo "=== branches ==="; ${"x ".repeat(120)}${tail}`;
		const theme = { fg: (_key: string, text: string) => text, bg: (_key: string, text: string) => text, bold: (text: string) => text };
		const row = bash!.renderCall!({ command }, theme, { lastComponent: undefined, state: {}, argsComplete: true, expanded: false, cwd: "/tmp", toolCallId: "call-1", args: { command } });
		const text = row.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		expect(text).toContain("Bash");
		expect(text).not.toContain(command);
		expect(text.split("\n").filter((line) => line.trim() !== "")).toHaveLength(1);
	}, 30_000);
});

/**
 * Typing while a foreground `bash` runs moves it to the background. The package
 * then aborted the turn and re-sent the text as a follow-up; when that follow-up
 * reached Pi before the aborted run settled, Pi queued it behind an abort it never
 * drains, and the agent sat idle with the message lost (46 mined sessions: the
 * next request failed in 0 ms with "This operation was aborted"). The adapter
 * keeps the backgrounding and hands the typed text back to Pi as-is, so Pi
 * delivers it as the steer the user sent, after the "backgrounded" result.
 */
describe("typing while a foreground bash runs", () => {
	it("backgrounds the command without aborting the turn or re-sending the text", async () => {
		const bundled = (await import("pi-patty-bg-tasks/index.ts")).default as unknown as (pi: BackgroundPi) => void;
		const tools: BundledTool[] = [];
		const handlers: Record<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>> = {};
		const resent: unknown[] = [];
		const raw: Record<string, unknown> = {
			registerTool: (tool: BundledTool) => void tools.push(tool),
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => void (handlers[event] ??= []).push(handler),
			sendUserMessage: (...args: unknown[]) => void resent.push(args),
		};
		const pi = new Proxy(raw, { get: (target, key: string) => target[key] ?? (() => undefined) });
		backgroundTasksAdapter(bundled)(pi as unknown as BackgroundPi);
		for (const start of handlers.session_start ?? []) await start({}, { sessionManager: { getEntries: () => [] } });
		const bash = tools.filter((tool) => tool.name === "bash").at(-1)!;

		let aborted = false;
		const theme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
		const ui = new Proxy({ theme } as Record<string, unknown>, { get: (target, key: string) => target[key] ?? (() => undefined) });
		const ctx = { cwd: process.cwd(), hasUI: true, ui, abort: () => void (aborted = true), isIdle: () => false, hasPendingMessages: () => false };
		const running = bash.execute!("call-1", { command: "node -e \"setTimeout(() => {}, 30000)\"" }, undefined, undefined, ctx);
		await new Promise((resolve) => setTimeout(resolve, 2_500));

		const results = await Promise.all((handlers.input ?? []).map((handler) => handler({ text: "ETA?", source: "interactive" }, ctx)));
		const result = await running;

		expect(result.content?.[0]?.text).toMatch(/^Process backgrounded as /);
		expect(aborted).toBe(false);
		expect(resent).toEqual([]);
		expect(results).toEqual([{ action: "continue" }]);
		const pid = /PID: (\d+)/.exec(result.content?.[0]?.text ?? "")?.[1];
		if (pid) process.kill(-Number(pid), "SIGTERM");
	}, 30_000);
});
