/**
 * The published tarball, not the source checkout (SURF-1/SURF-2).
 *
 * `bin/leanpi.js` statically imports `scripts/patch-pi-model-command.mjs` and the
 * default launch attaches `src/cli/fold-cache.ts`. `package.json` `files` shipped
 * neither, so an installed `leanpi` died at module load on `--help`/`--version`
 * and a compact session was handed an extension that does not exist. The source
 * checkout has both files, so `tests/cli/launch.spec.ts` is green while the
 * artifact is dead — hence a test against the real `npm pack` output.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT, type LeanPiSession } from "../../src/index.js";
import { fixtureRepo, isolateAgentDir, nativeBackend, writeConfig } from "../helpers/fixtures.js";

/**
 * Pack the repository, unpack it, and hand back the installed-layout root.
 * Every subprocess carries its own timeout: `execFileSync` is synchronous, so a
 * Vitest test timeout cannot interrupt a wedged `npm`/`node`.
 */
function packedInstall(dir: string): string {
	execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", dir], { cwd: PACKAGE_ROOT, stdio: "pipe", timeout: 120_000 });
	const tarball = readdirSync(dir).find((entry) => entry.endsWith(".tgz"));
	if (tarball === undefined) throw new Error(`npm pack wrote no tarball in ${dir}`);
	execFileSync("tar", ["-xzf", join(dir, tarball), "-C", dir], { stdio: "pipe", timeout: 30_000 });
	const pkg = join(dir, "package");
	// The dependency tree `npm install leanpi` would create. Symlinked rather than
	// installed so the smoke stays offline; the tarball itself is untouched.
	symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(pkg, "node_modules"), "dir");
	return pkg;
}

describe("the published package", () => {
	it("boots its launcher and ships every file the launcher attaches", { timeout: 120_000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "leanpi-pack-"));
		try {
			const pkg = packedInstall(dir);
			const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
			const version = execFileSync(process.execPath, [join(pkg, "bin", "leanpi.js"), "--version"], {
				cwd: dir,
				encoding: "utf8",
				env,
				timeout: 60_000,
			});
			expect(version.trim().length).toBeGreaterThan(0);
			const help = execFileSync(process.execPath, [join(pkg, "bin", "leanpi.js"), "--help"], {
				cwd: dir,
				encoding: "utf8",
				env,
				timeout: 60_000,
			});
			expect(help).toContain("pi - AI coding assistant");

			// The launcher's own plan names the files it attaches; every one has to be
			// present in this layout. `fold-cache` is attached only on the default
			// compact launch, which `--version` does not exercise, so read the plan.
			const launch = (await import(/* @vite-ignore */ pathToFileURL(join(pkg, "dist", "cli", "launch.js")).href)) as {
				launchPlan: (argv: string[], root?: string) => { args: string[] };
			};
			const attached = launch
				.launchPlan([], pkg)
				.args.filter((argument, index, all) => all[index - 1] === "--extension");
			expect(attached.length).toBeGreaterThan(0);
			for (const path of attached) expect(existsSync(path), `${path} missing from the published package`).toBe(true);
			// Named so a regression report says which file went missing.
			expect(existsSync(join(pkg, "src", "cli", "fold-cache.ts"))).toBe(true);
			expect(existsSync(join(pkg, "scripts", "patch-pi-model-command.mjs"))).toBe(true);

			// PRD-041: the shipped manifest must declare the pinned delegation
			// package, and the shipped default entry the CLI/SDK attach is a real
			// factory. A tarball that lost the dependency or flattened the default
			// export would install but never register `subagent`.
			const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
			expect(manifest.dependencies?.["pi-subagents"]).toBe("0.70.1");
			const shipped = (await import(/* @vite-ignore */ pathToFileURL(join(pkg, "dist", "index.js")).href)) as {
				default?: unknown;
				createLeanPiSession?: (options: { cwd: string; agentDir: string }) => Promise<LeanPiSession>;
			};
			expect(typeof shipped.default).toBe("function");
			const createShippedSession = shipped.createLeanPiSession;
			if (typeof createShippedSession !== "function") throw new Error("the packed SDK has no session entry");
			const repo = fixtureRepo();
			const restoreAgentDir = isolateAgentDir(repo.agentDir);
			let consumer: LeanPiSession | undefined;
			try {
				writeConfig(repo.cwd, {
					backends: { local: nativeBackend("http://127.0.0.1:1") },
					models: {
						quick: { backend: "local", model: "cheap-fast" },
						balanced: { backend: "local", model: "cheap-fast" },
						strong: { backend: "local", model: "cheap-fast" },
					},
					jev: { mode: "disabled" },
					lsp: { mode: "off" },
				});
				consumer = await createShippedSession({ cwd: repo.cwd, agentDir: repo.agentDir });
				expect(consumer.session.getActiveToolNames()).toContain("subagent");
				expect(consumer.session.getActiveToolNames()).toContain("bg_wait");
				const loaded = consumer.session.resourceLoader.getExtensions();
				expect(loaded.errors).toEqual([]);
				expect(loaded.extensions.flatMap((extension) => [...extension.commands.keys()])).toContain("run");
			} finally {
				consumer?.session.dispose();
				restoreAgentDir();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
