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

export function bootSession(options: CreateLeanPiSessionOptions): Promise<LeanPiSession> {
	return createLeanPiSession({ agentDir: tempDir("leanpi-agent-"), ...options });
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
