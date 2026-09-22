/**
 * Shared fixtures for the PRD-018 suite: a small TypeScript repository, the
 * compiler wired to the real LSP provider, and a Pi session that carries the
 * LSP tool definitions. Nothing here mocks the compiler, the JEV client or the
 * language server.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
	type AgentSession,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	BASELINE_TOOL_NAMES,
	clearCapabilityProviders,
	compileTask,
	createJevClient,
	grantTrust,
	loadConfig,
	registerBaselineTools,
	registerCapabilityProvider,
	setCompilerContext,
	type ExecutionContract,
	type JevClient,
	type LeanPiConfig,
	type TaskPacket,
} from "../../src/index.js";
import { createLspProvider, LSP_TOOL_NAMES, registerLspTools, type LspProviderOptions } from "../../src/lsp/index.js";
import { tempDir } from "../helpers/fixtures.js";
import { startStubJev, type StubJev, type StubJevResponder } from "../helpers/stub-jev.js";

export const STUB_PROVIDER = "stub";
export const STUB_MODEL = "stub-model";

/**
 * True when a command resolves on `PATH` itself, ignoring the suite's own
 * `node_modules/.bin`. The guard for specs that shell out to a real toolchain.
 */
export function onSystemPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
	for (const dir of (env.PATH ?? env.Path ?? "").split(":")) {
		if (dir.length > 0 && existsSync(join(dir, command))) return true;
	}
	return false;
}

export const TSCONFIG = {
	compilerOptions: {
		target: "ES2022",
		module: "ESNext",
		moduleResolution: "bundler",
		strict: true,
		noEmit: true,
		skipLibCheck: true,
	},
	include: ["src"],
};

/** A cross-file fixture: a declaration, two callers, and a file that never mentions it. */
export function sourceFiles(): Record<string, string> {
	return {
		"src/symbols.ts": [
			"export const PORT: number = 8080;",
			"",
			"export function greet(name: string): string {",
			"\treturn `hello ${name}`;",
			"}",
			"",
		].join("\n"),
		"src/caller.ts": [
			'import { greet } from "./symbols";',
			"",
			"export function run(): string {",
			'\treturn greet("leanpi");',
			"}",
			"",
		].join("\n"),
		"src/other-caller.ts": [
			'import { greet } from "./symbols";',
			"",
			"export function runTwice(): string {",
			'\treturn greet("a") + greet("b");',
			"}",
			"",
		].join("\n"),
		"src/unrelated.ts": ["export function unrelated(): number {", "\treturn 42;", "}", ""].join("\n"),
	};
}

export interface Fixture {
	cwd: string;
	path(file: string): string;
}

export interface FixtureOptions {
	/**
	 * Write a fixture-local `node_modules/.bin/typescript-language-server` stub so
	 * detection is machine-independent. A spec that needs the *real* server passes
	 * `false` and resolves the globally installed one from PATH.
	 */
	server?: boolean;
}

/**
 * Write a TypeScript fixture repository; `scripts` selects the manifest's
 * commands. Detection looks in this repository's own `node_modules/.bin` too, so
 * the stub makes availability a property of the fixture, not of the machine.
 */
export function tsRepo(
	scripts: Record<string, string> = { typecheck: "tsc --noEmit" },
	files: Record<string, string> = sourceFiles(),
	options: FixtureOptions = {},
): Fixture {
	const cwd = tempDir("leanpi-lsp-");
	writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "lsp-fixture", private: true, scripts }, null, 2)}\n`);
	writeFileSync(join(cwd, "tsconfig.json"), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(join(cwd, file, ".."), { recursive: true });
		writeFileSync(join(cwd, file), contents);
	}
	if (options.server !== false) {
		const bin = join(cwd, "node_modules/.bin/typescript-language-server");
		mkdirSync(join(cwd, "node_modules/.bin"), { recursive: true });
		writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	}
	return { cwd, path: (file: string) => join(cwd, file) };
}

/** A repository with a detected server but no type-checking command: only a linter. */
export function lintOnlyRepo(options: FixtureOptions = {}): Fixture {
	return tsRepo({ lint: "oxlint src" }, undefined, options);
}

export function taskPacket(request: string, overrides: Partial<TaskPacket> = {}): TaskPacket {
	const base: TaskPacket = {
		repository: { languages: ["typescript"], project_type: "single", package_manager: "npm", dirty: true },
		task: { user_request: request },
		workspace: {
			changed_files: ["src/symbols.ts"],
			likely_modules: ["src"],
			test_runners: ["vitest"],
			lsp_available: true,
			git_branch: "main",
		},
	};
	return {
		repository: { ...base.repository, ...overrides.repository },
		task: { ...base.task, ...overrides.task },
		workspace: { ...base.workspace, ...overrides.workspace },
	};
}

export interface HarnessOptions {
	cwd?: string;
	/** The `lsp` config block, read structurally by the provider. */
	lsp?: Record<string, unknown>;
	jev?: "enabled" | "disabled";
	responders?: StubJevResponder[];
	provider?: LspProviderOptions;
	env?: NodeJS.ProcessEnv;
}

export interface LspHarness {
	cwd: string;
	config: LeanPiConfig;
	client: JevClient;
	stub?: StubJev;
	compile(request: string, packet?: TaskPacket): Promise<ExecutionContract>;
	close(): Promise<void>;
}

/** A config object carrying an `lsp` block, built the way the loader builds one. */
export function configFor(cwd: string, lsp?: Record<string, unknown>): LeanPiConfig {
	// A project-local language-server stub is an executable the repository ships,
	// so it is only reachable once the project is trusted (SURF-3). The fixtures
	// model a trusted checkout; `tests/lsp/trust.spec.ts` covers the other side.
	grantTrust(cwd);
	return loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { balanced: { backend: "local", model: STUB_MODEL } },
		...(lsp ? { lsp } : {}),
	} as Partial<LeanPiConfig>);
}

/** The real compiler, the real provider, and (unless disabled) the real JEV client. */
export async function harness(options: HarnessOptions = {}): Promise<LspHarness> {
	const cwd = options.cwd ?? tsRepo().cwd;
	const stub = options.jev === "disabled" ? undefined : await startStubJev(options.responders ?? []);
	grantTrust(cwd);
	const config = loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { balanced: { backend: "local", model: STUB_MODEL } },
		jev: {
			endpoint: stub?.url ?? "http://127.0.0.1:1/v1/systemone",
			apiKey: stub ? "test-key" : null,
			model: "jev-latest",
			mode: options.jev === "disabled" ? "disabled" : "enabled",
		},
		...(options.lsp ? { lsp: options.lsp } : {}),
	} as Partial<LeanPiConfig>);
	const client = createJevClient({ config, cwd });
	setCompilerContext({ client, config, cwd });
	clearCapabilityProviders();
	registerCapabilityProvider(createLspProvider({ root: cwd, config, ...(options.env ? { env: options.env } : {}), ...(options.provider ?? {}) }));
	return {
		cwd,
		config,
		client,
		...(stub ? { stub } : {}),
		compile: (request, packet = taskPacket(request)) => compileTask(request, packet),
		async close() {
			clearCapabilityProviders();
			setCompilerContext(undefined);
			await stub?.close();
		},
	};
}

export interface LspToolsSession {
	session: AgentSession;
	dispose(): void;
}

/**
 * A live Pi session whose extension registers the baseline tools and the seven
 * LSP tools, so `applyLspTools` can expose a real mode group to a real session.
 */
export async function bootLspToolsSession(options: { cwd: string; agentDir?: string; baseUrl: string }): Promise<LspToolsSession> {
	const agentDir = options.agentDir ?? tempDir("leanpi-agent-");
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir,
		resourceLoaderOptions: {
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.registerProvider(STUB_PROVIDER, {
						name: STUB_PROVIDER,
						baseUrl: options.baseUrl,
						apiKey: "sk-stub",
						api: "openai-completions",
						models: [
							{
								id: STUB_MODEL,
								name: STUB_MODEL,
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128_000,
								maxTokens: 8_192,
							},
						],
					});
					registerBaselineTools(pi, options.cwd);
					registerLspTools(pi, { root: options.cwd });
				},
			],
		},
	});
	const model = services.modelRuntime.getModel(STUB_PROVIDER, STUB_MODEL);
	if (!model) throw new Error("stub model is not registered");
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(),
		model,
		noTools: "builtin",
		// The allowlist admits the LSP tools to the registry; the mode, applied per
		// turn, decides which of them are active. They start inactive (§15).
		tools: [...BASELINE_TOOL_NAMES, ...LSP_TOOL_NAMES],
	});
	session.setActiveToolsByName([...BASELINE_TOOL_NAMES]);
	return { session, dispose: () => session.dispose() };
}
