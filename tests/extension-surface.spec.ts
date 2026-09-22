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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activate, grantTrust, readRuns } from "../src/index.js";
import { clearLanes, registerLane } from "../src/commands/session.js";
import { loadConfig } from "../src/core/config.js";
import { LEANPI_RECAP_WIDGET_KEY } from "../src/cli/recap-widget.js";
import { fixtureContract } from "./routing/fixture.js";

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
	inputs: string[];
	statuses: Array<string | undefined>;
	newSessions: unknown[];
	widgets: Array<{ key: string; content: string[] | undefined }>;
	ctx: Record<string, unknown>;
} {
	const commands = new Map<string, Registered>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const notices: string[] = [];
	const inputs: string[] = [];
	const statuses: Array<string | undefined> = [];
	const newSessions: unknown[] = [];
	const widgets: Array<{ key: string; content: string[] | undefined }> = [];
	return {
		commands,
		handlers,
		notices,
		inputs,
		statuses,
		newSessions,
		widgets,
		pi: {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
			registerTool: () => {},
			registerCommand: (name: string, options: Registered) => commands.set(name, options),
			registerProvider: () => {},
			setModel: async () => true,
			setThinkingLevel: () => {},
			setSessionName: () => {},
			getSessionName: () => undefined,
			appendEntry: () => {},
		},
		ctx: {
			hasUI: true,
			cwd: process.cwd(),
			sessionManager: { getSessionId: () => "pi-session" },
			getContextUsage: () => ({ tokens: 1234, contextWindow: 200_000, percent: 1 }),
			modelRegistry: { find: () => undefined },
			newSession: async (options?: unknown) => {
				newSessions.push(options);
				return { cancelled: false };
			},
			ui: {
				notify: (message: string) => notices.push(message),
				setStatus: (_key: string, text: string | undefined) => statuses.push(text),
				setWidget: (key: string, content: string[] | undefined) => widgets.push({ key, content }),
				input: async (prompt: string) => {
					inputs.push(prompt);
					return undefined;
				},
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
		for (const name of ["help", "status", "doctor", "route", "jev", "permissions", "todo", "goal", "prd", "verify", "recap"]) {
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

	it("'/recap' regenerates through the bridge's live host, not a hand-built one", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, commands, handlers, widgets, notices, ctx } = fakePi();
		clearLanes();
		activate(pi as never, {
			cwd,
			config: loadConfig(cwd, {}, env),
			env,
			recapRunner: async () => "RECAP: Bridged recap.\nTITLE: Bridged Title",
		});

		// Seed the last turn through the Pi path so `/recap` has something to redo.
		const messages = [
			{ role: "user", content: [{ type: "text", text: "wire the recap" }] },
			{ role: "assistant", content: [{ type: "text", text: "wired it" }] },
		];
		await handlers.get("agent_end")?.({ messages }, ctx);
		await handlers.get("agent_settled")?.({}, ctx);
		const before = widgets.filter((call) => call.key === LEANPI_RECAP_WIDGET_KEY).length;

		// Through the bridge: it builds `recapHost` from Pi's own live ctx, which is
		// the only thing that can set a widget. A hand-built context would prove the
		// command but not the plumbing that feeds it.
		await commands.get("recap")?.handler("", ctx);

		const recaps = widgets.filter((call) => call.key === LEANPI_RECAP_WIDGET_KEY);
		expect(recaps.length).toBeGreaterThan(before);
		expect(recaps.at(-1)?.content?.[0]).toContain("Bridged recap.");
		expect(notices.some((notice) => notice.includes("Bridged recap."))).toBe(true);
		clearLanes();
	});

	it("'/clear' runs Pi's own new-session action, the same one '/new' runs", async () => {
		const { cwd, env } = project(NATIVE);
		const { pi, commands, newSessions, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });

		// The alias is a Pi session action, not a LeanPi registry command: it
		// must not appear in LeanPi's `/help` (it delegates to `ctx.newSession()`
		// instead of re-implementing the reset), and it must not shadow a Pi
		// built-in. `/clear` is free, so Pi's own `/new` keeps working.
		expect(commands.has("clear")).toBe(true);
		await commands.get("clear")?.handler("", ctx);
		expect(newSessions).toHaveLength(1);
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

	it("records exactly one failed row when the interactive turn throws after compiling", async () => {
		const { cwd, env } = project(EXTERNAL);
		const { pi, handlers, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
		// Replace the owned lanes with one that compiles and then fails, the way
		// the gate's unreadable-path hash does after the worker and reviewer ran.
		clearLanes();
		registerLane({
			name: "test.throwing",
			async run(_turn, context) {
				context.contract = fixtureContract({ complexity: "LOW", executor_class: "balanced" });
				throw new Error("the gate could not hash a touched path");
			},
		});

		await expect(handlers.get("input")?.({ text: "do it", source: "interactive" }, ctx)).rejects.toThrow(/could not hash/);

		const rows = readRuns(cwd);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.result.success).toBe(false);
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

describe("the JEV warning at session start", () => {
	const ENABLED = NATIVE.replace("  mode: disabled", "  mode: enabled");

	it("warns once with no blocking prompt when no key is configured", async () => {
		const { cwd, env } = project(ENABLED);
		const { pi, handlers, notices, inputs, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });

		await handlers.get("session_start")?.({ reason: "startup" }, ctx);

		// The old first-run prompt blocked the session on a credential the
		// harness can run without; the warning replaces it.
		expect(inputs).toHaveLength(0);
		expect(notices.filter((notice) => notice.includes("typesafe.ai"))).toHaveLength(1);
		clearLanes();
	});

	it("stays silent when leanpi already warned in this run", async () => {
		const { cwd, env } = project(ENABLED);
		const { pi, handlers, notices, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env: { ...env, LEANPI_JEV_WARNED: "1" } });

		await handlers.get("session_start")?.({ reason: "startup" }, ctx);

		expect(notices.filter((notice) => notice.includes("typesafe.ai"))).toHaveLength(0);
		clearLanes();
	});
});

describe("SURF-4: default skill roots respect project trust", () => {
	/** A project and a separate user home, so the two skill sources cannot alias. */
	function untrustedProject(): { cwd: string; env: NodeJS.ProcessEnv } {
		const cwd = mkdtempSync(join(tmpdir(), "leanpi-skilltrust-"));
		const home = mkdtempSync(join(tmpdir(), "leanpi-skilltrust-home-"));
		writeFileSync(join(cwd, "leanpi.config.yaml"), NATIVE);
		mkdirSync(join(cwd, ".claude/skills/proj-secret"), { recursive: true });
		writeFileSync(
			join(cwd, ".claude/skills/proj-secret/SKILL.md"),
			"---\nname: proj-secret\ndescription: shipped by the checkout\n---\n\nbody\n",
		);
		return { cwd, env: { HOME: home, PATH: "", XDG_CONFIG_HOME: join(home, ".config") } };
	}

	async function indexedSkills(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
		const { pi, commands, notices, ctx } = fakePi();
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env });
		await commands.get("skills")?.handler("all", ctx);
		clearLanes();
		return notices.join("\n");
	}

	it("drops the project's own .claude/skills while untrusted, and keeps it once trusted", async () => {
		const { cwd, env } = untrustedProject();
		expect(await indexedSkills(cwd, env)).not.toContain("proj-secret");
		// The same project, now trusted: the repository's own skills are indexable.
		grantTrust(cwd, env);
		expect(await indexedSkills(cwd, env)).toContain("proj-secret");
	});
});
