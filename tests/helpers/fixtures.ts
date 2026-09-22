/** Fixture repositories, config files and session booting for the PRD-001 suite. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { createLeanPiSession, type CreateLeanPiSessionOptions, type LeanPiSession } from "../../src/index.js";

export function tempDir(prefix = "leanpi-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** A backend entry pointing at a stub server, as `leanpi.config.yaml` would carry it. */
export function nativeBackend(baseUrl: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "native", baseUrl, api: "openai-completions", apiKey: "sk-stub", ...extra };
}

export function writeConfig(cwd: string, config: Record<string, unknown>): string {
	const path = join(cwd, "leanpi.config.yaml");
	writeFileSync(path, stringifyYaml(config));
	return path;
}

export function gitInit(cwd: string): void {
	const run = (args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	run(["init", "-q", "-b", "main"]);
	run(["config", "user.email", "fixture@example.com"]);
	run(["config", "user.name", "Fixture"]);
}

/** Commit everything currently in the fixture so `git status` reflects only new artifacts. */
export function gitCommitAll(cwd: string, message = "fixture"): void {
	const run = (args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
	run(["add", "-A"]);
	run(["commit", "-q", "-m", message]);
}

export function bootSession(options: CreateLeanPiSessionOptions): Promise<LeanPiSession> {
	return createLeanPiSession({ agentDir: tempDir("leanpi-agent-"), ...options });
}

/**
 * The environment a session fixture needs when its executor roles are bound to
 * an external harness stub. Subscription routing (PRD-008 §25) probes *this
 * machine* for a vendor login; a clean runner has none, so the executor class
 * is routed away from the stub and onto a native role, and the stub never runs.
 * The stub stands in for a signed-in vendor, so the fixture declares the
 * credential env var Claude Code reads — the non-file signal `probeVendor`
 * accepts beside `~/.claude/.credentials.json`.
 */
export function harnessStubEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...env, CLAUDE_CODE_OAUTH_TOKEN: "stub-claude-oauth-token" };
}

/** `bootSession` with the harness stub's declared login; for external-harness fixtures. */
export function bootHarnessSession(options: CreateLeanPiSessionOptions): Promise<LeanPiSession> {
	return bootSession({ ...options, env: harnessStubEnv(options.env) });
}

export function fixtureRepo(): { cwd: string; agentDir: string } {
	const cwd = tempDir("leanpi-repo-");
	const agentDir = tempDir("leanpi-agent-");
	mkdirSync(cwd, { recursive: true });
	return { cwd, agentDir };
}

/** The five names the baseline surface must expose, in a stable order. */
export const FIVE_TOOLS = ["read", "search", "edit", "write", "execute"];

export function toolNamesOf(body: Record<string, unknown>): string[] {
	const tools = body.tools as Array<{ function?: { name?: string } }> | undefined;
	return (tools ?? []).map((tool) => tool.function?.name ?? "").sort();
}

export function firstSystemMessage(body: Record<string, unknown>): { role?: string; content?: unknown } {
	const messages = body.messages as Array<{ role?: string; content?: unknown }> | undefined;
	return messages?.[0] ?? {};
}

export function systemText(body: Record<string, unknown>): string {
	const first = firstSystemMessage(body);
	return typeof first.content === "string" ? first.content : "";
}
