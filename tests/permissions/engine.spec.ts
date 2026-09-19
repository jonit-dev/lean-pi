/**
 * PRD-017 Phase 1 — the permission engine and `/permissions`.
 *
 * ACs: AC-1 (render + mutation), and the classification/resolution table the
 * scope-set ACs (AC-13, AC-14, AC-15) rest on: one call implicates a set of
 * scopes, the strictest decision wins, and `shell: allow` cannot buy network
 * access, a package install or an out-of-root read.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../src/commands/registry.js";
import {
	builtinPermissions,
	classifyScopes,
	globMatch,
	literalPrefixLength,
	loadPermissionState,
	mergePermissions,
	readUserState,
	registerPermissionsCommand,
	renderPermissions,
	resolve,
	resolveAll,
	writeUserDefault,
	writeUserRule,
} from "../../src/permissions/index.js";
import { nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";

const STUB_MODEL = "stub-model";

function project(): string {
	const cwd = tempDir("leanpi-perm-engine-");
	writeConfig(cwd, {
		backends: { stub: nativeBackend("http://127.0.0.1:1/v1") },
		models: { balanced: { backend: "stub", model: STUB_MODEL } },
	});
	return cwd;
}

function scopesOf(toolName: string, input: Record<string, unknown>, root: string): string[] {
	return classifyScopes({ toolName, input }, root).map((entry) => entry.capability);
}

describe("PRD-017 AC-1 — /permissions render and mutation", () => {
	it("lists every scope with its decision and source, then reflects a user-scope set", async () => {
		const cwd = project();
		const env = { XDG_CONFIG_HOME: tempDir("leanpi-perm-xdg-") };
		const registry = createCommandRegistry();
		registerPermissionsCommand(registry, { cwd, env });

		const before = await registry.dispatch("/permissions", { cwd });
		expect(before.ok).toBe(true);
		for (const scope of ["read", "edit", "shell", "network", "mcp", "external_dir", "subagent", "git_destructive", "package_install"]) {
			expect(before.text).toContain(scope);
		}
		expect(before.text).toMatch(/external_dir\s+deny\s+\(builtin default\)/);
		expect(before.text).toMatch(/shell\s+ask\s+\(builtin default\)/);
		expect(before.text).toContain(`project ${cwd}: untrusted`);

		const set = await registry.dispatch("/permissions set shell deny", { cwd });
		expect(set.ok).toBe(true);

		const after = await registry.dispatch("/permissions", { cwd });
		expect(after.text).toMatch(/shell\s+deny\s+\(user scope\)/);
		// The mutation went to user scope, not into the project's config file.
		expect(readUserState(env).defaults.shell).toBe("deny");
	});

	it("writes a capability rule and reports it with its source", async () => {
		const cwd = project();
		const env = { XDG_CONFIG_HOME: tempDir("leanpi-perm-xdg-") };
		const registry = createCommandRegistry();
		registerPermissionsCommand(registry, { cwd, env });

		expect((await registry.dispatch("/permissions set mcp:fs/read_file allow", { cwd })).ok).toBe(true);
		const rendered = (await registry.dispatch("/permissions", { cwd })).text;
		expect(rendered).toContain("mcp:fs/read_file -> allow (user scope)");
		expect(readUserState(env).rules).toEqual([{ capability: "mcp:fs/read_file", decision: "allow", source: "user" }]);

		// A capability carrying spaces needs no quoting: the decision is the last token.
		expect((await registry.dispatch("/permissions set shell:git push --force origin main deny", { cwd })).ok).toBe(true);
		expect(readUserState(env).rules.map((rule) => rule.capability)).toContain("shell:git push --force origin main");

		// A decision outside allow/ask/deny is refused, and nothing is written.
		expect((await registry.dispatch("/permissions set shell maybe", { cwd })).ok).toBe(false);
		expect(readUserState(env).defaults.shell).toBeUndefined();
	});
});

describe("PRD-017 Phase 1 — classification returns the whole scope set", () => {
	const root = "/tmp/leanpi-classify-root";

	it("AC-13: a shell curl implicates shell and network", () => {
		expect(scopesOf("execute", { command: "curl http://127.0.0.1:8080/" }, root).sort()).toEqual([
			"network:curl http://127.0.0.1:8080/",
			"shell:curl http://127.0.0.1:8080/",
		]);
	});

	it("AC-15: a package install implicates shell and package_install, while npm test is shell alone", () => {
		expect(scopesOf("execute", { command: "npm install evil-pkg" }, root).sort()).toEqual([
			"package_install:npm install evil-pkg",
			"shell:npm install evil-pkg",
		]);
		expect(scopesOf("execute", { command: "npm test" }, root)).toEqual(["shell:npm test"]);
	});

	it("AC-14: an out-of-root path argument implicates external_dir; a relative sibling is read alone", () => {
		expect(scopesOf("execute", { command: "cat ../../etc/shadow" }, root).sort()).toEqual([
			"external_dir:../../etc/shadow",
			"shell:cat ../../etc/shadow",
		]);
		expect(scopesOf("read", { path: "./inside.txt" }, root)).toEqual(["read:./inside.txt"]);
	});

	it("AC-5: destructive git implicates shell and git_destructive, plus network for push", () => {
		expect(scopesOf("execute", { command: "git push --force origin main" }, root).sort()).toEqual([
			"git_destructive:git push --force origin main",
			"network:git push --force origin main",
			"shell:git push --force origin main",
		]);
		expect(scopesOf("execute", { command: "git status" }, root)).toEqual(["shell:git status"]);
		expect(scopesOf("execute", { command: "git reset --hard HEAD~3" }, root).sort()).toEqual([
			"git_destructive:git reset --hard HEAD~3",
			"shell:git reset --hard HEAD~3",
		]);
	});

	it("AC-4: an MCP tool call is one capability id per server/tool", () => {
		expect(scopesOf("mcp__fs__write_file", { path: "a.txt" }, root)).toEqual(["mcp:fs/write_file"]);
		expect(scopesOf("mcp:fs/read_file", { path: "a.txt" }, root)).toEqual(["mcp:fs/read_file"]);
	});

	it("a symlinked path that leaves the session root is an out-of-root read", () => {
		const cwd = tempDir("leanpi-perm-symlink-");
		const outside = tempDir("leanpi-perm-outside-");
		writeFileSync(join(outside, "secret.txt"), "OUTSIDE\n");
		mkdirSync(join(cwd, "sub"), { recursive: true });
		symlinkSync(join(outside, "secret.txt"), join(cwd, "link.txt"));
		expect(scopesOf("read", { path: "link.txt" }, cwd)).toEqual(["read:link.txt", "external_dir:link.txt"]);
		expect(scopesOf("read", { path: "sub/../link.txt" }, cwd)).toEqual(["read:sub/../link.txt", "external_dir:sub/../link.txt"]);
	});
});

describe("PRD-017 Phase 1 — resolution and the strictest-scope rule", () => {
	it("resolves most specific rule, then scope default, then built-in default", () => {
		const config = builtinPermissions();
		expect(resolve("shell:rm -rf /", config)).toMatchObject({ decision: "ask", source: "builtin" });
		expect(resolve("external_dir:../../etc/shadow", config)).toMatchObject({ decision: "deny", source: "builtin" });

		config.rules.push({ capability: "shell:*", decision: "allow", source: "user" });
		config.rules.push({ capability: "shell:git push --force*", decision: "deny", source: "user" });
		expect(resolve("shell:ls", config)).toMatchObject({ decision: "allow", source: "user", matchedRule: "shell:*" });
		expect(resolve("shell:git push --force origin main", config)).toMatchObject({ decision: "deny", matchedRule: "shell:git push --force*" });
		// Longest literal prefix wins even when it is the looser rule.
		expect(literalPrefixLength("shell:git push --force*")).toBeGreaterThan(literalPrefixLength("shell:*"));

		config.rules.push({ capability: "mcp:fs/read_file", decision: "allow", source: "user" });
		expect(resolve("mcp:fs/write_file", config)).toMatchObject({ decision: "ask" });
		expect(resolve("mcp:fs/read_file", config)).toMatchObject({ decision: "allow" });
		expect(globMatch("mcp:fs/read_file", "mcp:fs/read_file")).toBe(true);
		expect(globMatch("mcp:fs/read_file", "mcp:fs/read_files")).toBe(false);
	});

	it("AC-13: shell allow cannot buy network access — the strictest decision decides", () => {
		const config = builtinPermissions();
		config.defaults.shell = "allow";
		config.defaultSources.shell = "user";
		config.defaults.network = "deny";
		config.defaultSources.network = "user";

		const allowed = resolveAll(["shell:echo ok"], config);
		expect(allowed.decision).toBe("allow");

		const refused = resolveAll(["shell:curl http://127.0.0.1:9/", "network:curl http://127.0.0.1:9/"], config);
		expect(refused.decision).toBe("deny");
		expect(refused.deciding.capability).toBe("network:curl http://127.0.0.1:9/");
	});
});

describe("PRD-017 Phase 2 — the asymmetric merge", () => {
	const trust = { trusted: false, status: "untrusted" } as never;

	it("AC-7: a project cannot loosen a scope default or a rule", () => {
		const user = { defaults: { shell: "deny" as const }, rules: [], trust: {}, secrets: { passthrough: [], secretNames: [], minLength: 8 } };
		const merged = mergePermissions({
			user,
			project: { defaults: { shell: "allow", edit: "deny" }, rules: [{ capability: "shell:*", decision: "allow" }], trust: true },
			trust,
		});
		expect(merged.defaults.shell).toBe("deny");
		expect(merged.defaultSources.shell).toBe("user");
		// A stricter project default is applied.
		expect(merged.defaults.edit).toBe("deny");
		expect(merged.defaultSources.edit).toBe("project");
		expect(merged.ignoredProjectGrants.map((grant) => grant.capability)).toEqual(["shell", "shell:*", "trust"]);
		expect(merged.ignoredProjectGrants[0]!.reason).toBe("project scope may only tighten permissions");
	});

	it("keeps a project rule that tightens what user scope resolves to", () => {
		const user = { defaults: {}, rules: [{ capability: "shell:*", decision: "allow" as const, source: "user" as const }], trust: {}, secrets: { passthrough: [], secretNames: [], minLength: 8 } };
		const merged = mergePermissions({
			user,
			project: { rules: [{ capability: "shell:rm -rf*", decision: "deny" }] },
			trust,
		});
		expect(resolve("shell:rm -rf /", merged)).toMatchObject({ decision: "deny", source: "project" });
		expect(resolve("shell:ls", merged)).toMatchObject({ decision: "allow", source: "user" });
	});
});

describe("PRD-017 Phase 2 — loadConfig applies the gate", () => {
	it("drops project-local skill roots and keeps user-global ones while untrusted", () => {
		const cwd = tempDir("leanpi-perm-load-");
		const env = { XDG_CONFIG_HOME: tempDir("leanpi-perm-xdg-") };
		const userSkills = tempDir("leanpi-user-skills-");
		writeConfig(cwd, {
			backends: { stub: nativeBackend("http://127.0.0.1:1/v1") },
			models: { balanced: { backend: "stub", model: STUB_MODEL } },
			capabilities: { skillRoots: [join(cwd, ".claude/skills"), userSkills] },
		});
		const state = loadPermissionState(cwd, env);
		expect(state.config.capabilities.skillRoots).toEqual([userSkills]);
		expect(state.trust.status).toBe("untrusted");
		expect(state.trust.dropped).toContain(join(cwd, ".leanpi", "extensions"));

		// The render path says the same thing, so `/permissions` is not a second truth.
		writeUserDefault("shell", "deny", env);
		expect(renderPermissions(loadPermissionState(cwd, env))).toMatch(/shell\s+deny\s+\(user scope\)/);
	});
});
