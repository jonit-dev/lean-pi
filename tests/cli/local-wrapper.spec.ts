import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { applyThinkingFoldPatches } from "../../scripts/vendor-thinking-fold.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const fixtures: string[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture(pathVersion: string, nvmVersions: string[] = []) {
	const root = mkdtempSync(join(tmpdir(), "leanpi-wrapper-"));
	fixtures.push(root);
	for (const dir of ["scripts", "bin", "src", "extensions", "node_modules", "caller directory", "tools", "home"]) mkdirSync(join(root, dir));
	for (const file of ["leanpi-local.sh", "dev-build.mjs", "vendor-thinking-fold.mjs", "build-extensions.mjs"]) {
		copyFileSync(join(ROOT, "scripts", file), join(root, "scripts", file));
	}
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	copyFileSync(join(ROOT, "tsconfig.json"), join(root, "tsconfig.json"));
	for (const entry of readdirSync(join(ROOT, "node_modules"))) symlinkSync(join(ROOT, "node_modules", entry), join(root, "node_modules", entry));
	writeFileSync(join(root, "src", "value.ts"), "export const value: number = 42;\n");
	writeFileSync(join(root, "bin", "leanpi.js"), `
import { value } from "../dist/value.js";
console.log(JSON.stringify({ value, cwd: process.cwd(), argv: process.argv.slice(2), executable: process.argv[1], path: process.env.PATH, t0: process.env.LEANPI_T0 }));
if (process.env.TEST_WAIT === "1") await new Promise(resolve => process.stdin.once("data", resolve));
process.exit(Number(process.env.TEST_EXIT ?? 0));
`);
	const preload = join(root, "version.mjs");
	writeFileSync(preload, `Object.defineProperty(process.versions, "node", { value: process.env.TEST_NODE_VERSION });
if(process.env.TEST_NO_TYPESCRIPT === "1") {
	const {registerHooks} = await import("node:module");
	registerHooks({resolve(specifier, context, nextResolve) { if(specifier === "typescript") throw new Error("warm launch imported TypeScript"); return nextResolve(specifier, context); }});
}`);
	const log = join(root, "nodes.log");
	function node(path: string, version: string) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}' >> '${log}'\nexport TEST_NODE_VERSION='${version}'\nexec '${process.execPath}' --import '${preload}' "$@"\n`);
		chmodSync(path, 0o755);
	}
	node(join(root, "tools", "node"), pathVersion);
	for (const version of nvmVersions) node(join(root, "home", ".nvm", "versions", "node", `v${version}`, "bin", "node"), version);
	for (const tool of ["date", "dirname", "readlink"]) symlinkSync(`/usr/bin/${tool}`, join(root, "tools", tool));
	const cwd = join(root, "caller directory");
	const env = { ...process.env, NODE_OPTIONS: "", HOME: join(root, "home"), PATH: join(root, "tools") };
	return {
		root, cwd, env,
		run(argv: string[] = [], extra: NodeJS.ProcessEnv = {}) {
			writeFileSync(log, "");
			const result = spawnSync("/bin/sh", [join(root, "scripts", "leanpi-local.sh"), ...argv], { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 15_000 });
			return { ...result, nodes: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
		},
	};
}

describe("local wrapper", () => {
	it("rebuilds stale local and dependency extension sidecars, and skips TypeScript on warm launches", () => {
		const app = fixture("22.19.0");
		const local = join(app.root, "extensions", "sample.ts");
		const dependency = join(app.root, "node_modules", "pi-claude-code-ui");
		rmSync(dependency);
		mkdirSync(dependency);
		writeFileSync(join(dependency, "package.json"), '{"name":"pi-claude-code-ui","version":"1.0.90"}');
		const upstream = join(dependency, "sample.ts");
		const outputs = [join(app.root, "dist/extensions/local/sample.js"), join(app.root, "dist/extensions/pi-claude-code-ui/sample.js")];
		for (const value of [42, 43]) {
			for (const source of [local, upstream]) writeFileSync(source, `export const value: number = ${value};\n`);
			if (value === 43) for (const output of outputs) utimesSync(output, 0, 0);
			const result = app.run();
			expect(result.status, result.stderr).toBe(0);
			expect(result.nodes).toEqual(["22.19.0"]);
			for (const output of outputs) expect(readFileSync(output, "utf8")).toContain(`value = ${value}`);
		}
		outputs.push(join(app.root, "dist/extensions/thinking-fold/index.min.js"));
		const mtimes = outputs.map((path) => statSync(path).mtimeMs);
		const vendor = join(app.root, "vendor/pi-thinking-fold/index.min.ts");
		const vendorBefore = { mtime: statSync(vendor).mtimeMs, content: readFileSync(vendor, "utf8") };
		const warm = app.run([], { TEST_NO_TYPESCRIPT: "1" });
		expect(warm.status, warm.stderr).toBe(0);
		expect(warm.nodes).toEqual(["22.19.0"]);
		expect(outputs.map((path) => statSync(path).mtimeMs)).toEqual(mtimes);
		expect({ mtime: statSync(vendor).mtimeMs, content: readFileSync(vendor, "utf8") }).toEqual(vendorBefore);
	});

	it.each(["22.19.0", "22.20.0", "23.0.0"])("uses one Node %s invocation for version, vendor, stale/warm build and CLI", (version) => {
		const app = fixture(version);
		for (const expectedValue of [42, 43]) {
			if (expectedValue === 43) {
				writeFileSync(join(app.root, "src", "value.ts"), "export const value: number = 43;\n");
				utimesSync(join(app.root, "dist", "value.js"), 0, 0);
				writeFileSync(join(app.root, "vendor", "pi-thinking-fold", "index.min.ts"), "stale vendor");
			}
			const result = app.run(["--example", "two words", "", "--", "-x"], { TEST_EXIT: "126" });
			expect(result.status, result.stderr).toBe(126);
			expect(result.nodes).toEqual([version]);
			expect(JSON.parse(result.stdout)).toEqual({ value: expectedValue, cwd: app.cwd, argv: ["--example", "two words", "", "--", "-x"], executable: join(app.root, "bin", "leanpi.js"), path: expect.stringContaining(join(app.root, "tools")), t0: expect.stringMatching(/^\d{13}$/) });
			const upstream = readFileSync(join(ROOT, "node_modules/@99percentpeople/pi-thinking-fold/index.min.js"), "utf8");
			expect(readFileSync(join(app.root, "vendor/pi-thinking-fold/index.min.ts"), "utf8")).toBe(applyThinkingFoldPatches(upstream));
		}
		const warm = app.run();
		expect(warm.status, warm.stderr).toBe(0);
		expect(warm.nodes).toEqual([version]);
		expect(JSON.parse(warm.stdout).value).toBe(43);
	});

	it.each(["20.19.0", "21.0.0", "22.18.0"])("rejects Node %s and launches once with the supported nvm runtime", (version) => {
		const app = fixture(version, ["22.19.0"]);
		const result = app.run(["argument"]);
		expect(result.status, result.stderr).toBe(0);
		expect(result.nodes).toEqual([version, "22.19.0"]);
		expect(JSON.parse(result.stdout).argv).toEqual(["argument"]);
		expect(JSON.parse(result.stdout).path.split(":")[0]).toBe(join(app.root, "home/.nvm/versions/node/v22.19.0/bin"));
	});

	it("preserves the no-supported-runtime error", () => {
		const app = fixture("22.18.0", ["20.19.0"]);
		const result = app.run();
		expect(result.status).toBe(1);
		expect(result.stderr).toBe("leanpi: no Node >= 22.19 found\n");
		expect(result.stdout).toBe("");
		expect(result.nodes).toEqual(["22.18.0", "20.19.0"]);
	});

	it("keeps vendor failure silent and build failure visible", () => {
		const app = fixture("22.19.0");
		writeFileSync(join(app.root, "scripts/vendor-thinking-fold.mjs"), 'throw new Error("vendor failed");');
		const vendor = app.run();
		expect(vendor.status).toBe(1);
		expect(vendor.stdout + vendor.stderr).toBe("");
		copyFileSync(join(ROOT, "scripts/vendor-thinking-fold.mjs"), join(app.root, "scripts/vendor-thinking-fold.mjs"));
		writeFileSync(join(app.root, "tsconfig.json"), "invalid JSON");
		const build = app.run();
		expect(build.status).toBe(1);
		expect(build.stdout).toBe("");
		expect(build.stderr).toContain("Error:");
	});

	it("streams stdout before the CLI exits", async () => {
		const app = fixture("22.19.0");
		const child = spawn("/bin/sh", [join(app.root, "scripts/leanpi-local.sh")], { cwd: app.cwd, env: { ...app.env, TEST_WAIT: "1" } });
		try {
			const closed = once(child, "close");
			const [chunk] = await Promise.race([once(child.stdout, "data"), closed.then(() => { throw new Error("CLI closed without streaming output"); })]);
			expect(JSON.parse(chunk.toString()).value).toBe(42);
			expect(child.exitCode).toBeNull();
			child.stdin.end("finish");
			expect((await closed)[0]).toBe(0);
		} finally {
			child.kill();
		}
	});
});
