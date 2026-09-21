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
import { bundledExtensions, isInformational, launchPlan, packageRoot, parseLeanPiFlags, resolvePiCli } from "../../src/cli/launch.js";
import { tempDir } from "../helpers/fixtures.js";

describe("the leanpi launcher", () => {
	it("runs Pi's own CLI with this package's extension in front of the user's argv", () => {
		const plan = launchPlan(["--print", "do the thing"], PACKAGE_ROOT);

		expect(plan.extension).toBe(join(PACKAGE_ROOT, "dist", "leanpi.js"));
		// `--no-skills` rides along: LeanPi does its own disclosure (PRD-005), and
		// Pi's discovery loads every installed skill — 190 on the machine this was
		// written on, and 82,343 bytes of the system prompt of every request.
		const theme = ["--theme", join(PACKAGE_ROOT, "themes", "leanpi.json"), "--use-theme", "leanpi"];
		// The bundled extensions ride between LeanPi's own and the switches.
		const bundled = bundledExtensions(PACKAGE_ROOT).flatMap((path) => ["--extension", path]);
		expect(plan.args).toEqual(["--extension", plan.extension, ...bundled, "--no-skills", ...theme, "--print", "do the thing"]);
		// Pi's CLI comes from the dependency, not from PATH: the version LeanPi is
		// built against is the one it should run under.
		expect(plan.cli).toBe(join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"));
		expect(existsSync(plan.cli)).toBe(true);
	});

	it("keeps an extension the caller asked for as well as its own", () => {
		const plan = launchPlan(["--extension", "/tmp/mine.js"], PACKAGE_ROOT);
		// Pi takes the flag more than once; dropping the caller's would be the
		// launcher deciding something it was not asked to decide.
		expect(plan.args.slice(0, 2)).toEqual(["--extension", plan.extension]);
		expect(plan.args).toContain("--no-skills");
		expect(plan.args.slice(-2)).toEqual(["--extension", "/tmp/mine.js"]);
	});

	it("leaves the palette alone when the caller named a theme", () => {
		expect(launchPlan(["--use-theme", "dark"], PACKAGE_ROOT).args).not.toContain("--theme");
		expect(launchPlan(["--no-themes"], PACKAGE_ROOT).args).not.toContain("--use-theme");
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

	it("treats --help and --version as informational, so they need no key and no config", () => {
		// They print and exit: refusing them for a missing JEV key, or writing a
		// config on the way to printing a version string, is the launcher doing
		// something the user did not ask for.
		expect(isInformational(["--help"])).toBe(true);
		expect(isInformational(["-v"])).toBe(true);
		expect(isInformational(["--print", "do the thing"])).toBe(false);
	});

	it("resolves its own package root from the built module", () => {
		expect(packageRoot(new URL("file://" + join(PACKAGE_ROOT, "dist", "cli", "launch.js")).href)).toBe(PACKAGE_ROOT);
	});

	it("takes --safety out of Pi's argv, and refuses a level that is not one of the three", () => {
		expect(parseLeanPiFlags(["--safety", "high", "--print", "go"])).toEqual({ allowMissingJev: false, safety: "high", rest: ["--print", "go"] });
		expect(parseLeanPiFlags(["--safety=low"]).safety).toBe("low");
		// Absent is the default, and absent must stay absent: the permission state
		// only overrides itself when the variable the launcher forwards is set.
		expect(parseLeanPiFlags(["--print", "go"]).safety).toBeUndefined();
		expect(() => parseLeanPiFlags(["--safety", "paranoid"])).toThrow(/low \| medium \| high/);
		expect(() => parseLeanPiFlags(["--safety"])).toThrow(/low \| medium \| high/);
	});

	it("attaches the bundled extensions after LeanPi's own, and none that duplicate a LeanPi subsystem", () => {
		const plan = launchPlan([]);
		const attached = plan.args.filter((argument, index) => plan.args[index - 1] === "--extension");
		// LeanPi first: it registers the baseline tools and PRD-017's guard, and a
		// bundled extension that replaces a tool name needs that surface to exist.
		expect(attached[0]).toBe(plan.extension);
		expect(attached.slice(1)).toEqual(bundledExtensions());
		// Every bundled path is a real file, so Pi is never handed a missing one.
		for (const path of bundledExtensions()) expect(existsSync(path)).toBe(true);
		// Nothing LeanPi already owns: PRD-018 (LSP), PRD-019 (output reduction),
		// PRD-006 (MCP disclosure), `/context` and PRD-025 (todo) are not replaced
		// by a second implementation answering to no gate of ours.
		const owned = ["pi-lsp", "pi-output-limits", "pi-mcp-adapter", "pi-context-view", "rpiv-todo"];
		for (const name of owned) expect(plan.args.join(" ")).not.toContain(name);
	});
});
