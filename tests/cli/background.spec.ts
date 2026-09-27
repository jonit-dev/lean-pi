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
import { describe, expect, it } from "vitest";
import { backgroundTasksAdapter, type BackgroundPi } from "../../src/cli/background.js";

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
