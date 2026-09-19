/**
 * PRD-017 Phase 3 — secret containment.
 *
 * The seeded secrets are genuinely in the parent process environment, so the
 * child-environment assertion is a real absence rather than an empty
 * environment: the child prints `PATH` and a configured passthrough name, and
 * names neither seeded secret at all (a redacted *value* would still print the
 * variable name, so the name assertion is the strong one).
 *
 * ACs: AC-9, AC-10.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { STUB_MODEL, bootGuardedSession, call, drive, toolMessages } from "./harness.js";
import { seedUserPermissions } from "./fixtures.js";

const TOKEN = "tok_live_9f3a2c41d8";
const VENDOR_KEY = "sk-ant-api03-LEAKCANARY";
const PASSTHROUGH = "LEANPI_TEST_PASSTHROUGH";

const backends: StubBackend[] = [];

afterEach(async () => {
	await Promise.all(backends.splice(0).map((backend) => backend.close()));
	delete process.env.TEST_API_TOKEN;
	delete process.env.ANTHROPIC_API_KEY;
	delete process.env[PASSTHROUGH];
});

function seededEnv(): { cwd: string; env: NodeJS.ProcessEnv } {
	process.env.TEST_API_TOKEN = TOKEN;
	process.env.ANTHROPIC_API_KEY = VENDOR_KEY;
	process.env[PASSTHROUGH] = "visible";

	const cwd = tempDir("leanpi-perm-secrets-");
	writeConfig(cwd, { backends: { stub: nativeBackend("http://127.0.0.1:1/v1") }, models: { balanced: { backend: "stub", model: STUB_MODEL } } });
	return { cwd, env: { ...process.env, XDG_CONFIG_HOME: tempDir("leanpi-perm-xdg-") } };
}

describe("PRD-017 AC-9 — a secret value never reaches the executor", () => {
	it("replaces the token in the tool output and in what the artifact store receives", async () => {
		const { cwd, env } = seededEnv();
		seedUserPermissions(env, { defaults: { shell: "allow" } });
		const stub = await startStubBackend(drive([call("execute", { command: `echo before ${TOKEN} after` })]));
		backends.push(stub);
		const artifacts: string[] = [];
		const booted = await bootGuardedSession({ cwd, baseUrl: stub.baseUrl, env, onOutput: (text) => artifacts.push(text) });

		await booted.session.prompt("print the token");

		const messages = toolMessages(stub);
		expect(messages).not.toContain(TOKEN);
		expect(messages).toContain("«redacted:TEST_API_TOKEN»");
		// The surrounding output is preserved byte for byte: the redaction is not an over-redaction.
		expect(messages).toContain("before «redacted:TEST_API_TOKEN» after");
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0]).toContain("before «redacted:TEST_API_TOKEN» after");
		expect(artifacts[0]).not.toContain(TOKEN);
		booted.dispose();
	});

	it("catches a secret echoed by an unrelated command, by value", async () => {
		const { cwd, env } = seededEnv();
		seedUserPermissions(env, { defaults: { shell: "allow" } });
		writeFileSync(join(cwd, "notes.txt"), `note: ${VENDOR_KEY}\n`);
		const stub = await startStubBackend(drive([call("execute", { command: "cat notes.txt" })]));
		backends.push(stub);
		const booted = await bootGuardedSession({ cwd, baseUrl: stub.baseUrl, env });

		await booted.session.prompt("show the notes");

		const messages = toolMessages(stub);
		expect(messages).not.toContain(VENDOR_KEY);
		expect(messages).toContain("«redacted:ANTHROPIC_API_KEY»");
		booted.dispose();
	});
});

describe("PRD-017 AC-10 — a spawned child gets the allowlisted environment", () => {
	it("shows PATH and the configured passthrough name, and neither seeded secret", async () => {
		const { cwd, env } = seededEnv();
		seedUserPermissions(env, { defaults: { shell: "allow" }, secrets: { passthrough: [PASSTHROUGH] } });
		const stub = await startStubBackend(drive([call("execute", { command: "env" })]));
		backends.push(stub);
		const trace = { commands: [] as string[], paths: [] as string[] };
		const booted = await bootGuardedSession({ cwd, baseUrl: stub.baseUrl, env, trace });

		await booted.session.prompt("print the environment");

		expect(trace.commands).toEqual(["env"]);
		const messages = toolMessages(stub);
		expect(messages).toContain("PATH=");
		expect(messages).toContain(`${PASSTHROUGH}=visible`);
		expect(messages).not.toContain("ANTHROPIC_API_KEY");
		expect(messages).not.toContain("TEST_API_TOKEN");
		expect(messages).not.toContain(VENDOR_KEY);
		booted.dispose();
	});

	it("keeps a vendor credential out of the child even when it is in the parent environment", () => {
		// Control for the assertion above: the parent really does hold both values.
		seededEnv();
		expect(process.env.ANTHROPIC_API_KEY).toBe(VENDOR_KEY);
		expect(process.env.TEST_API_TOKEN).toBe(TOKEN);
	});
});
