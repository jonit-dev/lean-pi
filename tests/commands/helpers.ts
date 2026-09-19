/**
 * Shared fixtures for the PRD-016 command-surface suite.
 *
 * Every fixture drives the real registry and the real handlers; the only seams
 * are the ones production has too (a Pi `SessionManager` as the session store,
 * a stub backend, a stub JEV endpoint).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createCommandRegistry, loadConfig, type CommandRegistry, type CommandResult, type LeanPiConfig } from "../../src/index.js";
import {
	createCommandSurface,
	createSessionHost,
	registerCommandSurface,
	type CommandSurface,
	type CommandSurfaceDeps,
	type SessionHost,
} from "../../src/commands/index.js";
import { tempDir, writeConfig } from "../helpers/fixtures.js";

export interface SurfaceFixtureOptions {
	/** Written verbatim to the fixture's `leanpi.config.yaml`, so `/config` sees a real project file. */
	config: Record<string, unknown>;
	/** Loader overrides merged last, for surfaces the file schema does not carry (e.g. `capability:`). */
	configOverrides?: Partial<LeanPiConfig>;
	/** Existing project directory, e.g. to re-read a file an earlier session edited. */
	cwd?: string;
	/** `false` reuses the directory's existing `leanpi.config.yaml` untouched. */
	writeConfigFile?: boolean;
	/** Existing Pi session to attach; a fresh persisted one when absent. */
	manager?: SessionManager;
	/** Existing session directory; a fixture-local one when absent. */
	sessionDir?: string;
	name?: string;
	/** Built from the loaded config, so a real client points at the fixture's endpoint. */
	jev?: (config: LeanPiConfig, cwd: string) => CommandSurfaceDeps["jev"];
}

export interface SurfaceFixture {
	cwd: string;
	env: NodeJS.ProcessEnv;
	config: LeanPiConfig;
	manager: SessionManager;
	host: SessionHost;
	surface: CommandSurface;
	registry: CommandRegistry;
	configPath: string;
	/** A message appended through Pi's own store, with no live model involved. */
	append(role: "user" | "toolResult", text: string, extra?: Record<string, unknown>): void;
	appendAssistant(text: string): void;
	dispatch(line: string): Promise<CommandResult>;
}

export function fixtureEnv(cwd: string): NodeJS.ProcessEnv {
	return { HOME: join(cwd, "home"), XDG_CONFIG_HOME: join(cwd, "xdg") };
}

/** An assistant message with the fields Pi's store requires. */
export function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "stub",
		model: "stub-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

export function surfaceFixture(options: SurfaceFixtureOptions): SurfaceFixture {
	const cwd = options.cwd ?? tempDir("leanpi-surface-");
	const configPath = join(cwd, "leanpi.config.yaml");
	if (options.writeConfigFile !== false) writeConfig(cwd, options.config);
	const env = fixtureEnv(cwd);
	const config = loadConfig(cwd, options.configOverrides ?? {}, env);
	const sessionDir = options.sessionDir ?? join(cwd, "sessions");
	const manager = options.manager ?? SessionManager.create(cwd, sessionDir);
	if (options.name !== undefined && manager.getSessionName() === undefined) manager.appendSessionInfo(options.name);
	const host = createSessionHost({ cwd, manager, sessionDir });
	const registry = createCommandRegistry();
	const surface = registerCommandSurface(registry, {
		cwd,
		config,
		host,
		env,
		...(options.jev ? { jev: options.jev(config, cwd) } : {}),
	});

	const append: SurfaceFixture["append"] = (role, text, extra = {}) => {
		const base =
			role === "user"
				? { role: "user", content: text, timestamp: Date.now() }
				: {
						role: "toolResult",
						toolCallId: extra.toolCallId ?? "call-1",
						toolName: extra.toolName ?? "read",
						content: [{ type: "text", text }],
						isError: false,
						timestamp: Date.now(),
					};
		// Through Pi's own store, on whichever session is current now.
		host.current().appendMessage(base as unknown as AgentMessage);
	};

	return {
		cwd,
		env,
		config,
		manager,
		host,
		surface,
		registry,
		configPath,
		append,
		appendAssistant: (text) => host.current().appendMessage(assistantMessage(text)),
		dispatch: (line) => registry.dispatch(line, { cwd }),
	};
}

/** One skill on disk under `root`, so `/doctor` has a non-empty registry to report. */
export function skillFixture(root: string): string {
	mkdirSync(join(root, "fixture-skill"), { recursive: true });
	writeFileSync(join(root, "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: a fixture skill\n---\nbody\n");
	return root;
}

/** `$1.234567` → `1.234567`, so two commands' figures can be compared as numbers. */
export function moneyOf(text: string, label: string): number {
	const match = new RegExp(`${label}:?\\s+\\$([0-9.]+)`).exec(text);
	if (!match) throw new Error(`no "${label}" figure in:\n${text}`);
	return Number(match[1]);
}
