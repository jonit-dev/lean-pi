/**
 * What the interactive session actually exposes: the commands the user can
 * type, and who runs the turn.
 *
 * Both were wrong in ways no unit test could see, because nothing exercised
 * `activate()` against Pi's extension API. The registry was populated and never
 * handed to Pi, so no LeanPi command existed in the TUI; and on an
 * external-harness configuration the executor lane ran inside
 * `before_agent_start` and then let Pi's own loop answer the same prompt a
 * second time.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activate } from "../src/index.js";
import { clearLanes } from "../src/commands/session.js";
import { loadConfig } from "../src/core/config.js";

interface Registered {
	description?: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

/** Pi's extension API as `activate()` uses it, with the calls a test asserts on captured. */
function fakePi(): {
	pi: Record<string, unknown>;
	commands: Map<string, Registered>;
	handlers: Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>;
	notices: string[];
	statuses: Array<string | undefined>;
	ctx: Record<string, unknown>;
} {
	const commands = new Map<string, Registered>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const notices: string[] = [];
	const statuses: Array<string | undefined> = [];
	return {
		commands,
		handlers,
		notices,
		statuses,
		pi: {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
			registerTool: () => {},
			registerCommand: (name: string, options: Registered) => commands.set(name, options),
			registerProvider: () => {},
			setModel: async () => true,
			setThinkingLevel: () => {},
		},
		ctx: {
			hasUI: true,
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "pi-session" },
			getContextUsage: () => ({ tokens: 1234, contextWindow: 200_000, percent: 1 }),
			modelRegistry: { find: () => undefined },
			ui: {
				notify: (message: string) => notices.push(message),
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
				input: async () => undefined,
			},
		},
	};
}

function project(config: string): { cwd: string; env: NodeJS.ProcessEnv } {
	const cwd = mkdtempSync(join(tmpdir(), "leanpi-surface-"));
	writeFileSync(join(cwd, "leanpi.config.yaml"), config);
	return { cwd, env: { HOME: cwd, PATH: "", XDG_CONFIG_HOME: join(cwd, ".config") } };
}

const EXTERNAL = [
	"backends:",
	// `command` is what keeps this hermetic: the harness spawns with the *process*
	// environment, not the one this fixture passes, so a real `claude` on the
	// machine running the suite would be invoked — and billed — for every run.
	"  claude: { type: external_harness, vendor: claude, command: leanpi-absent-cli }",
	"models:",
	"  quick: { backend: claude, model: haiku }",
	"  balanced: { backend: claude, model: sonnet }",
	"  strong: { backend: claude, model: opus }",
	// A throwaway directory has no language server to start, and `auto` spends
	// its full readiness window finding that out.
	"lsp: { mode: off }",
	"jev:",
	"  mode: disabled",
	"",
].join("\n");

const NATIVE = [
	"backends:",
	"  local: { type: native, baseUrl: https://example.test }",
	"models:",
	"  quick: { backend: local, model: cheap }",
	"  balanced: { backend: local, model: cheap }",
	"  strong: { backend: local, model: cheap }",
	"jev:",
	"  mode: disabled",
	"",
].join("\n");

describe("LeanPi's commands reach Pi", () => {
	it("registers every command in its registry with Pi, and dispatches through the same handlers", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, commands, notices, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });

		// Before this, none of these were commands at all: the text fell through
		// to the model as a prompt, including the `/permissions set …` the
		// permission guard's own refusal tells the user to run.
		for (const name of ["help", "status", "doctor", "route", "jev", "permissions", "todo", "goal", "prd", "verify"]) {
			expect(commands.has(name), `${name} is not registered with Pi`).toBe(true);
		}
		await commands.get("help")?.handler("", ctx);
		expect(notices.join("\n")).toContain("/doctor");
		clearLanes();
	});

	it("does not take over a name Pi ships itself", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, commands } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });

		// Pi resolves extension commands before its own, so bridging `/compact`
		// would delete Pi's LLM compaction. LeanPi's is a different operation.
		expect(commands.has("compact")).toBe(false);
		expect(commands.has("compact-refs")).toBe(true);
		clearLanes();
	});
});

describe("who runs the turn", () => {
	it("is LeanPi on an external-harness configuration, and Pi is told the turn is handled", async () => {
		const { cwd, env } = project(EXTERNAL);
		const { pi, handlers, notices, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });

		const input = handlers.get("input");
		expect(input).toBeDefined();
		const result = await input?.({ text: "explain src/index.ts", source: "interactive" }, ctx);

		// `handled` is what stops Pi's own loop from answering the same prompt
		// with a second model after LeanPi's executor already ran it.
		expect(result).toEqual({ action: "handled" });
		// And the user is shown LeanPi's own result rather than nothing. The report
		// leads with a verdict glyph, not the harness's own name: the user knows
		// which harness they launched, and the line has to say how the turn went.
		expect(notices.some((notice) => /^(✅|⚠️|❌) /.test(notice))).toBe(true);
		clearLanes();
	}, 30_000);

	it("is Pi's own loop on a native configuration, where LeanPi only compiles", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, handlers, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });

		// Nothing is handled here: Pi's loop *is* the executor (§23), and
		// claiming the input would leave the user with no answer at all.
		expect(await handlers.get("input")?.({ text: "rename the helper", source: "interactive" }, ctx)).toBeUndefined();
		clearLanes();
	});
});

describe("--no-jev", () => {
	it("disables the control plane in the session, not just the startup check", async () => {
		const { cwd, env } = project(NATIVE.replace("  mode: disabled", "  mode: enabled"));
		const { pi } = fakePi();
		clearLanes();
		const activation = activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env: { ...env, LEANPI_NO_JEV: "1" } });

		// The flag used to only tolerate a missing key: with one present every
		// site still called the control plane and the flag bought nothing.
		expect(activation.jev.getMode()).toBe("disabled");
		clearLanes();
	});
});
