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
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SAFETY_LEVELS, isSafetyLevel, type SafetyLevel } from "../permissions/rules.js";

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
 * Each ships TypeScript, which Pi's loader compiles; the path is the package's
 * own entry, not a build of ours. A package that is not installed is skipped
 * rather than fatal — the launcher's job is to start a session.
 */
const BUNDLED_EXTENSIONS: readonly string[] = [
	// Quota, balance and spend per provider — the per-session cost on the status
	// line says what this run spent; this says what is left to spend it from.
	// Registers no tools, so it costs nothing in the prompt.
	join("@hk_net", "pi-usage-bars", "extensions", "usage-bars", "index.ts"),
];

/** The bundled extensions present in this installation, as absolute paths. */
export function bundledExtensions(root: string = packageRoot()): string[] {
	return BUNDLED_EXTENSIONS.map((entry) => join(root, "node_modules", entry)).filter((path) => existsSync(path));
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
	const bundled = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
	if (existsSync(bundled)) return bundled;
	throw new Error(`Pi's CLI was not found at ${bundled}. Run \`npm install\` in ${root}.`);
}

/** Pi's own informational flags: they print and exit, and configure nothing. */
export function isInformational(argv: readonly string[]): boolean {
	return argv.some((argument) => argument === "--help" || argument === "-h" || argument === "--version" || argument === "-v");
}

export interface LeanPiFlags {
	/** `--no-jev`: start the degraded harness deliberately. */
	allowMissingJev: boolean;
	/** `--jev-key <key>`: store the key for this machine, then start. */
	jevKey?: string;
	/** `--safety <low|medium|high>`: one named permission policy for this session. */
	safety?: SafetyLevel;
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
	let safety: SafetyLevel | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index] as string;
		if (argument === "--no-jev") {
			allowMissingJev = true;
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
		rest.push(argument);
	}
	return { allowMissingJev, ...(jevKey === undefined ? {} : { jevKey }), ...(safety === undefined ? {} : { safety }), rest };
}

/**
 * The command `leanpi <argv>` runs.
 *
 * A caller that passed its own `--extension` keeps it *and* gets LeanPi's: Pi
 * accepts the flag more than once, and silently dropping a user's extension
 * would be the launcher deciding something it was not asked to decide.
 */
export function launchPlan(argv: readonly string[], root: string = packageRoot(), sessionModel?: string): LaunchPlan {
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
	const bundled = bundledExtensions(root);
	const bundledArgs = bundled.flatMap((path) => ["--extension", path]);
	return {
		cli: resolvePiCli(root),
		extension,
		bundled,
		args: ["--extension", extension, ...bundledArgs, ...skills, ...theme, ...model, ...argv],
	};
}
