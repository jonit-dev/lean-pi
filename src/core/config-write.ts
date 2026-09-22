/**
 * The one config write LeanPi makes on a user's behalf (PRD-042).
 *
 * `/config` is read-only by design: config edits belong in the file, where they
 * are diffable and reviewable. The provider toggle is the one exception, and it
 * is deliberately the narrowest possible one — a single `jev.provider` leaf in
 * the *user* config, written with the `yaml` document API so comments, key
 * order and every unrelated value survive the round trip. Nothing else in the
 * file is touched, and no other key has a writer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseDocument } from "yaml";
import { userConfigPath } from "./config-path.js";
import type { JevProvider } from "./types.js";

export interface ConfigWriteEnv {
	XDG_CONFIG_HOME?: string;
	HOME?: string;
}

/** Sets `jev.provider` in the user config and returns the path written. */
export function writeUserProvider(provider: JevProvider, env: ConfigWriteEnv = process.env): string {
	const path = userConfigPath(env);
	if (path === undefined) {
		throw new Error("No user config location: set HOME or XDG_CONFIG_HOME.");
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// A missing file is an empty document, not an error: the first `/jev provider` on a
	// machine that has never written a config creates one with this single leaf.
	const text = existsSync(path) ? readFileSync(path, "utf8") : "";
	const document = parseDocument(text);
	if (document.errors.length > 0) {
		throw new Error(`Invalid YAML in ${path}: ${document.errors[0]?.message}`);
	}
	document.setIn(["jev", "provider"], provider);
	writeFileSync(path, document.toString(), { mode: 0o600 });
	return path;
}
