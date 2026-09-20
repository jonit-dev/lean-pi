/**
 * JEV credential resolution and storage (PRD-002 Phase 3).
 *
 * Resolution order: explicit config > stored credential > `JEV_API_KEY` >
 * not configured. The store lives outside the repository — it is never written
 * into project files, never committed and never echoed.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import type { LeanPiConfig } from "../core/types.js";

export type CredentialSource = "config" | "credential store" | "env" | "env file" | null;

export interface ResolvedCredential {
	key: string | null;
	source: CredentialSource;
}

export interface CredentialEnv {
	XDG_CONFIG_HOME?: string;
	HOME?: string;
	JEV_API_KEY?: string;
}

export function credentialsPath(env: CredentialEnv = process.env): string {
	const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config");
	return join(base, "leanpi", "credentials.json");
}

interface CredentialFile {
	jev?: { apiKey?: string };
}

export function readStoredKey(env: CredentialEnv = process.env): string | null {
	const path = credentialsPath(env);
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as CredentialFile;
		return typeof parsed.jev?.apiKey === "string" && parsed.jev.apiKey.length > 0 ? parsed.jev.apiKey : null;
	} catch {
		return null;
	}
}

/** Writes mode 0600 inside a 0700 directory, outside the repository. */
export function writeStoredKey(key: string, env: CredentialEnv = process.env): string {
	const path = credentialsPath(env);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify({ jev: { apiKey: key } }, null, 2)}\n`, { mode: 0o600 });
	chmodSync(path, 0o600);
	return path;
}

export function clearStoredKey(env: CredentialEnv = process.env): boolean {
	const path = credentialsPath(env);
	if (!existsSync(path)) return false;
	rmSync(path);
	return true;
}

/**
 * `JEV_API_KEY` from the project's `.env`, read as one more source — never loaded
 * into `process.env`. FR-054 says no LeanPi credential crosses into a spawned
 * vendor CLI, and every harness child inherits the process environment, so a key
 * that only ever lives in this function's return value cannot leak there.
 *
 * `parseEnv` is the dotenv parser Node ships (Node >= 22.19): quotes, inline
 * comments, CRLF, `export ` prefixes, and last-assignment-wins. It does not strip
 * a leading BOM, which would rename the variable to `\uFEFFJEV_API_KEY` and lose
 * the key silently, so that one is ours.
 */
export function readEnvFileKey(cwd: string, env: CredentialEnv = process.env): string | null {
	let value: string;
	try {
		value = parseEnv(readFileSync(join(cwd, ".env"), "utf8").replace(/^\uFEFF/, "")).JEV_API_KEY ?? "";
	} catch {
		// An absent or unreadable `.env` is "no key here", not a failure: resolution
		// falls through to the next source.
		return null;
	}
	return value.length > 0 ? value : null;
}

export function resolveCredential(config: LeanPiConfig, env: CredentialEnv = process.env, cwd: string = process.cwd()): ResolvedCredential {
	if (config.jev.apiKey) return { key: config.jev.apiKey, source: "config" };
	const stored = readStoredKey(env);
	if (stored) return { key: stored, source: "credential store" };
	if (env.JEV_API_KEY) return { key: env.JEV_API_KEY, source: "env" };
	const file = readEnvFileKey(cwd, env);
	if (file) return { key: file, source: "env file" };
	return { key: null, source: null };
}

/** The key is never logged or rendered: `/jev` reports the source, not the value. */
export function describeCredential(credential: ResolvedCredential): string {
	return credential.source === null ? "not configured" : `configured (source: ${credential.source})`;
}
