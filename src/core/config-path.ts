/**
 * Where a session's configuration comes from (PRD-001 §27).
 *
 * `leanpi` is a command a user runs from wherever they happen to be, so the file
 * is looked up the way every other project tool looks one up: the working
 * directory, then its ancestors (a monorepo package inherits the repository's
 * config), then the machine's own `$XDG_CONFIG_HOME/leanpi/`. Without the walk,
 * running the command one directory deeper than the config is a hard failure
 * with no obvious cause; without the user-level fallback, it cannot run outside
 * a configured project at all. The returned path is the project-level one when
 * nothing exists, so a caller that writes config writes it where it looked.
 *
 * Kept in its own module because the trust gate also needs to hash the config
 * file, and `core/config.ts` already imports the trust gate — one direction.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const CONFIG_FILENAME = "leanpi.config.yaml";

/**
 * The machine-wide config, where a first run writes one and where discovery
 * looks after the walk-up. One definition: a writer that computed this path
 * differently from the reader would write a file the next line cannot find.
 */
export function userConfigPath(env: { XDG_CONFIG_HOME?: string; HOME?: string } = process.env): string | undefined {
	const base = env.XDG_CONFIG_HOME ?? (env.HOME === undefined ? undefined : join(env.HOME, ".config"));
	return base === undefined ? undefined : join(base, "leanpi", CONFIG_FILENAME);
}

export function configPathFor(cwd: string, env: { XDG_CONFIG_HOME?: string; HOME?: string } = process.env): string {
	const project = join(cwd, CONFIG_FILENAME);
	let directory = cwd;
	for (;;) {
		const candidate = join(directory, CONFIG_FILENAME);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	const user = userConfigPath(env);
	return user !== undefined && existsSync(user) ? user : project;
}
