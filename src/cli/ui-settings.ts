/**
 * The compact UI's own settings file, seeded once.
 *
 * `pi-claude-code-ui` reads `~/.pi/settings.json` (and the project's, which
 * wins) and derives nearly everything from the active Pi theme — the one thing
 * it does not is the syntax theme inside a diff, which is Shiki's and defaults
 * to `github-dark`. LeanPi's palette is teal and violet on near-black, so this
 * names a Shiki theme that belongs to it.
 *
 * Only keys the user has not set are written, and a file that does not parse is
 * left exactly as it is: this is a default, not a preference of ours.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What LeanPi's theme implies for the compact UI, where the user said nothing. */
export const COMPACT_UI_DEFAULTS: Readonly<Record<string, unknown>> = {
	// Teal accents, violet keywords, green strings — the palette `themes/leanpi.json`
	// already uses for Pi's own syntax colours.
	diffTheme: "night-owl",
};

/** Writes the defaults into Pi's settings file. Returns the keys it added. */
export function ensureCompactUiDefaults(home: string = homedir(), defaults: Readonly<Record<string, unknown>> = COMPACT_UI_DEFAULTS): string[] {
	const directory = join(home, ".pi");
	const path = join(directory, "settings.json");
	let settings: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
			settings = parsed as Record<string, unknown>;
		} catch {
			// Someone's hand-written file we cannot read is not ours to rewrite.
			return [];
		}
	}
	const added = Object.keys(defaults).filter((key) => settings[key] === undefined);
	if (added.length === 0) return [];
	for (const key of added) settings[key] = defaults[key];
	mkdirSync(directory, { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
	return added;
}

/**
 * `/thinking-fold` — LeanPi's own user-scope preference, in its own file.
 *
 * Which reasoning display is attached is decided before a session exists, so
 * the command persists the answer and the launcher reads it on the next start.
 * Kept out of Pi's `settings.json`: that file is Pi's and the vendor UI's, and
 * this key is neither's.
 */
export interface UiPrefsEnv {
	XDG_CONFIG_HOME?: string;
	HOME?: string;
}

/** Next to the permission state and the credential store. */
export function uiPrefsPath(env: UiPrefsEnv = process.env): string {
	const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config");
	return join(base, "leanpi", "ui.json");
}

/** Folded unless the user said otherwise; an absent or unreadable file is "unsaid". */
export function thinkingFoldEnabled(env: UiPrefsEnv = process.env): boolean {
	try {
		const parsed: unknown = JSON.parse(readFileSync(uiPrefsPath(env), "utf8"));
		return (parsed as { thinkingFold?: unknown }).thinkingFold !== false;
	} catch {
		return true;
	}
}

/** Writes the choice; returns the file it wrote. The only key this file has. */
export function setThinkingFold(enabled: boolean, env: UiPrefsEnv = process.env): string {
	const path = uiPrefsPath(env);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ thinkingFold: enabled }, null, 2)}\n`);
	return path;
}
