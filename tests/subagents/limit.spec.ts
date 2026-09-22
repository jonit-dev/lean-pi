/**
 * PRD-041 Phase 2 — the operator per-run limit (AC-3, AC-4, AC-5).
 *
 * The config functions are exercised against a real temp `PI_CODING_AGENT_DIR`
 * and the real files upstream reads; the clamp is exercised through the
 * `tool_call` event shape Pi delivers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../src/commands/registry.js";
import { registerHelpCommand } from "../../src/commands/help.js";
import { registerSubagentsLimitCommand } from "../../src/commands/subagents-limit.js";
import {
	SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT,
	clampSubagentOverride,
	ensureDefaultConfig,
	inspectOperatorLimit,
	isValidConcurrencyLimit,
	setLimit,
	subagentConfigPath,
} from "../../src/subagents/index.js";
import { tempDir } from "../helpers/fixtures.js";

function configFile(dir: string): string {
	return join(dir, "extensions", "subagent", "config.json");
}

function writeRaw(dir: string, contents: string): void {
	mkdirSync(join(dir, "extensions", "subagent"), { recursive: true });
	writeFileSync(configFile(dir), contents, "utf8");
}

describe("subagent config default (AC-3)", () => {
	it("creates the file with the default 3 and the working async default when none exists", () => {
		const dir = tempDir("leanpi-subcfg-");
		expect(subagentConfigPath(dir)).toBe(configFile(dir));
		expect(existsSync(configFile(dir))).toBe(false);

		const outcome = ensureDefaultConfig(dir);
		expect(outcome).toMatchObject({ status: "created", limit: SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT });
		expect(JSON.parse(readFileSync(configFile(dir), "utf8"))).toEqual({ globalConcurrencyLimit: 3, asyncByDefault: false });
		expect(inspectOperatorLimit(dir)).toMatchObject({ saved: 3, active: undefined });
	});

	it("preserves unrelated keys and every explicit valid value without rewriting", () => {
		const dir = tempDir("leanpi-subcfg-");
		const original = `${JSON.stringify({ waitTool: { enabled: false }, globalConcurrencyLimit: 7, asyncByDefault: true, custom: [1, 2] }, null, "\t")}\n`;
		writeRaw(dir, original);

		const outcome = ensureDefaultConfig(dir);
		expect(outcome).toMatchObject({ status: "present", limit: 7 });
		expect(readFileSync(configFile(dir), "utf8")).toBe(original);
	});

	it("adds only the missing owned keys to an existing object while preserving the others", () => {
		const dir = tempDir("leanpi-subcfg-");
		writeRaw(dir, `${JSON.stringify({ waitTool: { enabled: false }, custom: "keep" }, null, 2)}\n`);

		const outcome = ensureDefaultConfig(dir);
		expect(outcome).toMatchObject({ status: "created", limit: 3 });
		expect(JSON.parse(readFileSync(configFile(dir), "utf8"))).toEqual({
			waitTool: { enabled: false },
			custom: "keep",
			globalConcurrencyLimit: 3,
			asyncByDefault: false,
		});
	});

	it("leaves malformed JSON, a non-object, and an explicit invalid owned value byte-identical", () => {
		for (const raw of [
			"{ not json",
			"[1,2,3]\n",
			'{"globalConcurrencyLimit": 0}\n',
			'{"globalConcurrencyLimit": 2.5}\n',
			'{"globalConcurrencyLimit": "3"}\n',
			'{"asyncByDefault": "yes"}\n',
		]) {
			const dir = tempDir("leanpi-subcfg-");
			writeRaw(dir, raw);
			const outcome = ensureDefaultConfig(dir);
			expect(outcome.status, raw).toBe("invalid");
			expect(readFileSync(configFile(dir), "utf8"), raw).toBe(raw);
		}
	});

	it("validates only positive safe integers", () => {
		expect(isValidConcurrencyLimit(3)).toBe(true);
		expect(isValidConcurrencyLimit(1)).toBe(true);
		expect(isValidConcurrencyLimit(0)).toBe(false);
		expect(isValidConcurrencyLimit(-2)).toBe(false);
		expect(isValidConcurrencyLimit(1.5)).toBe(false);
		expect(isValidConcurrencyLimit(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
		expect(isValidConcurrencyLimit("3")).toBe(false);
	});
});

describe("setLimit (AC-4)", () => {
	it("writes a positive integer and preserves unrelated keys, and reset writes 3", () => {
		const dir = tempDir("leanpi-subset-");
		writeRaw(dir, '{"waitTool":{"enabled":false}}\n');

		expect(setLimit(4, dir)).toMatchObject({ limit: 4 });
		expect(JSON.parse(readFileSync(configFile(dir), "utf8"))).toEqual({ waitTool: { enabled: false }, globalConcurrencyLimit: 4 });

		expect(setLimit("reset", dir)).toMatchObject({ limit: 3 });
		expect(JSON.parse(readFileSync(configFile(dir), "utf8"))).toEqual({ waitTool: { enabled: false }, globalConcurrencyLimit: 3 });
	});

	it("refuses invalid input and a malformed file without writing", () => {
		const dir = tempDir("leanpi-subset-");
		writeRaw(dir, "{ broken");
		expect(() => setLimit(4, dir)).toThrow(/refusing to overwrite/);
		expect(readFileSync(configFile(dir), "utf8")).toBe("{ broken");

		const clean = tempDir("leanpi-subset-");
		expect(() => setLimit(0, clean)).toThrow(/positive safe integer/);
		expect(() => setLimit(1.5, clean)).toThrow(/positive safe integer/);
		expect(existsSync(configFile(clean))).toBe(false);
	});
});

describe("/subagents-limit command (AC-4)", () => {
	function registryFor(dir: string) {
		const registry = createCommandRegistry();
		registerHelpCommand(registry);
		// A bare registry has no session capture; only `path` is used for writes.
		registerSubagentsLimitCommand(registry, { path: configFile(dir), limit: SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT }, dir);
		return registry;
	}

	it("shows without writing, sets and resets, appears in /help, and rejects invalid input without writing", async () => {
		const dir = tempDir("leanpi-subcmd-");
		const registry = registryFor(dir);

		const shown = await registry.dispatch("/subagents-limit", { cwd: dir });
		expect(shown.ok).toBe(true);
		expect(shown.text).toContain("saved 3");
		// Showing an absent config must not create it.
		expect(existsSync(configFile(dir))).toBe(false);

		const help = await registry.dispatch("/help", { cwd: dir });
		expect(help.text).toContain("/subagents-limit");

		const set = await registry.dispatch("/subagents-limit 4", { cwd: dir });
		expect(set.ok).toBe(true);
		expect(set.text).toMatch(/saved as 4/);
		expect(set.text).toMatch(/\/reload|restart/);
		expect(JSON.parse(readFileSync(configFile(dir), "utf8")).globalConcurrencyLimit).toBe(4);

		const before = readFileSync(configFile(dir), "utf8");
		for (const bad of ["0", "-1", "1.5", "abc", "1e3"]) {
			const result = await registry.dispatch(`/subagents-limit ${bad}`, { cwd: dir });
			expect(result.ok, bad).toBe(false);
			expect(readFileSync(configFile(dir), "utf8"), bad).toBe(before);
		}

		const reset = await registry.dispatch("/subagents-limit reset", { cwd: dir });
		expect(reset.ok).toBe(true);
		expect(JSON.parse(readFileSync(configFile(dir), "utf8")).globalConcurrencyLimit).toBe(3);

		// Re-registration (a second activation in one process) replaces, never throws.
		expect(() => registerSubagentsLimitCommand(registry, { path: configFile(dir), limit: 4 }, dir)).not.toThrow();
	});

	it("keeps each session's captured active value when two share one config path", async () => {
		// Two sessions attach the package against the same upstream config path
		// (a fixture dir). Each captures the value it attached with: a later
		// session's write must not rewrite an earlier session's reported active.
		const dir = tempDir("leanpi-twosessions-");
		const path = configFile(dir);
		const sessionA = createCommandRegistry();
		const sessionB = createCommandRegistry();
		registerSubagentsLimitCommand(sessionA, { path, limit: 3 }, dir);
		registerSubagentsLimitCommand(sessionB, { path, limit: 2 }, dir);

		const beforeA = await sessionA.dispatch("/subagents-limit", { cwd: dir });
		expect(beforeA.text).toContain("active 3");

		// Session B saves 2 to the shared path; A captured 3 and must still say so.
		const setB = await sessionB.dispatch("/subagents-limit 2", { cwd: dir });
		expect(setB.ok).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8")).globalConcurrencyLimit).toBe(2);

		const afterA = await sessionA.dispatch("/subagents-limit", { cwd: dir });
		expect(afterA.text).toContain("active 3");
		expect(afterA.text).toContain("saved 2");
		expect(afterA.text).toMatch(/applies after \/reload or restart/);

		const afterB = await sessionB.dispatch("/subagents-limit", { cwd: dir });
		expect(afterB.text).toContain("active 2");
	});

	it("registered show/set read the captured path, never a later session's global", async () => {
		const dirA = tempDir("leanpi-path-a-");
		const dirB = tempDir("leanpi-path-b-");
		const registry = createCommandRegistry();
		registerSubagentsLimitCommand(registry, { path: configFile(dirA), limit: 5 }, dirA);

		// A later command registered against another dir must not retarget this one.
		registerSubagentsLimitCommand(registry, { path: configFile(dirB), limit: 7 }, dirB);
		const set = await registry.dispatch("/subagents-limit 9", { cwd: dirA });
		expect(set.ok).toBe(true);
		expect(JSON.parse(readFileSync(configFile(dirB), "utf8")).globalConcurrencyLimit).toBe(9);
		expect(existsSync(configFile(dirA))).toBe(false);
	});

	it("reports unreadable config instead of writing it", async () => {
		const dir = tempDir("leanpi-subcmd-");
		writeRaw(dir, "{ broken");
		const registry = registryFor(dir);
		const shown = await registry.dispatch("/subagents-limit", { cwd: dir });
		expect(shown.ok).toBe(true);
		expect(shown.text).toMatch(/saved unreadable/);
		const set = await registry.dispatch("/subagents-limit 4", { cwd: dir });
		expect(set.ok).toBe(false);
		expect(readFileSync(configFile(dir), "utf8")).toBe("{ broken");
	});
});

describe("clampSubagentOverride (AC-5)", () => {
	function handlers(): Map<string, (event: unknown) => void> {
		return new Map<string, (event: unknown) => void>();
	}

	function fakePi(map: Map<string, (event: unknown) => void>) {
		return { on: (event: string, handler: (event: unknown) => void) => void map.set(event, handler) };
	}

	function fire(map: Map<string, (event: unknown) => void>, input: Record<string, unknown>) {
		map.get("tool_call")?.({ toolName: "subagent", input });
		return input;
	}

	it("clamps only top-level workflow overrides, respects a lower value, never touches a plain call", () => {
		const map = handlers();
		clampSubagentOverride(fakePi(map) as never, 3);

		const high = fire(map, { workflowScript: "return 1", globalConcurrencyLimit: 99 });
		expect(high.globalConcurrencyLimit).toBe(3);

		const low = fire(map, { workflowScriptPath: "wf.js", globalConcurrencyLimit: 2 });
		expect(low.globalConcurrencyLimit).toBe(2);

		const absent = fire(map, { workflowScript: "return 1" });
		expect("globalConcurrencyLimit" in absent).toBe(false);

		const plain = fire(map, { agent: "scout", task: "look" });
		expect("globalConcurrencyLimit" in plain).toBe(false);

		const otherTool = { globalConcurrencyLimit: 99 };
		map.get("tool_call")?.({ toolName: "execute", input: otherTool });
		expect(otherTool.globalConcurrencyLimit).toBe(99);
	});
});
