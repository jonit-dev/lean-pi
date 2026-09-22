/**
 * PRD-041 — Pi-native upstream selection and the fail-closed preflight boundary.
 *
 * `prepareSubagents` is the one seam: it must pick the exact enabled resource path
 * Pi's own loader will expose, keep every other configured extension, and reject
 * a mismatched version, a second copy, a missing source or a project-scoped copy
 * before anything loads. The CLI preflight is global-only and must never execute
 * or trust project code.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { prepareCliSubagents, prepareSubagents, reviewedSubagentsVersion, subagentConfigPath } from "../../src/subagents/index.js";
import { isolateAgentDir, tempDir } from "../helpers/fixtures.js";

const require = createRequire(import.meta.url);
const INSTALLED = dirname(require.resolve("pi-subagents"));
const PIN = reviewedSubagentsVersion();

let restoreAgentDir: (() => void) | undefined;

afterEach(() => {
	restoreAgentDir?.();
	restoreAgentDir = undefined;
});

function globalDirWith(packages: unknown[]): string {
	const agentDir = tempDir("leanpi-agent-");
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages }, null, 2));
	restoreAgentDir = isolateAgentDir(agentDir);
	return agentDir;
}

function projectWith(settings: unknown): string {
	const cwd = tempDir("leanpi-repo-");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
	return cwd;
}

function fakePackage(name: string, version: string, body = "export default function() {}", dir = tempDir(`leanpi-${name}-`)): string {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, pi: { extensions: ["./index.js"] } }, null, 2));
	writeFileSync(join(dir, "index.js"), body);
	return dir;
}

describe("Pi-native pi-subagents selection (PRD-041)", () => {
	it("selects the exact enabled path Pi's own resolution returns", async () => {
		const agentDir = globalDirWith([INSTALLED]);
		const selection = await prepareCliSubagents(tempDir("leanpi-repo-"));
		expect(selection.origin).toBe("configured");
		expect(selection.version).toBe(PIN);
		expect(selection.entry).toBe(join(INSTALLED, "index.js"));
		expect(existsSync(selection.entry)).toBe(true);

		// Same manager, same cwd: the path LeanPi picked is the path Pi exposes.
		const manager = new DefaultPackageManager({ cwd: process.cwd(), agentDir, settingsManager: SettingsManager.create(process.cwd(), agentDir) });
		const resolved = await manager.resolve(async () => "skip");
		const upstream = resolved.extensions.filter((resource) => resource.path.endsWith(join("pi-subagents", "index.js")));
		expect(upstream.map((resource) => resource.path)).toEqual([selection.entry]);
	});

	it("returns a bundled entry when no copy is configured", async () => {
		globalDirWith([]);
		const selection = await prepareCliSubagents(tempDir("leanpi-repo-"));
		expect(selection.origin).toBe("bundled");
		expect(selection.version).toBe(PIN);
		expect(selection.entry).toBe(require.resolve("pi-subagents"));
	});

	it("keeps unrelated configured extensions while selecting upstream", async () => {
		const other = fakePackage("other-ext", "1.0.0");
		const agentDir = globalDirWith([INSTALLED, other]);
		await prepareCliSubagents(tempDir("leanpi-repo-"));
		const manager = new DefaultPackageManager({ cwd: process.cwd(), agentDir, settingsManager: SettingsManager.create(process.cwd(), agentDir) });
		const resolved = await manager.resolve(async () => "skip");
		const paths = resolved.extensions.map((resource) => resource.path);
		expect(paths).toContain(join(INSTALLED, "index.js"));
		expect(paths).toContain(join(other, "index.js"));
	});

	it("rejects an incompatible configured version before loading", async () => {
		const fake = fakePackage("pi-subagents", "9.9.9");
		globalDirWith([fake]);
		await expect(prepareCliSubagents(tempDir("leanpi-repo-"))).rejects.toThrow(/does not match LeanPi's pinned/);
	});

	it("ignores a disabled configured copy and selects the enabled pin", async () => {
		const old = fakePackage("pi-subagents", "0.60.0");
		globalDirWith([{ source: old, extensions: [] }, INSTALLED]);
		const selection = await prepareCliSubagents(tempDir("leanpi-repo-"));
		expect(selection).toMatchObject({ origin: "configured", version: PIN, entry: join(INSTALLED, "index.js") });
	});

	it("still rejects two enabled copies", async () => {
		globalDirWith([INSTALLED, fakePackage("pi-subagents", PIN)]);
		await expect(prepareCliSubagents(tempDir("leanpi-repo-"))).rejects.toThrow(/multiple pi-subagents copies are enabled/);
	});

	it("resolves global settings against the SDK resource agent dir, not the operator config dir", async () => {
		const operatorDir = tempDir("leanpi-operator-");
		restoreAgentDir = isolateAgentDir(operatorDir);
		const cwd = tempDir("leanpi-repo-");
		const agentDir = tempDir("leanpi-agent-");
		const vendored = fakePackage("pi-subagents", PIN, undefined, join(agentDir, "vendor", "pi-subagents"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: ["vendor/pi-subagents"] }));
		const selection = await prepareSubagents({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
		expect(selection).toMatchObject({ origin: "configured", entry: join(vendored, "index.js") });
		// Upstream's own config stays on `getAgentDir()`.
		expect(existsSync(subagentConfigPath(operatorDir))).toBe(true);
		expect(existsSync(subagentConfigPath(agentDir))).toBe(false);

		// Present only under the operator dir is missing for the SDK, and reported against the SDK settings.
		fakePackage("pi-subagents", PIN, undefined, join(operatorDir, "vendor", "pi-subagents"));
		const bare = tempDir("leanpi-agent-");
		writeFileSync(join(bare, "settings.json"), JSON.stringify({ extensions: ["vendor/pi-subagents"] }));
		await expect(prepareSubagents({ cwd, agentDir: bare, settingsManager: SettingsManager.create(cwd, bare) })).rejects.toThrow(join(bare, "settings.json"));
	});

	it("rejects a configured but missing source without installing it", async () => {
		const agentDir = globalDirWith(["npm:pi-subagents@0.70.1"]);
		await expect(prepareCliSubagents(tempDir("leanpi-repo-"))).rejects.toThrow(/not installed|will not install/);
		expect(existsSync(join(agentDir, "npm"))).toBe(false);
		expect(existsSync(join(agentDir, "node_modules"))).toBe(false);
	});

	it("rejects a project copy without executing or trusting project code", async () => {
		globalDirWith([]);
		const cwd = tempDir("leanpi-repo-");
		const sentinel = join(cwd, "executed");
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [INSTALLED] }, null, 2));
		writeFileSync(join(cwd, ".pi", "extensions", "marker.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "ran");\nexport default function() {}\n`);
		await expect(prepareCliSubagents(cwd)).rejects.toThrow(/project settings/);
		expect(existsSync(sentinel), "project extension code must never execute during preflight").toBe(false);
	});

	it("rejects a renamed project copy by its manifest, resolved from .pi like Pi, without executing it", async () => {
		globalDirWith([]);
		for (const layout of ["packages", "extensions", "discovered"] as const) {
			const cwd = tempDir("leanpi-repo-");
			const sentinel = join(cwd, "executed");
			const marker = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "ran");\nexport default function() {}\n`;
			mkdirSync(join(cwd, ".pi"), { recursive: true });
			if (layout === "discovered") {
				fakePackage("pi-subagents", PIN, marker, join(cwd, ".pi", "extensions", "delegation"));
			} else {
				fakePackage("pi-subagents", PIN, marker, join(cwd, "vendor", "delegation"));
				writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ [layout]: ["../vendor/delegation"] }));
			}
			await expect(prepareCliSubagents(cwd), layout).rejects.toThrow(/a project copy would load on top/);
			expect(existsSync(sentinel), `${layout}: project code must never execute during preflight`).toBe(false);
		}
	});

	it("identifies SSH and HTTPS git project sources by repository name", async () => {
		globalDirWith([]);
		for (const source of [
			"git:git@github.com:nicobailon/pi-subagents.git",
			"git@github.com:nicobailon/pi-subagents.git",
			"https://github.com/nicobailon/pi-subagents.git#v0.70.1",
			"git:github.com/nicobailon/pi-subagents@v0.70.1",
		]) {
			await expect(prepareCliSubagents(projectWith({ packages: [source] })), source).rejects.toThrow(/a project copy would load on top/);
		}
		await expect(prepareCliSubagents(projectWith({ packages: ["git:git@github.com:nicobailon/pi-subagents-extra.git"] }))).resolves.toMatchObject({ origin: "bundled" });
	});

	it("identifies npm project sources by exact package name, scope included", async () => {
		globalDirWith([]);
		await expect(prepareCliSubagents(projectWith({ packages: ["npm:@other/pi-subagents@1.0.0"] }))).resolves.toMatchObject({ origin: "bundled" });
		await expect(prepareCliSubagents(projectWith({ packages: ["npm:pi-subagents@0.70.1"] }))).rejects.toThrow(/a project copy would load on top/);
	});

	it("expands ~ like Pi before reading a local project copy's manifest", async () => {
		globalDirWith([]);
		const renamed = fakePackage("pi-subagents", PIN, undefined, join(tempDir("leanpi-home-copy-"), "renamed-copy"));
		const fromHome = `~/${relative(homedir(), renamed)}`;
		await expect(prepareCliSubagents(projectWith({ packages: [fromHome] })), fromHome).rejects.toThrow(/a project copy would load on top/);
	});

	it("does not count a disabled or excluded project entry, but still rejects an enabled one", async () => {
		globalDirWith([]);
		const disabled = projectWith({ packages: [{ source: INSTALLED, extensions: [] }], extensions: ["!../vendor/pi-subagents", "-../vendor/pi-subagents/index.js"] });
		await expect(prepareCliSubagents(disabled)).resolves.toMatchObject({ origin: "bundled" });
		await expect(prepareCliSubagents(projectWith({ packages: [INSTALLED] }))).rejects.toThrow(/a project copy would load on top/);
	});

	it("skips non-array project packages/extensions instead of iterating them", async () => {
		globalDirWith([]);
		const cwd = tempDir("leanpi-repo-");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: "pi-subagents", extensions: { source: "pi-subagents" } }));
		await expect(prepareCliSubagents(cwd)).resolves.toMatchObject({ origin: "bundled" });
	});

	it("never executes an untrusted project extension marker during a global preflight", async () => {
		globalDirWith([]);
		const cwd = tempDir("leanpi-repo-");
		const sentinel = join(cwd, "executed");
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "extensions", "marker.ts"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "ran");\nexport default function() {}\n`);
		const selection = await prepareCliSubagents(cwd);
		expect(selection.origin).toBe("bundled");
		expect(existsSync(sentinel)).toBe(false);
	});

	it("writes no user settings or environment during preflight", async () => {
		const agentDir = globalDirWith([INSTALLED]);
		const settingsBefore = readFileSync(join(agentDir, "settings.json"), "utf8");
		const envBefore = process.env.PI_CODING_AGENT_DIR;
		const filesBefore = readdirSync(agentDir).sort();
		await prepareCliSubagents(tempDir("leanpi-repo-"));
		expect(process.env.PI_CODING_AGENT_DIR).toBe(envBefore);
		expect(readFileSync(join(agentDir, "settings.json"), "utf8")).toBe(settingsBefore);
		// The only new entry is LeanPi's own upstream config, never Pi settings.
		const added = readdirSync(agentDir).filter((entry) => !filesBefore.includes(entry));
		expect(added).toEqual(["extensions"]);
	});

	it("aborts before loading when the operator config is malformed", async () => {
		const agentDir = globalDirWith([INSTALLED]);
		const configPath = join(agentDir, "extensions", "subagent", "config.json");
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, "{broken");
		await expect(prepareCliSubagents(tempDir("leanpi-repo-"))).rejects.toThrow(/refusing to load pi-subagents/);
		expect(readFileSync(configPath, "utf8")).toBe("{broken");
	});

	it("prepareSubagents uses the supplied settings manager and never writes", async () => {
		const agentDir = tempDir("leanpi-agent-");
		restoreAgentDir = isolateAgentDir(agentDir);
		const cwd = tempDir("leanpi-repo-");
		const settingsManager = SettingsManager.inMemory({ packages: [INSTALLED] });
		const selection = await prepareSubagents({ cwd, agentDir, settingsManager });
		expect(selection.entry).toBe(join(INSTALLED, "index.js"));
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
	});
});
