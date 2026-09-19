/**
 * PRD-017 Phase 1 — the guard as the single chokepoint.
 *
 * Every test drives a real Pi session (stub provider, real tool dispatch) and
 * asserts a side effect that did *not* happen: zero executed commands, an
 * unchanged file, a server that received nothing. Each denial is paired with a
 * permitted sibling, and the last test is the bypass control: with the guard
 * not installed, the same denial assertions must fail.
 *
 * ACs: AC-2, AC-3, AC-4, AC-5, AC-11, AC-12, AC-13, AC-14, AC-15.
 */
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GuardQuestion } from "../../src/permissions/index.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { gitInit, nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { STUB_MODEL, bootGuardedSession, call, drive, toolMessages } from "./harness.js";
import { loopbackServer, seedUserPermissions, stubMcpTool, stubSubagentTool, type LoopbackServer } from "./fixtures.js";

const backends: StubBackend[] = [];
const servers: LoopbackServer[] = [];

afterEach(async () => {
	await Promise.all(backends.splice(0).map((backend) => backend.close()));
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

interface Project {
	cwd: string;
	env: { XDG_CONFIG_HOME: string };
}

function project(options: { git?: boolean } = {}): Project {
	const cwd = tempDir("leanpi-perm-guard-");
	writeConfig(cwd, { backends: { stub: nativeBackend("http://127.0.0.1:1/v1") }, models: { balanced: { backend: "stub", model: STUB_MODEL } } });
	if (options.git) gitInit(cwd);
	return { cwd, env: { XDG_CONFIG_HOME: tempDir("leanpi-perm-xdg-") } };
}

async function withStub(stub: StubBackend): Promise<StubBackend> {
	backends.push(stub);
	return stub;
}

describe("PRD-017 AC-2 — shell deny refuses and spawns nothing", () => {
	it("refuses the command, names the scope, and never executes it", async () => {
		const stub = await withStub(await startStubBackend(drive([call("execute", { command: "touch marker.txt" })])));
		const { cwd, env } = project();
		seedUserPermissions(env, { defaults: { shell: "deny" } });
		const trace = { commands: [] as string[], paths: [] as string[] };
		const booted = await bootGuardedSession({ cwd, baseUrl: stub.baseUrl, env, trace });

		await booted.session.prompt("create the marker");

		const messages = toolMessages(stub);
		expect(messages).toContain('scope \\"shell\\"');
		expect(messages).toContain("shell:touch marker.txt");
		expect(trace.commands).toEqual([]);
		expect(existsSync(join(cwd, "marker.txt"))).toBe(false);
		booted.dispose();
	});

	it("executes the same command once shell is allowed (the denial is sensitive to the guard)", async () => {
		const stub = await withStub(await startStubBackend(drive([call("execute", { command: "touch marker.txt" })])));
		const { cwd, env } = project();
		seedUserPermissions(env, { defaults: { shell: "allow" } });
		const trace = { commands: [] as string[], paths: [] as string[] };
		const booted = await bootGuardedSession({ cwd, baseUrl: stub.baseUrl, env, trace });

		await booted.session.prompt("create the marker");

		expect(trace.commands).toEqual(["touch marker.txt"]);
		expect(existsSync(join(cwd, "marker.txt"))).toBe(true);
		booted.dispose();
	});
});

describe("PRD-017 AC-3 — ask: prompt per capability id, never a reused approval", () => {
	it("no leaves the command unexecuted, yes runs it once, a differing command re-prompts", async () => {
		const stub = await withStub(
			await startStubBackend(
				drive([call("execute", { command: "echo denied" }), call("execute", { command: "echo allowed" }), call("execute", { command: "echo other" })]),
			),
		);
		const { cwd, env } = project();
		const trace = { commands: [] as string[], paths: [] as string[] };
		const answers = [false, true, false];
		const ui = {
			prompts: [] as Array<{ title: string; message: string }>,
			confirm: () => answers[ui.prompts.length - 1] ?? false,
		};
		const booted = await bootGuardedSession({ cwd, baseUrl: stub.baseUrl, env, trace, ui });

		await booted.session.prompt("run three commands");

		// Pi's own confirmation prompt, one per exact capability id.
		expect(ui.prompts.map((prompt) => prompt.message)).toEqual([
			expect.stringContaining("shell:echo denied"),
			expect.stringContaining("shell:echo allowed"),
			expect.stringContaining("shell:echo other"),
		]);
		expect(trace.commands).toEqual(["echo allowed"]);
		const messages = toolMessages(stub);
		expect(messages).toContain("shell:echo denied");
		expect(messages).toContain("shell:echo other");
		booted.dispose();
	});
});

describe("PRD-017 AC-4 — MCP granularity is per server/tool", () => {
	it("allows fs/read_file without a prompt and refuses fs/write_file with nothing sent to the server", async () => {
		const stub = await withStub(
			await startStubBackend(drive([call("mcp__fs__read_file", { path: "target.txt" }), call("mcp__fs__write_file", { path: "target.txt", content: "CLOBBERED" })])),
		);
		const { cwd, env } = project();
		writeFileSync(join(cwd, "target.txt"), "ORIGINAL\n");
		const readStub = stubMcpTool("fs", "read_file", () => readFileSync(join(cwd, "target.txt"), "utf8"));
		const writeStub = stubMcpTool("fs", "write_file", (args) => {
			writeFileSync(join(cwd, String(args.path)), String(args.content));
			return "written";
		});
		seedUserPermissions(env, {
			defaults: { mcp: "ask" },
			rules: [
				["mcp:fs/read_file", "allow"],
				["mcp:fs/write_file", "deny"],
			],
		});
		const asked: string[] = [];
		const booted = await bootGuardedSession({
			cwd,
			baseUrl: stub.baseUrl,
			env,
			extraTools: [readStub, writeStub] as unknown as ToolDefinition[],
			confirm: (question) => {
				asked.push(question.capability);
				return true;
			},
		});

		await booted.session.prompt("read then write");

		expect(asked).toEqual([]);
		expect(toolMessages(stub)).toContain("ORIGINAL");
		expect(toolMessages(stub)).toContain("mcp:fs/write_file");
		expect(readFileSync(join(cwd, "target.txt"), "utf8")).toBe("ORIGINAL\n");
		expect(writeStub.stub.bytesIn).toBe(0);
		expect(writeStub.stub.calls).toEqual([]);
		booted.dispose();
	});
});

describe("PRD-017 AC-5 — subagents and destructive git", () => {
	it("refuses a subagent spawn and git push --force while git status still runs", async () => {
		const stub = await withStub(
			await startStubBackend(
				drive([
					call("subagent", { task: "child work" }),
					call("execute", { command: "git push --force origin main" }),
					call("execute", { command: "git status" }),
				]),
			),
		);
		const { cwd, env } = project({ git: true });
		const sessions: string[] = [];
		seedUserPermissions(env, { defaults: { subagent: "deny", shell: "allow" } });
		const trace = { commands: [] as string[], paths: [] as string[] };
		const booted = await bootGuardedSession({ cwd, baseUrl: stub.baseUrl, env, trace, extraTools: [stubSubagentTool(sessions)] });

		await booted.session.prompt("do the work");

		const messages = toolMessages(stub);
		expect(messages).toContain('scope \\"subagent\\"');
		expect(messages).toContain('scope \\"git_destructive\\"');
		expect(messages).toContain("git_destructive:git push --force origin main");
		expect(sessions).toEqual([]);
		expect(trace.commands).toEqual(["git status"]);
		booted.dispose();
	});
});

describe("PRD-017 AC-11 — edit deny leaves bytes and mtime untouched", () => {
	it("refuses the edit under deny and rewrites the file under allow", async () => {
		const edit = drive([call("edit", { path: "note.txt", edits: [{ oldText: "one", newText: "TWO" }] })]);
		const { cwd, env } = project();
		writeFileSync(join(cwd, "note.txt"), "one\n");
		const before = statSync(join(cwd, "note.txt"));

		const denied = await withStub(await startStubBackend(edit));
		seedUserPermissions(env, { defaults: { edit: "deny" } });
		const first = await bootGuardedSession({ cwd, baseUrl: denied.baseUrl, env });
		await first.session.prompt("edit the note");
		expect(toolMessages(denied)).toContain('scope \\"edit\\"');
		expect(readFileSync(join(cwd, "note.txt"), "utf8")).toBe("one\n");
		expect(statSync(join(cwd, "note.txt")).mtimeMs).toBe(before.mtimeMs);
		first.dispose();

		const allowed = await withStub(await startStubBackend(edit));
		const allowedProject = project();
		writeFileSync(join(allowedProject.cwd, "note.txt"), "one\n");
		seedUserPermissions(allowedProject.env, { defaults: { edit: "allow" } });
		const second = await bootGuardedSession({ cwd: allowedProject.cwd, baseUrl: allowed.baseUrl, env: allowedProject.env });
		await second.session.prompt("edit the note");
		expect(readFileSync(join(allowedProject.cwd, "note.txt"), "utf8")).toBe("TWO\n");
		second.dispose();
	});
});

describe("PRD-017 AC-12 — read deny opens nothing", () => {
	it("refuses the read with zero opens of the target, and returns the contents under allow", async () => {
		const steps = drive([call("read", { path: "inside.txt" })]);

		const deniedProject = project();
		writeFileSync(join(deniedProject.cwd, "inside.txt"), "INSIDE-CONTENT\n");
		seedUserPermissions(deniedProject.env, { defaults: { read: "deny" } });
		const denied = await withStub(await startStubBackend(steps));
		const deniedTrace = { commands: [] as string[], paths: [] as string[] };
		const first = await bootGuardedSession({ cwd: deniedProject.cwd, baseUrl: denied.baseUrl, env: deniedProject.env, trace: deniedTrace });
		await first.session.prompt("read the file");
		expect(toolMessages(denied)).toContain('scope \\"read\\"');
		expect(toolMessages(denied)).not.toContain("INSIDE-CONTENT");
		expect(deniedTrace.paths.filter((path) => path.includes("inside.txt"))).toEqual([]);
		first.dispose();

		const allowedProject = project();
		writeFileSync(join(allowedProject.cwd, "inside.txt"), "INSIDE-CONTENT\n");
		seedUserPermissions(allowedProject.env, { defaults: { read: "allow" } });
		const allowed = await withStub(await startStubBackend(steps));
		const allowedTrace = { commands: [] as string[], paths: [] as string[] };
		const second = await bootGuardedSession({ cwd: allowedProject.cwd, baseUrl: allowed.baseUrl, env: allowedProject.env, trace: allowedTrace });
		await second.session.prompt("read the file");
		expect(toolMessages(allowed)).toContain("INSIDE-CONTENT");
		expect(allowedTrace.paths.filter((path) => path.includes("inside.txt"))).toEqual(["inside.txt"]);
		second.dispose();
	});
});

describe("PRD-017 AC-13 — shell allow cannot buy network access", () => {
	it("refuses the curl naming network, with zero requests reaching the server, while echo still runs", async () => {
		const server = await loopbackServer();
		servers.push(server);
		const stub = await withStub(await startStubBackend(drive([call("execute", { command: `curl ${server.url}` }), call("execute", { command: "echo ok" })])));
		const { cwd, env } = project();
		seedUserPermissions(env, { defaults: { shell: "allow", network: "deny" } });
		const trace = { commands: [] as string[], paths: [] as string[] };
		const booted = await bootGuardedSession({ cwd, baseUrl: stub.baseUrl, env, trace });

		await booted.session.prompt("fetch the url then echo");

		const messages = toolMessages(stub);
		expect(messages).toContain('scope \\"network\\"');
		expect(messages).toContain(`network:curl ${server.url}`);
		expect(server.requests).toEqual([]);
		expect(trace.commands).toEqual(["echo ok"]);
		booted.dispose();
	});
});

describe("PRD-017 AC-14 — external_dir deny covers escaping paths and symlinks", () => {
	it("refuses an out-of-root path and a symlink to it, while an in-root read succeeds", async () => {
		const parent = tempDir("leanpi-perm-parent-");
		const cwd = join(parent, "session-root");
		const outside = join(parent, "outside");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET\n");
		writeFileSync(join(cwd, "inside.txt"), "INSIDE-CONTENT\n");
		symlinkSync(join(outside, "secret.txt"), join(cwd, "link.txt"));

		const stub = await withStub(
			await startStubBackend(drive([call("read", { path: "../outside/secret.txt" }), call("read", { path: "link.txt" }), call("read", { path: "inside.txt" })])),
		);
		writeConfig(cwd, { backends: { stub: nativeBackend("http://127.0.0.1:1/v1") }, models: { balanced: { backend: "stub", model: STUB_MODEL } } });
		const env = { XDG_CONFIG_HOME: tempDir("leanpi-perm-xdg-") };
		seedUserPermissions(env, { defaults: { shell: "allow" } });
		const trace = { commands: [] as string[], paths: [] as string[] };
		const booted = await bootGuardedSession({ cwd, baseUrl: stub.baseUrl, env, trace });

		await booted.session.prompt("read three paths");

		const messages = toolMessages(stub);
		expect(messages).toContain('scope \\"external_dir\\"');
		expect(messages).not.toContain("OUTSIDE-SECRET");
		expect(messages).toContain("INSIDE-CONTENT");
		expect(trace.paths.filter((path) => path.includes("secret.txt") || path.includes("link.txt"))).toEqual([]);
		expect(trace.paths).toContain("inside.txt");
		booted.dispose();
	});
});

describe("PRD-017 AC-15 — package_install deny", () => {
	it("refuses npm install with zero spawns while npm test spawns and runs", async () => {
		const stub = await withStub(await startStubBackend(drive([call("execute", { command: "npm install evil-pkg" }), call("execute", { command: "npm test" })])));
		const { cwd, env } = project();
		writeFileSync(
			join(cwd, "package.json"),
			JSON.stringify({ name: "leanpi-permission-fixture", version: "1.0.0", scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'yes\')"' } }),
		);
		seedUserPermissions(env, { defaults: { shell: "allow", package_install: "deny" } });
		const trace = { commands: [] as string[], paths: [] as string[] };
		const booted = await bootGuardedSession({ cwd, baseUrl: stub.baseUrl, env, trace });

		await booted.session.prompt("install then test");

		const messages = toolMessages(stub);
		expect(messages).toContain('scope \\"package_install\\"');
		expect(messages).toContain("package_install:npm install evil-pkg");
		expect(trace.commands).toEqual(["npm test"]);
		expect(existsSync(join(cwd, "node_modules"))).toBe(false);
		expect(readFileSync(join(cwd, "ran.txt"), "utf8")).toBe("yes");
		booted.dispose();
	}, 30_000);
});

describe("PRD-017 — bypass control", () => {
	it("a session without the guard executes what shell: deny would have refused", async () => {
		const stub = await withStub(await startStubBackend(drive([call("execute", { command: "touch bypass-marker.txt" })])));
		const { cwd, env } = project();
		seedUserPermissions(env, { defaults: { shell: "deny" } });
		const trace = { commands: [] as string[], paths: [] as string[] };
		const booted = await bootGuardedSession({ cwd, baseUrl: stub.baseUrl, env, trace, installGuard: false });

		await booted.session.prompt("create the marker");

		expect(toolMessages(stub)).not.toContain("refused");
		expect(trace.commands).toEqual(["touch bypass-marker.txt"]);
		expect(existsSync(join(cwd, "bypass-marker.txt"))).toBe(true);
		booted.dispose();
	});
});

describe("PRD-017 — the ask path itself", () => {
	it("denies instead of prompting when there is no interactive UI", async () => {
		const stub = await withStub(await startStubBackend(drive([call("execute", { command: "touch no-ui.txt" })])));
		const { cwd, env } = project();
		const trace = { commands: [] as string[], paths: [] as string[] };
		// `shell` stays at its built-in `ask`, and the harness binds no UI context.
		const booted = await bootGuardedSession({ cwd, baseUrl: stub.baseUrl, env, trace });

		await booted.session.prompt("create the marker");

		expect(toolMessages(stub)).toContain("the user declined the confirmation prompt");
		expect(trace.commands).toEqual([]);
		expect(existsSync(join(cwd, "no-ui.txt"))).toBe(false);
		booted.dispose();
	});

	it("prompts once for the whole scope set and names every scope it covers", async () => {
		const server = await loopbackServer();
		servers.push(server);
		const stub = await withStub(await startStubBackend(drive([call("execute", { command: `curl ${server.url}` })])));
		const { cwd, env } = project();
		// Both scopes implicate the call and both are `ask`: one prompt, not two.
		seedUserPermissions(env, { defaults: { shell: "ask", network: "ask" } });
		const trace = { commands: [] as string[], paths: [] as string[] };
		const questions: GuardQuestion[] = [];
		const booted = await bootGuardedSession({
			cwd,
			baseUrl: stub.baseUrl,
			env,
			trace,
			confirm: (question) => {
				questions.push(question);
				return true;
			},
		});

		await booted.session.prompt("fetch the url");

		expect(questions).toHaveLength(1);
		expect([...questions[0]!.scopes].sort()).toEqual(["network", "shell"]);
		expect(trace.commands).toEqual([`curl ${server.url}`]);
		expect(server.requests).toEqual(["GET /"]);
		booted.dispose();
	});
});
