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
	escapesRoot,
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

	it("S2: git global options and separated flags do not hide a destructive or network subcommand", () => {
		// Separated / long force flags that the contiguous-cluster pattern missed.
		for (const command of ["git clean -fd", "git clean -f -d", "git clean --force -d"]) {
			expect(scopesOf("execute", { command }, root)).toContain(`git_destructive:${command}`);
		}
		// `-C`/`-c` before the subcommand hid both the subcommand and its network reach.
		expect(scopesOf("execute", { command: "git -C . push --force" }, root).sort()).toEqual([
			"git_destructive:git -C . push --force",
			"network:git -C . push --force",
			"shell:git -C . push --force",
		]);
		expect(scopesOf("execute", { command: "git -c user.name=x fetch" }, root).sort()).toEqual([
			"network:git -c user.name=x fetch",
			"shell:git -c user.name=x fetch",
		]);
		// `+refspec` is push's force form.
		expect(scopesOf("execute", { command: "git push origin +main" }, root).sort()).toEqual([
			"git_destructive:git push origin +main",
			"network:git push origin +main",
			"shell:git push origin +main",
		]);

		// Non-vacuous control: an ordinary git command stays shell alone.
		expect(scopesOf("execute", { command: "git status" }, root)).toEqual(["shell:git status"]);
		expect(scopesOf("execute", { command: "git log --oneline" }, root)).toEqual(["shell:git log --oneline"]);

		// The plain forms the old patterns already caught keep working.
		for (const command of ["git push --force origin main", "git reset --hard HEAD~3", "git branch -D feat", "git checkout -- .", "git update-ref -d refs/heads/main"]) {
			expect(scopesOf("execute", { command }, root)).toContain(`git_destructive:${command}`);
		}
	});

	it("AC-4: an MCP tool call is one capability id per server/tool", () => {
		expect(scopesOf("mcp__fs__write_file", { path: "a.txt" }, root)).toEqual(["mcp:fs/write_file"]);
		expect(scopesOf("mcp:fs/read_file", { path: "a.txt" }, root)).toEqual(["mcp:fs/read_file"]);
	});

	it("holds the background shell's fire-and-forget form to the same reach as execute", () => {
		// `pi-patty-bg-tasks` adds `bash_bg` (and overrides `bash`). Classified by the
		// catch-all it would be `shell:bash_bg`, losing the network/install/out-of-root
		// scopes its command implicates — a `curl` that never asks for network.
		expect(scopesOf("bash_bg", { command: "curl http://127.0.0.1:8080/" }, root).sort()).toEqual([
			"network:curl http://127.0.0.1:8080/",
			"shell:curl http://127.0.0.1:8080/",
		]);
		expect(scopesOf("bash_bg", { command: "npm install evil-pkg" }, root).sort()).toEqual([
			"package_install:npm install evil-pkg",
			"shell:npm install evil-pkg",
		]);
		expect(scopesOf("bash", { command: "git push --force origin main" }, root).sort()).toEqual([
			"git_destructive:git push --force origin main",
			"network:git push --force origin main",
			"shell:git push --force origin main",
		]);
	});

	it("classifies a monitor's command as shell and its ws source as network", () => {
		expect(scopesOf("monitor", { command: "tail -f deploy.log | grep ERROR" }, root)).toEqual(["shell:tail -f deploy.log | grep ERROR"]);
		// A socket is egress even though no command line carries it; `shell: allow`
		// must not buy it.
		expect(scopesOf("monitor", { ws: { url: "wss://events.example.com/stream" } }, root)).toEqual(["network:wss://events.example.com/stream"]);
		// Neither source named: the conservative catch-all still holds.
		expect(scopesOf("monitor", { description: "no source" }, root)).toEqual(["shell:monitor"]);
	});

	it("classifies agent_bg as subagent reach, not shell", () => {
		expect(scopesOf("agent_bg", { prompt: "refactor the auth module" }, root)).toEqual(["subagent:agent_bg"]);
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

describe("--safety <level>", () => {
	it("is off by default, and when set it replaces user scope and every rule", () => {
		const cwd = tempDir("leanpi-perm-safety-");
		const env = { XDG_CONFIG_HOME: tempDir("leanpi-perm-xdg-") };
		writeConfig(cwd, { backends: { stub: nativeBackend("http://127.0.0.1:1/v1") }, models: { balanced: { backend: "stub", model: STUB_MODEL } } });
		// The no-prompt machine this flag has to be able to override.
		writeUserDefault("shell", "allow", env);
		writeUserRule("network:*", "allow", env);

		expect(loadPermissionState(cwd, env).permissions.defaults.shell).toBe("allow");

		const high = loadPermissionState(cwd, { ...env, LEANPI_SAFETY: "high" });
		expect(high.permissions.defaults).toMatchObject({ read: "allow", edit: "ask", shell: "deny", network: "deny" });
		// A stored rule that outlived the flag would be a hole in the level.
		expect(high.permissions.rules).toEqual([]);
		expect(renderPermissions(high)).toContain("safety: high (--safety)");

		expect(loadPermissionState(cwd, { ...env, LEANPI_SAFETY: "low" }).permissions.defaults.git_destructive).toBe("allow");
		expect(loadPermissionState(cwd, { ...env, LEANPI_SAFETY: "medium" }).permissions.defaults.shell).toBe("ask");
		// An unusable value is not a silent third policy: the launcher rejects it,
		// and the variable is ignored here rather than locking the session down.
		expect(loadPermissionState(cwd, { ...env, LEANPI_SAFETY: "paranoid" }).permissions.defaults.shell).toBe("allow");
	});
});

describe("BUG_REVIEW S1 — an unresolvable leaf under an out-of-root link is still external_dir", () => {
	it("classifies a not-yet-created leaf through the link as an out-of-root write", () => {
		const cwd = tempDir("leanpi-perm-s1-");
		const outside = tempDir("leanpi-perm-s1-outside-");
		writeFileSync(join(outside, "existing.txt"), "OUTSIDE\n");
		symlinkSync(outside, join(cwd, "link"));

		// The leaf does not exist yet, so `realpath` alone cannot decide containment.
		expect(escapesRoot(cwd, "link/new.txt")).toBe(true);
		expect(escapesRoot(cwd, "link/deep/nested/new.txt")).toBe(true);
		// An existing leaf through the same link was, and stays, out of root.
		expect(escapesRoot(cwd, "link/existing.txt")).toBe(true);
		expect(scopesOf("write", { path: "link/new.txt" }, cwd)).toEqual(["edit:link/new.txt", "external_dir:link/new.txt"]);
		expect(scopesOf("write", { path: "link/existing.txt" }, cwd)).toEqual(["edit:link/existing.txt", "external_dir:link/existing.txt"]);
	});

	it("classifies a dangling symlink leaf by where it points, not by the root it sits in", () => {
		const cwd = tempDir("leanpi-perm-s1-");
		const outside = tempDir("leanpi-perm-s1-outside-");
		symlinkSync(join(outside, "not-created-yet.txt"), join(cwd, "dangling.txt"));
		expect(escapesRoot(cwd, "dangling.txt")).toBe(true);
		expect(scopesOf("write", { path: "dangling.txt" }, cwd)).toEqual(["edit:dangling.txt", "external_dir:dangling.txt"]);

		// A dangling link that points inside the root is not an escape.
		symlinkSync(join(cwd, "later.txt"), join(cwd, "in-root-dangling.txt"));
		expect(escapesRoot(cwd, "in-root-dangling.txt")).toBe(false);
	});

	it("fails closed when the path cannot be canonicalized at all", () => {
		const cwd = tempDir("leanpi-perm-s1-");
		symlinkSync("loop", join(cwd, "loop"));
		expect(escapesRoot(cwd, "loop")).toBe(true);
		expect(escapesRoot(cwd, "loop/x")).toBe(true);
	});

	it("keeps genuine in-root paths in root, including a leaf that does not exist yet", () => {
		const cwd = tempDir("leanpi-perm-s1-");
		expect(escapesRoot(cwd, "new.txt")).toBe(false);
		expect(escapesRoot(cwd, "deep/nested/new.txt")).toBe(false);
		expect(scopesOf("write", { path: "new.txt" }, cwd)).toEqual(["edit:new.txt"]);
	});
});

describe("BUG_REVIEW B6 — a symlinked session root does not push its own paths out of root", () => {
	const real = tempDir("leanpi-perm-b6-real-");
	const linkRoot = join(tempDir("leanpi-perm-b6-parent-"), "link");

	it("treats relative paths under a symlinked root as in-root, and real escapes as escapes", () => {
		writeFileSync(join(real, "a.txt"), "x\n");
		symlinkSync(real, linkRoot);

		expect(escapesRoot(linkRoot, "a.txt")).toBe(false);
		expect(escapesRoot(real, "a.txt")).toBe(false);
		// Same root, a leaf that is only going to be created.
		expect(escapesRoot(linkRoot, "b.txt")).toBe(false);
		expect(scopesOf("read", { path: "a.txt" }, linkRoot)).toEqual(["read:a.txt"]);
		expect(scopesOf("write", { path: "a.txt" }, linkRoot)).toEqual(["edit:a.txt"]);

		// A symlinked root must not become a licence to leave it.
		expect(escapesRoot(linkRoot, "../etc/passwd")).toBe(true);
		expect(escapesRoot(linkRoot, join(tempDir("leanpi-perm-b6-outside-"), "x.txt"))).toBe(true);
		expect(escapesRoot(real, "../etc/passwd")).toBe(true);
	});
});
