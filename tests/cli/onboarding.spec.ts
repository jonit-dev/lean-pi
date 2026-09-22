/**
 * PRD-039 — first-run onboarding.
 *
 * One question, asked once, at the only moment where the answer still changes
 * what gets written: before `autoConfigure` allocates the role map, because
 * that map is never recomputed. The property that matters most is the one the
 * prompt must *not* have — it must never appear where no person is watching,
 * or CI and every piped `--print` run hang forever.
 *
 * The flow is tested through injected streams so it needs no pty, and the gate
 * is tested through the real binary so it is proved on the consumer path rather
 * than on the predicate alone.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoConfigure, jevWarning, requireJev, startupBanner } from "../../src/cli/bootstrap.js";
import { runOnboarding, shouldOnboard } from "../../src/cli/onboarding.js";
import { credentialsPath, readStoredKey } from "../../src/jev/credentials.js";
import { createJevClient, type JevClient } from "../../src/jev/client.js";
import type { LeanPiConfig } from "../../src/core/types.js";
import { startStubJev, type StubJev } from "../helpers/stub-jev.js";

const KEY = "jev-live-3f9c1a7e-onboarding";
const BIN = join(process.cwd(), "bin", "leanpi.js");
const PACKAGE_ROOT = process.cwd();

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** A writable that keeps what was written, so a leak is assertable. */
class Capture extends Writable {
	text = "";
	_write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void): void {
		this.text += String(chunk);
		done();
	}
}

/** A fake terminal pair: the answer is typed once the prompt has been drawn. */
function fakeTerminal(answer: string): { input: PassThrough; output: Capture } {
	const input = new PassThrough();
	const output = new Capture();
	// `question()` attaches its listeners synchronously; the write lands on the
	// next tick, after the prompt, exactly as a person would type it.
	setTimeout(() => input.write(`${answer}\n`), 5);
	return { input, output };
}

/** Every file under `root` whose bytes contain `needle`. */
function filesContaining(root: string, needle: string): string[] {
	const found: string[] = [];
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (readFileSync(path, "utf8").includes(needle)) found.push(path);
		}
	};
	walk(root);
	return found.sort();
}

/**
 * A machine with a signed-in Claude Code CLI and nothing else: enough for
 * `autoConfigure` to have a model to allocate over.
 */
function claudeMachine(): { cwd: string; home: string; env: NodeJS.ProcessEnv } {
	const root = tempDir("leanpi-onboarding-machine-");
	const home = join(root, "home");
	const bin = join(root, "bin");
	const cwd = join(root, "project");
	for (const dir of [home, bin, cwd]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(bin, "claude"), `#!/bin/sh\necho '{"loggedIn": true}'\n`, { mode: 0o755 });
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(join(home, ".claude", ".credentials.json"), "{}\n");
	writeFileSync(join(home, ".claude.json"), JSON.stringify({ model: "opus" }));
	return { cwd, home, env: { HOME: home, PATH: bin, XDG_CONFIG_HOME: join(home, ".config") } };
}

describe("PRD-039 first-run onboarding", () => {
	let stub: StubJev;
	let cwd: string;
	let home: string;
	let env: NodeJS.ProcessEnv;

	beforeEach(async () => {
		stub = await startStubJev();
		cwd = tempDir("leanpi-onboarding-cwd-");
		home = tempDir("leanpi-onboarding-home-");
		env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
	});

	afterEach(async () => {
		await stub.close();
	});

	/** The client the launcher builds for a first run, pointed at the stub. */
	function stubClient(target: { cwd: string; env: NodeJS.ProcessEnv } = { cwd, env }): JevClient {
		return createJevClient({
			config: { jev: { mode: "enabled", apiKey: null } } as unknown as LeanPiConfig,
			cwd: target.cwd,
			env: target.env,
			endpoint: stub.url,
		});
	}

	it("AC-1 / AC-6: stores a pasted key at 0600, never echoes it, and the banner names the credential store", async () => {
		const { input, output } = fakeTerminal(KEY);

		const result = await runOnboarding({ cwd, env, home, input, output, client: stubClient() });

		expect(result.stored).toBe(true);
		const path = credentialsPath(env);
		expect(existsSync(path)).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readStoredKey(env)).toBe(KEY);

		// AC-6: the value — and every fragment long enough to recognise it — is
		// nowhere on the terminal.
		expect(output.text).toContain("JEV API key:");
		expect(output.text).not.toContain(KEY);
		expect(output.text).not.toContain(KEY.slice(0, 12));
		expect(output.text).not.toContain(KEY.slice(-12));

		// Exactly one validation attempt, carrying the key that was typed.
		expect(stub.requests).toHaveLength(1);
		expect(stub.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);

		// The credential store is the only file onboarding wrote.
		expect(readdirSync(join(env.XDG_CONFIG_HOME as string, "leanpi"))).toEqual(["credentials.json"]);

		// The startup banner reads the source the session itself will read.
		const jev = requireJev({ cwd, env, home });
		expect(jev.source).toBe("configured (source: credential store)");
		expect(startupBanner({} as LeanPiConfig, jev)).toContain("JEV on (credential store)");
	});

	it("AC-2: the accepted key decides the role map the same run writes", async () => {
		const machine = claudeMachine();
		const client = stubClient(machine);
		const { input, output } = fakeTerminal(KEY);
		await runOnboarding({ ...machine, input, output, client });

		// The same client the launcher dials with, as `bin/leanpi.js` does, now
		// finds the key in the store and allocates through JEV.
		const configured = await autoConfigure({ ...machine, client, piReady: () => false });

		expect(configured.outcome).toBe("written");
		const written = readFileSync(configured.path, "utf8");
		expect(written).toContain("Roles allocated by JEV");
		expect(written).not.toContain("fallback ladder");
		// The allocation request carried the key from the store, not the ladder.
		expect(stub.requests.at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
		// AC-6: the key is in the credential store and in no other file.
		expect(filesContaining(machine.home, KEY)).toEqual([credentialsPath(machine.env)]);
	});

	it("AC-3: Enter starts the session anyway — no key stored, the existing warning prints", async () => {
		const machine = claudeMachine();
		const { input, output } = fakeTerminal("");

		const result = await runOnboarding({ ...machine, input, output, client: stubClient(machine) });

		expect(result.stored).toBe(false);
		expect(existsSync(credentialsPath(machine.env))).toBe(false);
		expect(stub.requests).toHaveLength(0);

		// A config is still written, and the run is told what it is running.
		const configured = await autoConfigure({ ...machine, client: stubClient(machine), piReady: () => false });
		expect(configured.outcome).toBe("written");
		const jev = requireJev(machine);
		expect(jev.source).toBe("not configured");
		expect(jevWarning(jev.source)).toHaveLength(3);
	});

	it("AC-4: a rejected key prints the provider's reason once, stores nothing, and still starts", async () => {
		await stub.close();
		stub = await startStubJev([() => ({ status: 401 })]);
		const { input, output } = fakeTerminal(KEY);

		const result = await runOnboarding({ cwd, env, home, input, output, client: stubClient() });

		expect(result.stored).toBe(false);
		expect(existsSync(credentialsPath(env))).toBe(false);
		// One attempt: no retry loop, and the provider's own words, once.
		expect(stub.requests).toHaveLength(1);
		expect(output.text).toContain("JEV key rejected");
		expect(output.text).toContain("401");
		expect(output.text.split("JEV key rejected")).toHaveLength(2);
		expect(output.text).not.toContain(KEY);
		// The key is optional, so a typo does not refuse the session.
		expect(requireJev({ cwd, env, home }).source).toBe("not configured");
	});

	it("AC-5: asks only when the question is genuinely open", () => {
		const open = { cwd, env, home, flags: {}, interactive: true };
		expect(shouldOnboard(open)).toBe(true);

		// A person, or not.
		expect(shouldOnboard({ ...open, interactive: false })).toBe(false);
		// The flags that are themselves answers.
		expect(shouldOnboard({ ...open, flags: { jevKey: "typed-on-the-command-line" } })).toBe(false);
		expect(shouldOnboard({ ...open, flags: { allowMissingJev: true } })).toBe(false);
		// `$JEV_API_KEY` — one of the four sources the session itself resolves.
		expect(shouldOnboard({ ...open, env: { ...env, JEV_API_KEY: "from-the-shell" } })).toBe(false);
		// The project's `.env` — the fourth.
		writeFileSync(join(cwd, ".env"), "JEV_API_KEY=from-the-file\n");
		expect(shouldOnboard(open)).toBe(false);

		// `jev.mode: disabled` is a deliberate opt-out, on a project of its own.
		const disabled = { cwd: tempDir("leanpi-onboarding-disabled-"), env, home, flags: {}, interactive: true };
		writeFileSync(
			join(disabled.cwd, "leanpi.config.yaml"),
			[
				"backends:",
				"  local:",
				"    type: native",
				"    baseUrl: http://127.0.0.1:1/v1",
				"models:",
				"  quick:",
				"    backend: local",
				"    model: m",
				"jev:",
				"  mode: disabled",
				"",
			].join("\n"),
		);
		expect(requireJev(disabled).source).toBe("disabled (jev.mode)");
		expect(shouldOnboard(disabled)).toBe(false);

		// Any existing config is a machine that has already had its chance to answer.
		const existing = { cwd: tempDir("leanpi-onboarding-existing-"), env, home, flags: {}, interactive: true };
		writeFileSync(join(existing.cwd, "leanpi.config.yaml"), "jev:\n  mode: enabled\n");
		expect(shouldOnboard(existing)).toBe(false);
	});

	it("AC-5: the real binary never prompts where no person is attached", () => {
		const isolated = {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			PATH: join(tempDir("leanpi-onboarding-emptybin-"), "bin"),
			NO_COLOR: "1",
			FORCE_COLOR: "0",
		};

		// Piped stdin with no config: the gate must not wait for a person. A hang
		// here fails as a timeout, which is the failure this test exists for. The
		// exit status proves the run got all the way past onboarding to the
		// readiness block rather than merely dying early.
		const piped = spawnSync(process.execPath, [BIN], { cwd, env: isolated, input: "", encoding: "utf8", timeout: 20_000 });
		expect(piped.error).toBeUndefined();
		expect(`${piped.stdout}${piped.stderr}`).not.toContain("JEV API key");
		expect(piped.status).toBe(1);
		expect(piped.stderr).toContain("nothing on this machine can run a turn yet");

		// `--help`/`--version` print and exit, through Pi, with no prompt on the way.
		for (const flag of ["--help", "--version"]) {
			const info = spawnSync(process.execPath, [BIN, flag], {
				cwd,
				env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), NO_COLOR: "1", FORCE_COLOR: "0" },
				encoding: "utf8",
				timeout: 30_000,
			});
			expect(info.error).toBeUndefined();
			expect(`${info.stdout}${info.stderr}`).not.toContain("JEV API key");
		}
	});
});

// Keep the imported helper honest: the spec's own root must be the package.
expect(existsSync(join(PACKAGE_ROOT, "src", "cli", "onboarding.ts"))).toBe(true);
