/**
 * The `leanpi` launcher (PRD-001's consumer flow).
 *
 * LeanPi is a Pi extension, so "run LeanPi" means "run Pi with this package's
 * built extension attached". The command has to do that without the user
 * knowing it, and without a globally installed `pi`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../../src/index.js";
import { compactUiAttached } from "../../src/core/tools.js";
import { bundledExtensions, backgroundTasksExtension, foldCacheExtension, isInformational, launchEnv, launchPlan, packageRoot, parseLeanPiFlags, resolvePiCli, shouldCheckForUpdate, sourceCheckout, spinnerExtension } from "../../src/cli/launch.js";
import { bootSession, fixtureRepo, nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend } from "../helpers/stub-backend.js";

describe("the leanpi launcher", () => {
	it("runs Pi's own CLI with this package's extension in front of the user's argv", () => {
		const plan = launchPlan(["--print", "do the thing"], PACKAGE_ROOT);

		expect(plan.extension).toBe(join(PACKAGE_ROOT, "dist", "leanpi.js"));
		// `--no-skills` rides along: LeanPi does its own disclosure (PRD-005), and
		// Pi's discovery loads every installed skill — 190 on the machine this was
		// written on, and 82,343 bytes of the system prompt of every request.
		const theme = ["--theme", join(PACKAGE_ROOT, "themes", "leanpi.json"), "--use-theme", "leanpi"];
		// The bundled extensions ride between LeanPi's own and the switches, and the
		// frames ride last: their patch is installed at session start and has to sit
		// on top of the compact UI's module-load one. The fold's cache-clear rides
		// after them for the same reason, and only with the compact UI attached.
		const bundled = bundledExtensions(PACKAGE_ROOT).flatMap((path) => ["--extension", path]);
		expect(plan.args).toEqual([
			"--extension",
			plan.extension,
			"--extension",
			join(PACKAGE_ROOT, "extensions", "usage", "index.ts"),
			...bundled,
			"--extension",
			spinnerExtension(PACKAGE_ROOT),
			"--extension",
			foldCacheExtension(PACKAGE_ROOT),
			"--no-skills",
			...theme,
			"--print",
			"do the thing",
		]);
		// Pi's CLI comes from the dependency, not from PATH: the version LeanPi is
		// built against is the one it should run under. Resolved through the pnpm
		// store link, which is why the path is realpath'd.
		expect(plan.cli).toBe(realpathSync(join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")));
		expect(existsSync(plan.cli)).toBe(true);
	});

	it("finds dependencies hoisted above the package, as npm and npx install them", () => {
		// npm and npx hoist to the consumer's top-level node_modules, so an
		// installed leanpi has no node_modules/leanpi/node_modules at all. The
		// upward walk is what reaches the level above it.
		const consumer = tempDir("leanpi-hoisted-");
		const root = join(consumer, "node_modules", "leanpi");
		for (const entry of [
			join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
			join("@hk_net", "pi-usage-bars", "extensions", "usage-bars", "index.ts"),
			join("pi-claude-code-ui", "extensions", "index.ts"),
			join("pi-claude-code-ui", "extensions", "spinner.ts"),
		]) {
			const path = join(consumer, "node_modules", entry);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "export {};\n");
		}
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(join(root, "dist", "leanpi.js"), "export {};\n");
		expect(existsSync(join(root, "node_modules"))).toBe(false);
		expect(resolvePiCli(root)).toBe(realpathSync(join(consumer, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")));
		// The hoisted extensions are found and every path handed to Pi exists.
		const compactUi = realpathSync(join(consumer, "node_modules", "pi-claude-code-ui", "extensions", "index.ts"));
		const plan = launchPlan([], root);
		expect(plan.bundled).toContain(compactUi);
		for (const path of plan.bundled) expect(existsSync(path)).toBe(true);
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
		expect(parseLeanPiFlags(["--safety", "high", "--print", "go"])).toEqual({ allowMissingJev: false, safety: "high", ui: "compact", rest: ["--print", "go"] });
		expect(parseLeanPiFlags(["--safety=low"]).safety).toBe("low");
		// Absent is the default, and absent must stay absent: the permission state
		// only overrides itself when the variable the launcher forwards is set.
		expect(parseLeanPiFlags(["--print", "go"]).safety).toBeUndefined();
		expect(() => parseLeanPiFlags(["--safety", "paranoid"])).toThrow(/low \| medium \| high/);
		expect(() => parseLeanPiFlags(["--safety"])).toThrow(/low \| medium \| high/);
	});

	it("keeps the compact tool rows unless --ui plain asks for Pi's own", () => {
		// The compact renderer registers `read`, `edit` and `write` itself, so the
		// two halves have to agree: `--ui plain` drops the extension, and
		// `compactUiAttached` reads the same argv Pi is handed.
		expect(parseLeanPiFlags(["--print", "go"]).ui).toBe("compact");
		expect(parseLeanPiFlags(["--ui", "plain"]).ui).toBe("plain");
		expect(parseLeanPiFlags(["--ui=plain"]).rest).toEqual([]);
		expect(() => parseLeanPiFlags(["--ui", "tiny"])).toThrow(/compact \| plain/);
		const compact = launchPlan([], undefined, undefined, "compact");
		const plain = launchPlan([], undefined, undefined, "plain");
		expect(compact.bundled.some((path) => path.includes("pi-claude-code-ui"))).toBe(true);
		expect(plain.bundled.some((path) => path.includes("pi-claude-code-ui"))).toBe(false);
		expect(compactUiAttached(compact.args)).toBe(true);
		expect(compactUiAttached(plain.args)).toBe(false);
	});

	it("attaches the /usage adapter and drops the raw usage-bars entry", () => {
		const plan = launchPlan([]);
		// The bundled extension's own `/usage` renders an empty selector on a LeanPi
		// machine; the adapter runs the same factory but owns the single `usage`
		// registration, so Pi never renames it to usage:1/usage:2.
		expect(plan.bundled.some((path) => path.includes("pi-usage-bars"))).toBe(false);
		expect(plan.args).toContain(join(PACKAGE_ROOT, "extensions", "usage", "index.ts"));
		expect(existsSync(join(PACKAGE_ROOT, "extensions", "usage", "index.ts"))).toBe(true);
	});

	it("attaches the frames as TypeScript, so Pi loads them through jiti", () => {
		// A compiled `.js` extension is imported by Node and gets this package's own
		// pi-tui, so its patch lands on a prototype the interactive mode never
		// draws with. The Loader class Pi renders with is only reachable through
		// jiti's virtual-module map, which is keyed on a `.ts` extension.
		expect(spinnerExtension(PACKAGE_ROOT).endsWith(".ts")).toBe(true);
		expect(existsSync(spinnerExtension(PACKAGE_ROOT))).toBe(true);
	});

	it("attaches pi-patty-bg-tasks for the background shell, and leaves execute gated", () => {
		// The package overrides Pi's built-in `bash` with auto-background after 120s,
		// `run_in_background`, Ctrl+B, `jobs` and completion notices. It is not wired
		// into LeanPi's `execute`: the compiled lane and PRD-009's proof gate read an
		// exit status, and a shell that returned a job handle after 120s would break
		// the gate. So the package's path is attached and its `bash` is the
		// interactive shell, while `execute` stays LeanPi's own bounded definition.
		const path = backgroundTasksExtension(PACKAGE_ROOT);
		expect(path).toBeDefined();
		expect(path!.endsWith(join("pi-patty-bg-tasks", "index.ts"))).toBe(true);
		expect(existsSync(path!)).toBe(true);
		const plan = launchPlan([], PACKAGE_ROOT, undefined, "plain");
		expect(plan.bundled).toContain(path);
		expect(plan.args).toContain(path);
		// Not with the compact UI: `pi-claude-code-ui` registers `bash` too, and Pi
		// refuses a tool name two extensions register — the session dies at load.
		const compact = launchPlan([]);
		expect(compact.bundled).not.toContain(path);
		expect(compact.args).not.toContain("agent_bg");
		// `agent_bg` rides with the package but is excluded: it spawns a plain
		// `pi -p` from PATH, a shadow delegation path outside LeanPi's routing, its
		// permission guard and pi-subagents' cap (PRD-041).
		expect(plan.args).toContain("agent_bg");
		expect(plan.args[plan.args.indexOf("agent_bg") - 1]).toBe("--exclude-tools");
	});

	it("skips Pi's update banner in an installed package, but leaves it on in a source checkout", () => {
		// Pi's interactive mode asks pi.dev for a newer release and prints an
		// "Update Available" banner. In a source checkout that is a useful "bump the
		// pin" signal for the maintainer; in an installed package the version is
		// fixed by the dependency, so `pi update` cannot move it and the banner only
		// asks for something the operator cannot do. The published tarball carries
		// no `.git`, so the package root says which one this is.
		const flags = { allowMissingJev: true, safety: "high" as const, ui: "compact" as const, rest: [] };
		const installed = launchEnv(flags, true, { PATH: "/bin" }, tempDir("leanpi-installed-"));
		expect(installed).toEqual({ PATH: "/bin", PI_SKIP_VERSION_CHECK: "1", PI_CACHE_RETENTION: "long", LEANPI_NO_JEV: "1", LEANPI_JEV_WARNED: "1", LEANPI_SAFETY: "high" });
		const checkout = launchEnv(flags, true, { PATH: "/bin" }, PACKAGE_ROOT);
		expect(checkout).toEqual({ PATH: "/bin", PI_CACHE_RETENTION: "long", LEANPI_NO_JEV: "1", LEANPI_JEV_WARNED: "1", LEANPI_SAFETY: "high" });
		expect(sourceCheckout(PACKAGE_ROOT)).toBe(true);
	});

	it("checks for a newer LeanPi only in an installed package, on a TTY, off CI and not opted out", () => {
		// The installed layout (no `.git`) is where Pi's own banner is off and a
		// newer LeanPi is something the user can actually install.
		const installed = tempDir("leanpi-installed-");
		expect(shouldCheckForUpdate({ root: installed, argv: ["--print", "hi"], env: {}, isTTY: true })).toBe(true);
		// A source checkout has Pi's own banner as the maintainer's cue instead.
		expect(shouldCheckForUpdate({ root: PACKAGE_ROOT, argv: [], env: {}, isTTY: true })).toBe(false);
		// `--help`/`--version` print and exit; a redirected stderr is being parsed;
		// CI logs are not a terminal; the opt-out is the user's own answer.
		expect(shouldCheckForUpdate({ root: installed, argv: ["--version"], env: {}, isTTY: true })).toBe(false);
		expect(shouldCheckForUpdate({ root: installed, argv: [], env: {}, isTTY: false })).toBe(false);
		expect(shouldCheckForUpdate({ root: installed, argv: [], env: { CI: "1" }, isTTY: true })).toBe(false);
		expect(shouldCheckForUpdate({ root: installed, argv: [], env: { LEANPI_NO_UPDATE_CHECK: "1" }, isTTY: true })).toBe(false);
	});

	it("attaches the bundled extensions after LeanPi's own, and none that duplicate a LeanPi subsystem", () => {
		const plan = launchPlan([]);
		const attached = plan.args.filter((argument, index) => plan.args[index - 1] === "--extension");
		// LeanPi first: it registers the baseline tools and PRD-017's guard, and a
		// bundled extension that replaces a tool name needs that surface to exist.
		expect(attached[0]).toBe(plan.extension);
		// The `/usage` adapter follows LeanPi's own extension, then the bundled
		// extensions, then the frames.
		expect(attached.slice(1)).toEqual([join(PACKAGE_ROOT, "extensions", "usage", "index.ts"), ...bundledExtensions(), spinnerExtension(), foldCacheExtension()]);
		// Every bundled path is a real file, so Pi is never handed a missing one.
		for (const path of bundledExtensions()) expect(existsSync(path)).toBe(true);
		// Nothing LeanPi already owns: PRD-018 (LSP), PRD-019 (output reduction),
		// PRD-006 (MCP disclosure), `/context` and PRD-025 (todo) are not replaced
		// by a second implementation answering to no gate of ours.
		const owned = ["pi-lsp", "pi-output-limits", "pi-mcp-adapter", "pi-context-view", "rpiv-todo"];
		for (const name of owned) expect(plan.args.join(" ")).not.toContain(name);
	});
});

/**
 * PRD-046: the retention flag has to survive all the way to the provider request.
 *
 * `launchEnv()` returning the key proves nothing — Pi is the one that reads it.
 * So this boots a real Pi session against a stub provider with the environment
 * the spawned child would have, and asserts on the body Pi actually sent.
 */
async function bodyWithRetention(base: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
	const backend = await startStubBackend([{ text: "ok" }]);
	const { cwd } = fixtureRepo();
	writeConfig(cwd, {
		backends: { local: nativeBackend(backend.baseUrl) },
		models: { balanced: { backend: "local", model: "cheap-fast" } },
	});
	const env = launchEnv(parseLeanPiFlags([]), false, base, PACKAGE_ROOT);
	const previous = process.env.PI_CACHE_RETENTION;
	if (env.PI_CACHE_RETENTION === undefined) delete process.env.PI_CACHE_RETENTION;
	else process.env.PI_CACHE_RETENTION = env.PI_CACHE_RETENTION;
	try {
		const session = await bootSession({ cwd, agentDir: tempDir("leanpi-cache-agent-") });
		try {
			await session.runTurn("say ok");
		} finally {
			session.session.dispose();
		}
		return backend.requests[0]!.body;
	} finally {
		if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
		else process.env.PI_CACHE_RETENTION = previous;
		await backend.close();
	}
}

describe("long prompt-cache retention on the native path (PRD-046)", () => {
	it("sends long retention by default, and not when the operator sets short", async () => {
		const long = await bodyWithRetention({});
		expect(long.prompt_cache_retention).toBe("24h");
		expect(typeof long.prompt_cache_key).toBe("string");

		// The operator's own value wins: `short` must reach Pi unchanged, so the
		// extra write cost of a 1h TTL is never paid against their wishes.
		const short = await bodyWithRetention({ PI_CACHE_RETENTION: "short" });
		expect(short.prompt_cache_retention).toBeUndefined();
		expect(short.prompt_cache_key).toBeUndefined();
	});
});
