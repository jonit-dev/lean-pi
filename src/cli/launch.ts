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

export interface LaunchPlan {
	/** Pi's own CLI entry point, resolved out of this package's dependency. */
	cli: string;
	/** Everything after `node <cli>`: the extension, then the user's own argv. */
	args: string[];
	/** The built extension the launcher attaches. */
	extension: string;
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

export interface LeanPiFlags {
	/** `--no-jev`: start the degraded harness deliberately. */
	allowMissingJev: boolean;
	/** `--jev-key <key>`: store the key for this machine, then start. */
	jevKey?: string;
	/** Everything else, in order, for Pi. */
	rest: string[];
}

/**
 * LeanPi's own flags, taken out of the argv Pi receives. They are the two
 * questions the launcher answers before a session exists — where the control
 * plane's key is, and whether to start without one — so Pi never sees them.
 */
export function parseLeanPiFlags(argv: readonly string[]): LeanPiFlags {
	const rest: string[] = [];
	let allowMissingJev = false;
	let jevKey: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index] as string;
		if (argument === "--no-jev") {
			allowMissingJev = true;
			continue;
		}
		if (argument === "--jev-key") {
			jevKey = argv[index + 1];
			index += 1;
			continue;
		}
		const inline = argument.startsWith("--jev-key=") ? argument.slice("--jev-key=".length) : undefined;
		if (inline !== undefined) {
			jevKey = inline;
			continue;
		}
		rest.push(argument);
	}
	return { allowMissingJev, ...(jevKey === undefined ? {} : { jevKey }), rest };
}

/**
 * The command `leanpi <argv>` runs.
 *
 * A caller that passed its own `--extension` keeps it *and* gets LeanPi's: Pi
 * accepts the flag more than once, and silently dropping a user's extension
 * would be the launcher deciding something it was not asked to decide.
 */
export function launchPlan(argv: readonly string[], root: string = packageRoot()): LaunchPlan {
	const extension = join(root, "dist", "index.js");
	if (!existsSync(extension)) {
		throw new Error(`LeanPi is not built: ${extension} does not exist. Run \`npm run build\` in ${root}.`);
	}
	return { cli: resolvePiCli(root), extension, args: ["--extension", extension, ...argv] };
}
