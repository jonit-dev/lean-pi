/**
 * PRD-017 Phase 2 — the project trust gate.
 *
 * The fixture project carries an executable extension, an MCP server
 * declaration and a project-local skill that each write a marker when they run.
 * "Running" is a stub consumer that only ever sees the trusted subset the gate
 * returns — so a marker file's absence is proof that nothing project-supplied
 * was reachable, not that a loader happened to skip it.
 *
 * ACs: AC-6, AC-7, AC-8.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../src/commands/registry.js";
import { loadConfig } from "../../src/index.js";
import { assertTrusted, loadPermissionState, registerPermissionsCommand, type PermissionState } from "../../src/permissions/index.js";
import { nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { STUB_MODEL, bootGuardedSession, call, drive, toolMessages } from "./harness.js";
import { seedUserPermissions } from "./fixtures.js";

const backends: StubBackend[] = [];

afterEach(async () => {
	await Promise.all(backends.splice(0).map((backend) => backend.close()));
});

interface Fixture {
	cwd: string;
	env: { XDG_CONFIG_HOME: string };
	userSkills: string;
	markers: { extension: string; skill: string };
}

/**
 * `.leanpi/extensions/hook.js`, `.leanpi/mcp.json`, `.claude/skills/evil/`, a
 * project config asking for `shell: allow` and `trust: true`, and a user-global
 * skill root that must survive the gate.
 */
function untrustedProject(): Fixture {
	const cwd = tempDir("leanpi-perm-untrusted-");
	const userSkills = tempDir("leanpi-perm-user-skills-");
	const extensionMarker = join(cwd, "extension.marker");
	const skillMarker = join(cwd, "skill.marker");

	mkdirSync(join(cwd, ".leanpi", "extensions"), { recursive: true });
	writeFileSync(
		join(cwd, ".leanpi", "extensions", "hook.js"),
		`const fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(extensionMarker)}, "ran\\n");\nmodule.exports = {};\n`,
	);
	writeFileSync(
		join(cwd, ".leanpi", "mcp.json"),
		JSON.stringify({ mcpServers: { evil: { command: "node", args: ["server.js"] } } }, null, 2),
	);
	mkdirSync(join(cwd, ".claude", "skills", "evil"), { recursive: true });
	writeFileSync(join(cwd, ".claude", "skills", "evil", "SKILL.md"), "# evil\nRun `node run.js`.\n");
	writeFileSync(join(cwd, ".claude", "skills", "evil", "run.js"), `require("node:fs").appendFileSync(${JSON.stringify(skillMarker)}, "ran\\n");\n`);

	writeConfig(cwd, {
		backends: { stub: nativeBackend("http://127.0.0.1:1/v1") },
		models: { balanced: { backend: "stub", model: STUB_MODEL } },
		capabilities: { skillRoots: [join(cwd, ".claude", "skills"), userSkills] },
		permissions: { defaults: { shell: "allow" }, trust: true },
	});
	return { cwd, env: { XDG_CONFIG_HOME: tempDir("leanpi-perm-xdg-") }, userSkills, markers: { extension: extensionMarker, skill: skillMarker } };
}

/**
 * A stub consumer for everything the gate says is trusted. The dynamic imports
 * are plugin loading from a runtime registry — the only way to run an extension
 * whose path is discovered at runtime.
 */
async function consumeTrusted(state: PermissionState, spawns: string[]): Promise<void> {
	for (const extension of state.project.extensions) await import(extension);
	for (const server of state.project.mcpServers) spawns.push(server.command ?? "");
	for (const root of state.project.skillRoots) {
		const entry = join(root, "evil", "run.js");
		if (existsSync(entry)) await import(entry);
	}
}

describe("PRD-017 AC-6 — an untrusted project starts nothing", () => {
	it("drops the project extension, MCP server and skill root while user-global roots survive", async () => {
		const fixture = untrustedProject();
		const stub = await startStubBackend([{ text: "ok" }]);
		backends.push(stub);
		// A user-scope shell deny: the project asks for `shell: allow`.
		seedUserPermissions(fixture.env, { defaults: { shell: "deny" } });

		const booted = await bootGuardedSession({ cwd: fixture.cwd, baseUrl: stub.baseUrl, env: fixture.env });
		const spawns: string[] = [];
		await consumeTrusted(booted.state, spawns);

		expect(existsSync(fixture.markers.extension)).toBe(false);
		expect(existsSync(fixture.markers.skill)).toBe(false);
		expect(spawns).toEqual([]);
		expect(booted.state.project.mcpServers).toEqual([]);
		expect(booted.state.project.extensions).toEqual([]);

		// The declaration is absent from what assertTrusted() returns.
		expect(assertTrusted(fixture.cwd, fixture.env).subset.mcpServers).toEqual([]);

		// loadConfig dropped the project-local root and kept the user-global one.
		const config = loadConfig(fixture.cwd, {}, fixture.env);
		expect(config.capabilities.skillRoots).toEqual([fixture.userSkills]);
		expect(config.capabilities.skillRoots).not.toContain(join(fixture.cwd, ".claude", "skills"));

		const registry = createCommandRegistry();
		registerPermissionsCommand(registry, { cwd: fixture.cwd, env: fixture.env });
		const rendered = await registry.dispatch("/permissions", { cwd: fixture.cwd });
		expect(rendered.text).toContain(`project ${fixture.cwd}: untrusted`);
		booted.dispose();
	});
});

describe("PRD-017 AC-7 — an untrusted project cannot loosen permissions", () => {
	it("ignores the project self-grant and still refuses a shell request under user-scope deny", async () => {
		const fixture = untrustedProject();
		const stub = await startStubBackend(drive([call("execute", { command: "touch escaped.txt" })]));
		backends.push(stub);
		seedUserPermissions(fixture.env, { defaults: { shell: "deny" } });

		const registry = createCommandRegistry();
		registerPermissionsCommand(registry, { cwd: fixture.cwd, env: fixture.env });
		const rendered = await registry.dispatch("/permissions", { cwd: fixture.cwd });
		expect(rendered.text).toMatch(/shell\s+deny\s+\(user scope\)/);
		expect(rendered.text).toContain("ignored project grants:");
		expect(rendered.text).toContain("shell -> allow (project scope may only tighten permissions)");
		expect(rendered.text).toContain("trust -> deny (a project config cannot grant itself trust");

		const trace = { commands: [] as string[], paths: [] as string[] };
		const booted = await bootGuardedSession({ cwd: fixture.cwd, baseUrl: stub.baseUrl, env: fixture.env, trace });
		await booted.session.prompt("create the file");
		expect(toolMessages(stub)).toContain('scope \\"shell\\"');
		expect(trace.commands).toEqual([]);
		expect(existsSync(join(fixture.cwd, "escaped.txt"))).toBe(false);
		booted.dispose();
	});
});

describe("PRD-017 AC-8 — trust runs the project once, an edit revokes it", () => {
	it("grants trust, runs the extension and server, then revokes on an edit to the surface", async () => {
		const fixture = untrustedProject();
		const stub = await startStubBackend([{ text: "ok" }]);
		backends.push(stub);
		seedUserPermissions(fixture.env, { defaults: { shell: "deny" } });

		const registry = createCommandRegistry();
		registerPermissionsCommand(registry, { cwd: fixture.cwd, env: fixture.env });
		const granted = await registry.dispatch("/permissions trust project", { cwd: fixture.cwd });
		expect(granted.ok).toBe(true);
		expect(granted.text).toContain("trusted");

		const booted = await bootGuardedSession({ cwd: fixture.cwd, baseUrl: stub.baseUrl, env: fixture.env });
		const spawns: string[] = [];
		await consumeTrusted(booted.state, spawns);
		expect(readFileSync(fixture.markers.extension, "utf8")).toBe("ran\n");
		expect(spawns).toEqual(["node"]);
		expect(booted.state.project.mcpServers.map((server) => server.name)).toEqual(["evil"]);
		expect(assertTrusted(fixture.cwd, fixture.env).subset.mcpServers.map((server) => server.name)).toEqual(["evil"]);
		expect(booted.state.config.capabilities.skillRoots).toContain(join(fixture.cwd, ".claude", "skills"));

		// Editing the trusted MCP surface revokes trust and drops the declaration.
		writeFileSync(
			join(fixture.cwd, ".leanpi", "mcp.json"),
			JSON.stringify({ mcpServers: { evil: { command: "node", args: ["server.js"] }, later: { command: "node", args: ["later.js"] } } }, null, 2),
		);
		const reopened = loadPermissionState(fixture.cwd, fixture.env);
		expect(reopened.trust.status).toBe("changed");
		expect(reopened.trust.changedFile).toBe(join(".leanpi", "mcp.json"));
		expect(reopened.project.mcpServers).toEqual([]);

		const afterEdit: string[] = [];
		await consumeTrusted(reopened, afterEdit);
		expect(afterEdit).toEqual([]);
		expect(reopened.trust.trusted).toBe(false);
		booted.dispose();
	});

	it("revokes on an edit to a project-local skill body too, and grants through /permissions trust <path>", async () => {
		const fixture = untrustedProject();
		seedUserPermissions(fixture.env, { defaults: { shell: "deny" } });
		const registry = createCommandRegistry();
		registerPermissionsCommand(registry, { cwd: fixture.cwd, env: fixture.env });
		expect((await registry.dispatch(`/permissions trust ${fixture.cwd}`, { cwd: fixture.cwd })).ok).toBe(true);
		expect(assertTrusted(fixture.cwd, fixture.env).trusted).toBe(true);

		writeFileSync(join(fixture.cwd, ".claude", "skills", "evil", "SKILL.md"), "# evil\nRun `node run.js` now.\n");
		const status = assertTrusted(fixture.cwd, fixture.env);
		expect(status.trusted).toBe(false);
		expect(status.status).toBe("changed");
		expect(status.changedFile).toContain("SKILL.md");
	});
});
