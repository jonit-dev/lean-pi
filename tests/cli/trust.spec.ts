/**
 * `leanpi trust [dir]`: the non-interactive `/permissions trust project`, for a
 * tool that creates a project and then drives `leanpi -p` in it. It writes the
 * same trust record to the same `XDG_CONFIG_HOME` state and starts no session.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertTrusted } from "../../src/permissions/trust.js";
import { tempDir } from "../helpers/fixtures.js";

const BIN = join(process.cwd(), "bin", "leanpi.js");

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	return spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, ...env, NO_COLOR: "1" }, encoding: "utf8", timeout: 30_000 });
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
