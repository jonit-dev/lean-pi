/**
 * PRD-022 runtime/isolation config wiring — the knobs the parser used to drop.
 *
 * `verify.runtime`, `limits.isolation`, `limits.max_escalations` and
 * `workspace.worktreeRoot` are read from a real `leanpi.config.yaml`, so a typo
 * fails session start with a named error rather than silently resolving a turn
 * to a facility that does not exist.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/core/config.js";
import { grantTrust } from "../../src/permissions/index.js";
import { worktreeRootOf } from "../../src/runtime/index.js";
import { tempDir, writeConfig } from "../helpers/fixtures.js";

const BASE = {
	backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
	models: { quick: { backend: "local", model: "m" } },
};

function fromFile(extra: Record<string, unknown>): ReturnType<typeof loadConfig> {
	const cwd = tempDir("leanpi-config-wiring-");
	const env = { XDG_CONFIG_HOME: tempDir("leanpi-config-xdg-") };
	writeConfig(cwd, { ...BASE, ...extra });
	// The project declares an executable surface (runtime commands), so trust is
	// what lets the loader carry it; untrusted behaviour is asserted separately.
	grantTrust(cwd, env);
	return loadConfig(cwd, {}, env);
}

describe("PRD-022 — verify.runtime is parsed and validated", () => {
	it("carries a valid runtime block through loadConfig", () => {
		const config = fromFile({
			verify: {
				commands: { typecheck: "true" },
				runtime: {
					smoke: { command: "node server.js", ready: { log: "listening", port: 4321 }, timeoutMs: 1000 },
					cli: { command: "my-cli", expect: { exitCode: 0, stdoutContains: ["ok"] } },
					browser: { url: "http://127.0.0.1:1/", selectors: ["#app"] },
				},
			},
		});
		expect(config.verify?.runtime).toEqual({
			smoke: { command: "node server.js", ready: { log: "listening", port: 4321 }, timeoutMs: 1000 },
			cli: { command: "my-cli", expect: { exitCode: 0, stdoutContains: ["ok"] } },
			browser: { url: "http://127.0.0.1:1/", selectors: ["#app"] },
		});
	});

	it("fails load with a named error on a malformed field", () => {
		expect(() => fromFile({ verify: { runtime: { smoke: { ready: { port: "not-a-port" } } } } })).toThrow("verify.runtime.smoke.ready.port");
		expect(() => fromFile({ verify: { runtime: { smoke: [] } } })).toThrow("verify.runtime.smoke");
		expect(() => fromFile({ verify: { runtime: "yes" } })).toThrow("verify.runtime");
	});

	it("drops the whole runtime block for an untrusted project, like its commands", () => {
		const cwd = tempDir("leanpi-config-runtime-untrusted-");
		writeConfig(cwd, { ...BASE, verify: { runtime: { cli: { command: "touch /tmp/pwned", expect: { exitCode: 0 } } } } });
		expect(loadConfig(cwd, {}, { XDG_CONFIG_HOME: tempDir("leanpi-config-xdg-") }).verify?.runtime).toBeUndefined();
	});
});

describe("PRD-040 A — a declared runtime check is never silently dropped", () => {
	it("rejects an empty or unknown-key block instead of compiling no check", () => {
		expect(() => fromFile({ verify: { runtime: { smoke: {} } } })).toThrow("verify.runtime.smoke");
		expect(() => fromFile({ verify: { runtime: { cli: { bogus: 1 } } } })).toThrow("verify.runtime.cli.bogus");
		expect(() => fromFile({ verify: { runtime: { bogus: {} } } })).toThrow("verify.runtime.bogus");
	});

	it("rejects a block that cannot name a runnable check", () => {
		expect(() => fromFile({ verify: { runtime: { cli: { command: "x" } } } })).toThrow("verify.runtime.cli.expect");
		expect(() => fromFile({ verify: { runtime: { browser: { url: "http://127.0.0.1:1/" } } } })).toThrow("verify.runtime.browser.assertions");
		expect(() => fromFile({ verify: { runtime: { screenshot: { url: "http://127.0.0.1:1/" } } } })).toThrow("verify.runtime.screenshot.baseline");
		expect(() => fromFile({ verify: { runtime: { smoke: { command: "node s.js" } } } })).toThrow("verify.runtime.smoke.ready");
	});

	it("accepts a configured verifier command as the smoke/cli command", () => {
		const config = fromFile({
			verify: {
				commands: { runtime_smoke: "node server.js", cli_invocation: "my-cli" },
				runtime: { smoke: { ready: { log: "up" } }, cli: { expect: { exitCode: 0 } } },
			},
		});
		expect(config.verify?.runtime?.smoke?.ready?.log).toBe("up");
		expect(config.verify?.runtime?.cli?.expect?.exitCode).toBe(0);
	});

	it("keeps an empty CLI stdin/stdoutEquals as declared data, not an absence", () => {
		const config = fromFile({ verify: { runtime: { cli: { command: "x", stdin: "", expect: { stdoutEquals: "" } } } } });
		expect(config.verify?.runtime?.cli?.stdin).toBe("");
		expect(config.verify?.runtime?.cli?.expect?.stdoutEquals).toBe("");
	});

	it("validates timeouts, ports, dimensions, thresholds and scale at load", () => {
		const smoke = (ready: unknown, timeoutMs?: number) => ({
			verify: { runtime: { smoke: { command: "node s.js", ready, ...(timeoutMs === undefined ? {} : { timeoutMs }) } } },
		});
		expect(() => fromFile(smoke({ port: 70_000 }))).toThrow("verify.runtime.smoke.ready.port");
		expect(() => fromFile(smoke({ port: 0 }))).toThrow("verify.runtime.smoke.ready.port");
		expect(() => fromFile(smoke({ log: "up" }, 1.5))).toThrow("verify.runtime.smoke.timeoutMs");
		expect(() => fromFile({ verify: { runtime: { screenshot: { url: "http://127.0.0.1:1/", baseline: "b.png", threshold: 2 } } } })).toThrow("verify.runtime.screenshot.threshold");
		expect(() => fromFile({ verify: { runtime: { screenshot: { url: "http://127.0.0.1:1/", baseline: "b.png", deviceScaleFactor: 0 } } } })).toThrow("verify.runtime.screenshot.deviceScaleFactor");
		expect(() => fromFile({ verify: { runtime: { screenshot: { url: "http://127.0.0.1:1/", baseline: "b.png", viewport: { width: 0, height: 10 } } } } })).toThrow("verify.runtime.screenshot.viewport.width");
	});
});

describe("PRD-022 — limits.isolation, limits.max_escalations and workspace.worktreeRoot", () => {
	it("parses isolation and keeps max_escalations absent when unconfigured", () => {
		expect(fromFile({}).limits.isolation).toBe("none");
		expect(fromFile({}).limits.max_escalations).toBeUndefined();
		const configured = fromFile({ limits: { isolation: "worktree", max_escalations: 3 } });
		expect(configured.limits.isolation).toBe("worktree");
		expect(configured.limits.max_escalations).toBe(3);
	});

	it("rejects a bad isolation mode and a budget that is not a non-negative integer", () => {
		expect(() => fromFile({ limits: { isolation: "nope" } })).toThrow("limits.isolation");
		expect(() => fromFile({ limits: { max_escalations: -1 } })).toThrow("limits.max_escalations");
		expect(() => fromFile({ limits: { max_escalations: 1.5 } })).toThrow("limits.max_escalations");
		expect(() => fromFile({ limits: { executionAttempts: Number.POSITIVE_INFINITY } })).toThrow("limits.executionAttempts");
		expect(() => fromFile({ limits: { semanticReviewRounds: -2 } })).toThrow("limits.semanticReviewRounds");
	});

	it("carries workspace.worktreeRoot into worktreeRootOf", () => {
		const cwd = tempDir("leanpi-config-workspace-");
		writeConfig(cwd, { ...BASE, workspace: { worktreeRoot: ".worktrees" } });
		const config = loadConfig(cwd, {}, { XDG_CONFIG_HOME: tempDir("leanpi-config-xdg-") });
		expect(config.workspace?.worktreeRoot).toBe(".worktrees");
		expect(worktreeRootOf(config, cwd)).toBe(join(cwd, ".worktrees"));
		// The default when nothing is declared.
		expect(worktreeRootOf(undefined, cwd)).toBe(join(cwd, ".worktrees"));
		expect(() => fromFile({ workspace: { worktreeRoot: "" } })).toThrow("workspace.worktreeRoot");
	});
});
