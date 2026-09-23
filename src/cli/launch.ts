/**
 * The `leanpi` launcher (PRD-001's consumer flow, made typeable).
 *
 * LeanPi is a Pi extension, not a fork: Pi owns the agent loop, the session tree
 * and the provider plumbing, and LeanPi contributes the compiler, the routing,
 * the tools and the accounting on top of it. That is the whole architecture
 * (FR-001), but it left the documented entry point as `pi --extension
 * ./dist/index.js` — a command nobody can be expected to remember, and one that
 * needs Pi on PATH. This builds the argv that runs Pi's own CLI with this
 * package's built extension already attached, so `leanpi` is the command and
 * every Pi flag still works behind it.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SAFETY_LEVELS, isSafetyLevel, type SafetyLevel } from "../permissions/rules.js";
import type { JevProvider } from "../core/types.js";

export interface LaunchPlan {
	/** Pi's own CLI entry point, resolved out of this package's dependency. */
	cli: string;
	/** Everything after `node <cli>`: the extension, then the user's own argv. */
	args: string[];
	/** The built extension the launcher attaches. */
	extension: string;
	/** Bundled third-party Pi extensions that were found and attached. */
	bundled: string[];
}

/**
 * Third-party Pi extensions LeanPi ships and attaches.
 *
 * Only what LeanPi does not already own, and only what Pi will actually accept.
 * `pi-lsp`, `pi-output-limits`, `pi-mcp-adapter`, `pi-context-view` and
 * `rpiv-todo` are deliberately absent: PRD-018's LSP tools, PRD-019's output
 * reduction, PRD-006's MCP disclosure, `/context` and PRD-025's todo list
 * already cover them, and a second implementation competes with the gate or the
 * budget the first one answers to. `pi-lean-edit` is absent for a harder reason
 * — it registers `read`, `edit` and `write`, which LeanPi already owns and puts
 * PRD-017's permission guard in front of, so Pi refuses all three registrations
 * and the extension loads contributing nothing.
 *
 * `@hk_net/pi-usage-bars` is absent as a raw entry for the same class of reason:
 * its own `/usage` resolves providers through Pi's model registry against a
 * fixed vendor list, and on a LeanPi machine that list matches none of the
 * configured backends, so the command renders nothing. It is attached through
 * `usageAdapterExtension` instead, which keeps its polling and status bar but
 * owns the single `usage` registration. Each shipped entry is TypeScript, which
 * Pi's loader compiles; the path is the package's own entry, not a build of
 * ours. A package that is not installed is skipped rather than fatal — the
 * launcher's job is to start a session.
 *
 * `pi-patty-bg-tasks` overrides Pi's built-in `bash`, a name LeanPi never
 * registers (its shell is `execute`), so backgrounding lands on the interactive
 * shell without touching the gated one. See `backgroundTasksExtension`.
 */

/**
 * The compact tool rows (`--ui compact`, the default).
 *
 * Claude Code's one-line-per-call surface: the output goes behind Ctrl+O and
 * every tool LeanPi registers gets a compact row, because the package patches
 * Pi's tool component rather than rendering only what it registers. It does
 * register `read`, `edit` and `write`, which is why `core/tools.ts` yields those
 * three names when this is attached. `themeAdaptive` (its default) derives the
 * palette from the active Pi theme, so LeanPi's own theme still decides the
 * colours. How much it shows is the package's to answer: `/cc-tools` in a
 * session, `.pi/settings.json` for a durable choice.
 */
const COMPACT_UI_EXTENSIONS: readonly string[] = [
	join("pi-claude-code-ui", "extensions", "index.ts"),
	join("pi-claude-code-ui", "extensions", "spinner.ts"),
];

/**
 * The folded reasoning display (`/thinking-fold`, on unless the user said off).
 *
 * Streaming reasoning otherwise grows upward for as long as the model thinks,
 * which on a long turn is the whole screen. This folds it to one collapsed
 * `Thinking … (ctrl+t to expand)` line — zero trace from the first frame — and
 * Ctrl+T reveals the full trace, toggling again to hide it. It leaves the rest
 * of the transcript alone.
 * Detached, Pi's own rendering — which `pi-claude-code-ui` styles — shows the
 * reasoning live again, so the choice is which of the two is attached, made
 * before the session exists and therefore at launch.
 *
 * Attached from `vendor/`, not from `node_modules/`. The package ships only
 * `index.min.js`, and Pi native-imports a `.js` extension rather than routing it
 * through jiti's virtual-module map — so its
 * `AssistantMessageComponent.prototype.updateContent` patch landed on a second
 * copy of the class and nothing that renders ever saw it, silently: the
 * extension still loaded and still registered `/99settings`. The same bytes
 * under a `.ts` name are transformed by jiti and resolve Pi's own modules.
 * `scripts/vendor-thinking-fold.mjs` makes the copy; `spinnerExtension` below
 * documents the identical trap, found the same way.
 */
export function thinkingFoldExtension(root: string = packageRoot()): string {
	return join(root, "vendor", "pi-thinking-fold", "index.min.ts");
}

/**
 * LeanPi's own spinner frames, as a path to *source*, not to the build output.
 *
 * Pi loads a `.ts` extension through jiti, which resolves
 * `@earendil-works/pi-tui` through its virtual-module map to the Loader class
 * the interactive mode renders with. A compiled `.js` extension is imported by
 * Node itself, so it gets this package's own pi-tui copy and patches a prototype
 * nothing draws with — which is exactly why the vendor's star set stayed on
 * screen. Keep this one attached as TypeScript.
 */
export function spinnerExtension(root: string = packageRoot()): string {
	return join(root, "src", "cli", "spinner.ts");
}

/**
 * The cache-clear that lets Ctrl+T expand a folded reasoning block under the
 * compact UI. Attached last, so it wraps that package's own `render` patch;
 * `fold-cache.ts` has the why. Pointless without both, so only when both are on.
 */
export function foldCacheExtension(root: string = packageRoot()): string {
	return join(root, "src", "cli", "fold-cache.ts");
}

/**
 * `pi-patty-bg-tasks`: Claude Code's background-task UX, on Pi's built-in bash.
 *
 * Pi's own `bash` blocks the turn until the command exits, so a dev server or an
 * e2e suite owns the session. This package overrides that tool with an
 * auto-background after 120s, an explicit `run_in_background`, Ctrl+B, the
 * `jobs` manager and completion notices. It is deliberately *not* wired into
 * LeanPi's `execute`: the compiled lane and PRD-009's proof gate read an exit
 * status, and a shell that returned a job handle after 120s would break the
 * gate. `bash` is the interactive shell; `execute` is the gated one.
 *
 * The path is the package's own manifest entry (`pi.extensions: ./index.ts`) —
 * TypeScript, so Pi's loader compiles it. Absent is skip-not-fatal.
 */
export function backgroundTasksExtension(root: string = packageRoot()): string | undefined {
	return dependencyDir(join("pi-patty-bg-tasks", "index.ts"), root);
}

/**
 * Where `entry` lives under `node_modules`, searched upward the way Node's own
 * resolver does: this package's `node_modules`, then each ancestor's.
 *
 * A fixed `packageRoot()/node_modules` join only holds in the pnpm dev checkout,
 * where `node_modules/` sits beside the source. npm and `npx` **hoist**
 * dependencies to the consumer's top-level `node_modules/`, so an installed
 * `leanpi` has no `node_modules/leanpi/node_modules/` at all. The walk covers
 * both layouts identically.
 *
 * Resolved through the symlink: Pi's loader requires an extension's own
 * dependencies from the directory it was handed, and pnpm's `node_modules/<pkg>`
 * is a link into the store — so the link path made `pi-claude-code-ui` fail with
 * `Cannot find module 'diff'`, while its real location has the store's siblings.
 *
 * `entry` is a path under `node_modules` (a package, or a file inside one);
 * `undefined` means it is absent at every level, which callers treat as
 * skip-not-fatal.
 */
export function dependencyDir(entry: string, from: string): string | undefined {
	let dir = from;
	for (;;) {
		const candidate = join(dir, "node_modules", entry);
		if (existsSync(candidate)) return realpathSync(candidate);
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * The bundled extensions present in this installation, as absolute paths.
 */
export function bundledExtensions(root: string = packageRoot(), ui: UiMode = "compact", thinkingFold = true): string[] {
	// Reasoning before the compact UI, and that order is load-bearing. Folding
	// works by setting `hideThinkingBlock` on the component and delegating to the
	// `updateContent` that was on the prototype when the extension loaded: Pi's
	// own honours the flag, `pi-claude-code-ui`'s replacement renders thinking
	// its own way and ignores it. Attached second, thinking-fold captured the
	// compact UI's and every trace streamed in full under `--ui compact` while
	// folding correctly under `--ui plain`.
	const fold = thinkingFold ? thinkingFoldExtension(root) : undefined;
	const vendored = fold !== undefined && existsSync(fold) ? [fold] : [];
	// Only without the compact UI: it registers `bash` as well, and Pi refuses a
	// tool name two extensions register, failing the whole session at load.
	const background = ui === "compact" ? undefined : backgroundTasksExtension(root);
	return [
		...vendored,
		...(ui === "compact" ? COMPACT_UI_EXTENSIONS : [])
			.map((entry) => dependencyDir(entry, root))
			.filter((path): path is string => path !== undefined),
		...(background === undefined ? [] : [background]),
	];
}

/**
 * The `/usage` adapter: the single owner of the `usage` command.
 *
 * LeanPi-owned, outside the `tsc` `src` build so Pi's loader compiles it, exactly
 * as the bundled `.ts` entries are. It runs the `@hk_net/pi-usage-bars` factory
 * and re-registers `usage` against LeanPi's own inventory; see
 * `src/cli/usage.ts`. Attached after LeanPi's own extension so the commands it
 * registers are in place when the adapter loads.
 */
export function usageAdapterExtension(root: string = packageRoot()): string {
	return join(root, "extensions", "usage", "index.ts");
}

/** This package's root, from the module's own location (`dist/cli/launch.js`). */
export function packageRoot(fromUrl: string = import.meta.url): string {
	return resolve(dirname(fileURLToPath(fromUrl)), "..", "..");
}

/**
 * Where Pi's CLI lives. Resolved through the dependency rather than PATH: the
 * version LeanPi is built against is the version it should run under, and a
 * globally installed `pi` may be neither. The package's `exports` map does not
 * expose its own manifest, so the path is the published bundle the vendor's own
 * `bin.pi` points at.
 */
export function resolvePiCli(root: string = packageRoot()): string {
	// The package manager's `.bin/pi` is a shell shim on this platform, so the
	// launcher runs the bundle it points at: `node <cli>` has to be a JS entry.
	const bundled = dependencyDir(join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"), root);
	if (bundled !== undefined) return bundled;
	throw new Error(
		`Pi's CLI was not found: @earendil-works/pi-coding-agent is missing from this installation of leanpi. Reinstall it with \`npm install leanpi\`.`,
	);
}

/** Pi's own informational flags: they print and exit, and configure nothing. */
export function isInformational(argv: readonly string[]): boolean {
	return argv.some((argument) => argument === "--help" || argument === "-h" || argument === "--version" || argument === "-v");
}

/** `--ui`: the tool-row surface. `plain` is Pi's own rendering. */
export const UI_MODES = ["compact", "plain"] as const;
export type UiMode = (typeof UI_MODES)[number];
export function isUiMode(value: string): value is UiMode {
	return (UI_MODES as readonly string[]).includes(value);
}

export class UnknownUiModeError extends Error {
	constructor(value: string) {
		super(`leanpi: --ui expects one of ${UI_MODES.join(" | ")}, got "${value}"`);
		this.name = "UnknownUiModeError";
	}
}

export interface LeanPiFlags {
	/** `--no-jev`: start the degraded harness deliberately. */
	allowMissingJev: boolean;
	/** `--jev-key <key>`: store the key for this machine, then start. */
	jevKey?: string;
	/** `--laya` / `--jev`: override `jev.provider` for this run (PRD-042). */
	provider?: JevProvider;
	/** `--safety <low|medium|high>`: one named permission policy for this session. */
	safety?: SafetyLevel;
	/** `--ui <compact|plain>`: the tool-row surface. Compact unless asked otherwise. */
	ui: UiMode;
	/** Everything else, in order, for Pi. */
	rest: string[];
}

export class UnknownSafetyLevelError extends Error {
	constructor(value: string) {
		super(`leanpi: --safety expects one of ${SAFETY_LEVELS.join(" | ")}, got "${value}"`);
		this.name = "UnknownSafetyLevelError";
	}
}

/**
 * LeanPi's own flags, taken out of the argv Pi receives. They are the questions
 * the launcher answers before a session exists — where the control plane's key
 * is, whether to start without one, and which permission policy this session
 * runs under — so Pi never sees them.
 *
 * `--safety` is absent by default and nothing reads it then: the stored user
 * scope and the project's config decide, exactly as before the flag existed.
 */
export function parseLeanPiFlags(argv: readonly string[]): LeanPiFlags {
	const rest: string[] = [];
	let allowMissingJev = false;
	let jevKey: string | undefined;
	let provider: JevProvider | undefined;
	let safety: SafetyLevel | undefined;
	let ui: UiMode = "compact";
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index] as string;
		if (argument === "--no-jev") {
			allowMissingJev = true;
			continue;
		}
		// `--laya` and `--jev` are the one-run override of `jev.provider`. Last
		// one wins, so a shell alias adding `--laya` is still overridable by hand.
		if (argument === "--laya") {
			provider = "laya";
			continue;
		}
		if (argument === "--jev") {
			provider = "typesafe";
			continue;
		}
		if (argument === "--jev-key") {
			const next = argv[index + 1];
			// `leanpi --jev-key --no-jev` used to store the literal string
			// "--no-jev" as the key and then refuse every request with a 401 the
			// user had no way to attribute. A flag is never a key.
			if (next === undefined || next.startsWith("-")) continue;
			jevKey = next;
			index += 1;
			continue;
		}
		const inline = argument.startsWith("--jev-key=") ? argument.slice("--jev-key=".length) : undefined;
		if (inline !== undefined) {
			jevKey = inline;
			continue;
		}
		if (argument === "--safety" || argument.startsWith("--safety=")) {
			const value = argument.startsWith("--safety=") ? argument.slice("--safety=".length) : argv[index + 1];
			if (value === undefined || !isSafetyLevel(value)) throw new UnknownSafetyLevelError(value ?? "");
			safety = value;
			if (!argument.startsWith("--safety=")) index += 1;
			continue;
		}
		if (argument === "--ui" || argument.startsWith("--ui=")) {
			const value = argument.startsWith("--ui=") ? argument.slice("--ui=".length) : argv[index + 1];
			if (value === undefined || !isUiMode(value)) throw new UnknownUiModeError(value ?? "");
			ui = value;
			if (!argument.startsWith("--ui=")) index += 1;
			continue;
		}
		rest.push(argument);
	}
	return { allowMissingJev, ...(jevKey === undefined ? {} : { jevKey }), ...(provider === undefined ? {} : { provider }), ...(safety === undefined ? {} : { safety }), ui, rest };
}

/**
 * Is LeanPi running from a source checkout rather than an installed package?
 *
 * The published tarball ships `bin`, `dist`, `skills`, `themes` and `vendor` and
 * never `.git` (`package.json` `files`), so a `.git` beside the package root is
 * what separates the maintainer's working copy from something `npm` unpacked
 * under `node_modules`.
 */
export function sourceCheckout(root: string = packageRoot()): boolean {
	return existsSync(join(root, ".git"));
}

/**
 * The environment Pi is spawned with.
 *
 * `LEANPI_*` carries the session decisions the extension inside the child has to
 * agree with — `--no-jev` and the warning the parent already printed are
 * decisions about the session, not just about startup, and `--safety` has no
 * other way to reach the permission state the guard resolves against.
 *
 * `PI_SKIP_VERSION_CHECK` is Pi's own documented switch for the startup
 * `pi.dev` latest-version request, which interactive Pi answers with an
 * "Update Available" banner. In a source checkout that banner is a useful "a
 * newer Pi is out, bump the pin" signal for whoever maintains this package. In
 * an installed package the version is fixed by the dependency, so `pi update`
 * cannot move it and the banner only asks for something the operator cannot do
 * from the session that showed it.
 *
 * `PI_CACHE_RETENTION` turns on pi-ai's one-hour prompt cache for the native
 * API-key path, whose 2x write cost buys a prefix that survives the gaps a
 * coding session produces (long tool calls, long reasoning turns). Pi defaults
 * to `short`; any value the operator already set, including `short`, wins.
 */
export function launchEnv(flags: LeanPiFlags, jevWarned: boolean, base: NodeJS.ProcessEnv = process.env, root: string = packageRoot()): NodeJS.ProcessEnv {
	return {
		...base,
		...(base.PI_CACHE_RETENTION === undefined ? { PI_CACHE_RETENTION: "long" } : {}),
		...(flags.allowMissingJev ? { LEANPI_NO_JEV: "1" } : {}),
		...(flags.provider === undefined ? {} : { LEANPI_LAYAY_PROVIDER: flags.provider }),
		...(jevWarned ? { LEANPI_JEV_WARNED: "1" } : {}),
		...(flags.safety === undefined ? {} : { LEANPI_SAFETY: flags.safety }),
		...(sourceCheckout(root) ? {} : { PI_SKIP_VERSION_CHECK: "1" }),
	};
}

export interface UpdateCheckEnv {
	root?: string;
	argv?: readonly string[];
	env?: NodeJS.ProcessEnv;
	isTTY?: boolean;
}

/**
 * Whether this launch should look for a newer LeanPi (PRD-043).
 *
 * Only the installed package: a source checkout has Pi's own banner as the
 * maintainer's "bump the pin" cue and nothing to install from npm. The rest are
 * the ways a notice would be wrong or unwelcome — `--help`/`--version` print and
 * exit, a redirected stderr is being parsed by something, CI logs are not a
 * terminal, and `LEANPI_NO_UPDATE_CHECK` is the user's own answer. This decides
 * both the line and the request, so a launch that skips the notice also makes
 * no registry call.
 */
export function shouldCheckForUpdate({ root = packageRoot(), argv = [], env = process.env, isTTY = false }: UpdateCheckEnv = {}): boolean {
	return !sourceCheckout(root) && !isInformational(argv) && isTTY && !env.CI && !env.LEANPI_NO_UPDATE_CHECK;
}

/**
 * The command `leanpi <argv>` runs.
 *
 * A caller that passed its own `--extension` keeps it *and* gets LeanPi's: Pi
 * accepts the flag more than once, and silently dropping a user's extension
 * would be the launcher deciding something it was not asked to decide.
 */
export function launchPlan(argv: readonly string[], root: string = packageRoot(), sessionModel?: string, ui: UiMode = "compact", thinkingFold = true, subagentsEntry?: string): LaunchPlan {
	// `dist/leanpi.js`, not `dist/index.js`: Pi names an extension after its
	// file and the banner is the user's first screen (`[Extensions] leanpi`).
	const extension = join(root, "dist", "leanpi.js");
	if (!existsSync(extension)) {
		throw new Error(`LeanPi is not built: ${extension} does not exist. Run \`npm run build\` in ${root}.`);
	}
	// Pi's own loop is what answers the user on this entry, and it needs a model
	// of its own: the extension can re-route a turn, but it cannot start one. So
	// the configured `balanced` model is passed through when Pi can run it —
	// otherwise Pi falls back to whatever provider it happens to have, which on
	// this machine was an unrelated endpoint with an exhausted quota and a bare
	// `429` as the user's first experience. An explicit `--model` always wins.
	// Every way Pi lets a user name a model: naming one over theirs would be the
	// launcher overriding an explicit instruction.
	const selects = argv.some(
		(argument) => argument === "--model" || argument === "-m" || argument === "--models" || argument.startsWith("--model=") || argument.startsWith("--models="),
	);
	const model = sessionModel !== undefined && !selects ? ["--model", sessionModel] : [];
	// LeanPi owns skill disclosure (PRD-005): the compiler picks the few a task
	// needs and the prompt carries those. Pi's own discovery loads every
	// installed skill — 190 on this machine, listed across the whole first
	// screen, and 82,343 bytes of the system prompt of every request. `-ns` is
	// the vendor's own switch for exactly that, so the library path's
	// `skillsOverride` and this entry now suppress the same thing the same way.
	const skills = argv.some((argument) => argument === "--skill" || argument === "--no-skills" || argument === "-ns") ? [] : ["--no-skills"];
	// LeanPi's own palette, loaded as an ordinary Pi theme file and selected for
	// this run only (`--use-theme` writes no settings). Anyone who named a theme,
	// or switched discovery off, keeps their choice.
	const theme = argv.some((argument) => argument === "--theme" || argument === "--use-theme" || argument === "--no-themes")
		? []
		: ["--theme", join(root, "themes", "leanpi.json"), "--use-theme", "leanpi"];
	// LeanPi's own extension first: it registers the baseline tools and the
	// permission guard, and a bundled extension that replaces a tool name must
	// take it from a surface that already exists.
	const bundled = bundledExtensions(root, ui, thinkingFold);
	const bundledArgs = bundled.flatMap((path) => ["--extension", path]);
	// Upstream `pi-subagents` is attached as its exact selected resource path,
	// once and centrally. Pi's loader merges this with the path its own settings
	// resolution produces and keeps one by canonical path, so a global install
	// and this selection cannot double-register.
	const subagents = subagentsEntry === undefined ? [] : ["--extension", subagentsEntry];
	// `pi-patty-bg-tasks` also ships `agent_bg`, which spawns a plain `pi -p` from
	// PATH: a second delegation path outside LeanPi's routing, its permission
	// guard and pi-subagents' concurrency cap, duplicating what PRD-041 already
	// owns. Excluded by name rather than attached — the background *shell* is the
	// feature; a shadow subagent is not.
	const backgroundTools = bundled.some((path) => path.includes("pi-patty-bg-tasks")) ? ["--exclude-tools", "agent_bg"] : [];
	return {
		cli: resolvePiCli(root),
		extension,
		bundled,
		args: [
			"--extension",
			extension,
			// The single `usage` owner rides right behind LeanPi's own extension: it
			// runs the bundled factory itself, so the raw usage-bars entry is never
			// attached and Pi's duplicate-name rename can never fire.
			"--extension",
			usageAdapterExtension(root),
			...subagents,
			...bundledArgs,
			"--extension",
			spinnerExtension(root),
			...(thinkingFold && ui === "compact" ? ["--extension", foldCacheExtension(root)] : []),
			...backgroundTools,
			...skills,
			...theme,
			...model,
			...argv,
		],
	};
}
