/**
 * The `leanpi` launcher (PRD-001's consumer flow).
 *
 * LeanPi is a Pi extension, so "run LeanPi" means "run Pi with this package's
 * built extension attached". The command has to do that without the user
 * knowing it, and without a globally installed `pi`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../../src/index.js";
import { launchPlan, packageRoot, resolvePiCli } from "../../src/cli/launch.js";
import { tempDir } from "../helpers/fixtures.js";

describe("the leanpi launcher", () => {
	it("runs Pi's own CLI with this package's extension in front of the user's argv", () => {
		const plan = launchPlan(["--print", "do the thing"], PACKAGE_ROOT);

		expect(plan.extension).toBe(join(PACKAGE_ROOT, "dist", "leanpi.js"));
		// `--no-skills` rides along: LeanPi does its own disclosure (PRD-005), and
		// Pi's discovery loads every installed skill — 190 on the machine this was
		// written on, and 82,343 bytes of the system prompt of every request.
		expect(plan.args).toEqual(["--extension", plan.extension, "--no-skills", "--print", "do the thing"]);
		// Pi's CLI comes from the dependency, not from PATH: the version LeanPi is
		// built against is the one it should run under.
		expect(plan.cli).toBe(join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"));
		expect(existsSync(plan.cli)).toBe(true);
	});

	it("keeps an extension the caller asked for as well as its own", () => {
		const plan = launchPlan(["--extension", "/tmp/mine.js"], PACKAGE_ROOT);
		// Pi takes the flag more than once; dropping the caller's would be the
		// launcher deciding something it was not asked to decide.
		expect(plan.args).toEqual(["--extension", plan.extension, "--no-skills", "--extension", "/tmp/mine.js"]);
	});

	it("says what to do when the package is not built", () => {
		const unbuilt = tempDir("leanpi-unbuilt-");
		mkdirSync(join(unbuilt, "node_modules"), { recursive: true });
		expect(() => launchPlan([], unbuilt)).toThrow(/not built/);
		expect(() => launchPlan([], unbuilt)).toThrow(/npm run build/);
	});

	it("says what to do when Pi is not installed", () => {
		const root = tempDir("leanpi-nodeps-");
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(join(root, "dist", "leanpi.js"), "export {};\n");
		expect(() => resolvePiCli(root)).toThrow(/npm install/);
	});

	it("starts Pi through the built binary", () => {
		// The end of the chain: the shipped `bin/leanpi.js`, the built launcher and
		// Pi's CLI, in one process. `--help` is Pi's, which is the point: every Pi
		// flag still works behind the command.
		const help = execFileSync(process.execPath, [join(PACKAGE_ROOT, "bin", "leanpi.js"), "--help"], {
			encoding: "utf8",
			env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		});
		// Pi's own help, reached through LeanPi's binary: every Pi flag still works
		// behind the command.
		expect(help.replace(/\u001b\[[0-9;]*m/g, "")).toContain("pi - AI coding assistant");
		expect(help).toContain("--extension");
	});

	it("resolves its own package root from the built module", () => {
		expect(packageRoot(new URL("file://" + join(PACKAGE_ROOT, "dist", "cli", "launch.js")).href)).toBe(PACKAGE_ROOT);
	});
});
