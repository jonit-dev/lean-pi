/**
 * `leanpi trust [dir]`: the non-interactive `/permissions trust project`, for a
 * tool that creates a project and then drives `leanpi -p` in it. It writes the
 * same trust record to the same `XDG_CONFIG_HOME` state and starts no session.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { buildCatalog } from "../../src/mcp/catalog.js";
import { assertTrusted } from "../../src/permissions/trust.js";
import { nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";

const BIN = join(process.cwd(), "bin", "leanpi.js");

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	// FORCE_COLOR beside NO_COLOR makes Node warn on stderr, so a FORCE_COLOR=1 shell failed the empty-stderr check.
	const { FORCE_COLOR: _forceColor, ...base } = process.env;
	return spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...base, ...env, NO_COLOR: "1" }, encoding: "utf8", timeout: 30_000 });
}

describe("leanpi trust [dir]", () => {
	it("trusts the named project, prints its root and exits 0 without a session", () => {
		const project = tempDir("leanpi-trust-project-");
		writeFileSync(join(project, ".mcp.json"), `${JSON.stringify({ mcpServers: { stub: { command: "node", args: ["server.mjs"] } } })}\n`);
		const home = tempDir("leanpi-trust-home-");
		const env = { HOME: home, XDG_CONFIG_HOME: join(home, "xdg") };
		expect(assertTrusted(project, env).trusted).toBe(false);

		const result = run(["trust", project], tempDir("leanpi-trust-elsewhere-"), env);

		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe(project);
		expect(assertTrusted(project, env).trusted).toBe(true);
	});

	it("defaults to the current directory", () => {
		const project = tempDir("leanpi-trust-cwd-");
		const home = tempDir("leanpi-trust-home-");
		const env = { HOME: home, XDG_CONFIG_HOME: join(home, "xdg") };

		const result = run(["trust"], project, env);

		expect(result.status).toBe(0);
		expect(assertTrusted(project, env).trusted).toBe(true);
	});

	it("an edit to `.mcp.json` revokes trust, so its new server is not discovered until trust is granted again", () => {
		const project = tempDir("leanpi-trust-mcp-");
		const home = tempDir("leanpi-trust-home-");
		const env = { HOME: home, XDG_CONFIG_HOME: join(home, "xdg") };
		writeConfig(project, { backends: { local: nativeBackend("http://127.0.0.1:9/v1") }, models: { balanced: { backend: "local", model: "m" } } });
		const servers = (names: string[]) => `${JSON.stringify({ mcpServers: Object.fromEntries(names.map((name) => [name, { command: "node", args: [`${name}.mjs`] }])) })}\n`;
		writeFileSync(join(project, ".mcp.json"), servers(["engine"]));
		const projectServers = () => buildCatalog({ cwd: project, config: loadConfig(project, {}, env), home }).entries.filter((entry) => entry.scope === "project").map((entry) => entry.name);
		expect(run(["trust", project], project, env).status).toBe(0);
		expect(projectServers()).toEqual(["engine"]);

		writeFileSync(join(project, ".mcp.json"), servers(["engine", "added"]));

		expect(loadConfig(project, {}, env).permissions.trust.trusted).toBe(false);
		expect(projectServers()).toEqual([]);
		expect(run(["trust", project], project, env).status).toBe(0);
		expect(projectServers()).toEqual(["added", "engine"]);
	});

	it("refuses a directory that does not exist, with the reason, and trusts nothing", () => {
		const home = tempDir("leanpi-trust-home-");
		const env = { HOME: home, XDG_CONFIG_HOME: join(home, "xdg") };
		const missing = join(tempDir("leanpi-trust-parent-"), "missing");

		const result = run(["trust", missing], home, env);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("not a directory");
		expect(assertTrusted(missing, env).trusted).toBe(false);
	});
});
