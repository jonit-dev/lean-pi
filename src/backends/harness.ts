/**
 * External harness workers (PRD-008 Phase 3, ROADMAP §24).
 *
 * One `spawn` implementation behind a three-entry descriptor table. The vendor
 * differences — argv spelling and result envelope — are data, so there is one
 * place to fix a bug rather than three near-identical modules.
 *
 * Credentials (FR-054/FR-058): the child inherits `process.env` and LeanPi adds
 * nothing. No API key argument is composed, no vendor credential file is read,
 * and no alternate auth path exists — each CLI authenticates itself exactly as
 * the user configured it. Flags were transcribed from `--help` on the installed
 * binaries (claude 2.x, codex, opencode) at implementation time.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeSnapshot, changedPathsSince } from "../runtime/git.js";
import type { RegisteredBackend } from "./registry.js";
import { parseMaybeJson, type WorkerMcpServer, type WorkerOutcome, type WorkerTaskPacket } from "./worker.js";

export const HARNESS_VENDORS = ["claude", "codex", "opencode"] as const;

/** The model id that means "no `--model` flag"; written by the first-run config. */
export const VENDOR_MODEL_DEFAULT = "default";

export type HarnessVendor = (typeof HARNESS_VENDORS)[number];

export function isHarnessVendor(value: string): value is HarnessVendor {
	return (HARNESS_VENDORS as readonly string[]).includes(value);
}

/** LeanPi tool name → the name the vendor's restricted tool set expects. */
const CLAUDE_TOOL_NAMES: Record<string, string> = {
	read: "Read",
	search: "Grep",
	edit: "Edit",
	write: "Write",
	execute: "Bash",
};

/** A TOML basic string, for Codex's `-c key=value` values. */
function tomlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Claude's `.mcp.json` shape, inline: `{ mcpServers: { <name>: {...} } }`. */
export function claudeMcpConfig(servers: WorkerMcpServer[]): string {
	const mcpServers: Record<string, unknown> = {};
	for (const server of servers) {
		mcpServers[server.name] =
			server.transport === "stdio"
				? {
						command: server.command ?? "",
						args: server.args ?? [],
						...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
					}
				: { type: "http", url: server.url ?? "" };
	}
	return JSON.stringify({ mcpServers });
}

/** Codex's `mcp_servers.<name>.*` overrides, one `-c` per field. */
export function codexMcpArgs(servers: WorkerMcpServer[]): string[] {
	const args: string[] = [];
	for (const server of servers) {
		const prefix = `mcp_servers.${server.name}`;
		if (server.transport === "http") {
			args.push("-c", `${prefix}.url=${tomlString(server.url ?? "")}`);
			continue;
		}
		args.push("-c", `${prefix}.command=${tomlString(server.command ?? "")}`);
		if ((server.args ?? []).length > 0) args.push("-c", `${prefix}.args=[${(server.args ?? []).map(tomlString).join(", ")}]`);
		if (server.env && Object.keys(server.env).length > 0) {
			args.push("-c", `${prefix}.env={${Object.entries(server.env).map(([key, value]) => `${key}=${tomlString(value)}`).join(", ")}}`);
		}
	}
	return args;
}

/** OpenCode's `mcp` block, delivered through `OPENCODE_CONFIG_CONTENT`. */
export function opencodeMcpConfig(servers: WorkerMcpServer[]): string {
	const mcp: Record<string, unknown> = {};
	for (const server of servers) {
		mcp[server.name] =
			server.transport === "stdio"
				? {
						type: "local",
						command: [server.command ?? "", ...(server.args ?? [])],
						...(server.env && Object.keys(server.env).length > 0 ? { environment: server.env } : {}),
						enabled: true,
					}
				: { type: "remote", url: server.url ?? "", enabled: true };
	}
	return JSON.stringify({ mcp });
}

export interface HarnessArgvContext {
	packet: WorkerTaskPacket;
	prompt: string;
	/** JSON Schema string form (Claude takes the schema inline). */
	schema?: string;
	/** Schema file path (Codex takes a file). */
	schemaPath?: string;
	/** The environment the vendor will run in; decides Claude's auth mode. */
	env?: NodeJS.ProcessEnv;
}

export interface ParsedHarnessEnvelope {
	sessionId?: string;
	summary: string;
	/** The vendor's structured payload; validated against the packet's schema. */
	structured?: unknown;
	error?: string;
	/** The model that actually ran, when the vendor names it (PRD-051). */
	run?: CliRunFacts;
}

/** What a vendor run reports about itself: every model it ran, and the tokens spent. */
export interface CliRunFacts {
	/** Each model the run used, keyed by its full id. A main loop can call helper models too. */
	models: Array<{ id: string; output: number; contextWindow?: number }>;
	/**
	 * The run's last API call, not the run's total: the total sums every tool
	 * round-trip's re-read context, while the last call is what the context
	 * holds now — the number Pi's footer and compaction read.
	 */
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const count = (value: unknown): number => (typeof value === "number" ? value : 0);

/**
 * PRD-051: `claude --model opus` runs an alias, and only the result names the
 * model behind it — `modelUsage` is keyed by the full id.
 */
function claudeRunFacts(stdout: string): CliRunFacts | undefined {
	const result = parseObject(stdout.trim());
	const models = result?.modelUsage;
	if (models === null || typeof models !== "object") return undefined;
	const facts: CliRunFacts = {
		models: Object.entries(models as Record<string, { outputTokens?: unknown; contextWindow?: unknown }>).map(([id, entry]) => ({
			id,
			output: count(entry?.outputTokens),
			...(typeof entry?.contextWindow === "number" ? { contextWindow: entry.contextWindow } : {}),
		})),
	};
	const total = result?.usage as { iterations?: unknown } & Record<string, unknown> | undefined;
	const iterations = Array.isArray(total?.iterations) ? (total.iterations as Record<string, unknown>[]) : [];
	const last = iterations.at(-1) ?? total;
	if (last) {
		facts.usage = { input: count(last.input_tokens), output: count(last.output_tokens), cacheRead: count(last.cache_read_input_tokens), cacheWrite: count(last.cache_creation_input_tokens) };
	}
	return facts;
}

export interface HarnessDescriptor {
	vendor: HarnessVendor;
	/** Executable name looked up on PATH when the config sets no `command`. */
	defaultCommand: string;
	/** Documented non-interactive argv for this vendor. */
	argv(context: HarnessArgvContext): string[];
	/** `true` when the vendor wants the schema as a file path rather than inline JSON. */
	schemaAsFile: boolean;
	/**
	 * Extra environment this packet needs. OpenCode exposes no per-run MCP flag, so
	 * its servers travel as an inline config through `OPENCODE_CONFIG_CONTENT`.
	 */
	env?(context: HarnessArgvContext): Record<string, string>;
	/** Parse one result envelope (single JSON object or JSONL events). */
	parse(stdout: string): ParsedHarnessEnvelope;
	/** Vendor's documented rate/quota signal, as a human reason; `null` when absent. */
	limitSignal(exitCode: number | null, stderr: string, stdout: string): string | null;
	/**
	 * Stderr after which the vendor would only retry forever: the run is killed
	 * there and judged by `limitSignal` like any other failed exit.
	 */
	stopWhen?(stderr: string): boolean;
}

/** Field paths to read out of each vendor's envelope; the parsers stay shared. */
interface EnvelopeKeys {
	session: string[];
	text: string[];
	structured: string[];
	error: string[];
}

function pickPath(event: Record<string, unknown>, path: string): unknown {
	let current: unknown = event;
	for (const key of path.split(".")) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

function firstString(event: Record<string, unknown>, paths: readonly string[]): string | undefined {
	for (const path of paths) {
		const value = pickPath(event, path);
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function firstValue(event: Record<string, unknown>, paths: readonly string[]): unknown {
	for (const path of paths) {
		const value = pickPath(event, path);
		if (value !== undefined && value !== null) return value;
	}
	return undefined;
}

function parseObject(text: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(text) as unknown;
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Read one vendor envelope. `--output-format json` emits a single object while
 * `--json` modes emit JSONL, so both are accepted; the last event that carries a
 * field wins, which is what a streamed run's final result is.
 */
function parseEnvelope(stdout: string, keys: EnvelopeKeys): ParsedHarnessEnvelope {
	const trimmed = stdout.trim();
	const events: Record<string, unknown>[] = [];
	const single = parseObject(trimmed);
	if (single) events.push(single);
	else {
		for (const line of trimmed.split("\n")) {
			const event = parseObject(line.trim());
			if (event) events.push(event);
		}
	}

	const envelope: ParsedHarnessEnvelope = { summary: "" };
	for (const event of events) {
		envelope.sessionId = firstString(event, keys.session) ?? envelope.sessionId;
		envelope.summary = firstString(event, keys.text) ?? envelope.summary;
		envelope.structured = firstValue(event, keys.structured) ?? envelope.structured;
		envelope.error = firstString(event, keys.error) ?? envelope.error;
	}
	// With `--json-schema` the structured payload arrives as a JSON string in the
	// result field rather than a dedicated object; only accept a parsed object.
	if (envelope.structured === undefined) {
		for (const event of events) {
			const parsed = parseMaybeJson(firstString(event, keys.text));
			if (parsed !== null && typeof parsed === "object") envelope.structured = parsed;
		}
	}
	return envelope;
}

function matchLimit(text: string, pattern: RegExp): string | null {
	const line = text.split("\n").find((candidate) => pattern.test(candidate));
	return line ? line.trim().slice(0, 300) : null;
}

const LIMIT_PATTERN = /usage limit|rate limit|quota|too many requests|\b429\b/i;

/** The §24 descriptor table; `argv` is the only place a vendor flag is spelled. */
export const HARNESS_DESCRIPTORS: Record<HarnessVendor, HarnessDescriptor> = {
	claude: {
		vendor: "claude",
		defaultCommand: "claude",
		schemaAsFile: false,
		argv: ({ packet, prompt, schema, env }) => [
			"-p",
			// `--bare` skips the vendor's own skill/plugin/MCP/CLAUDE.md discovery so
			// LeanPi's assembled context is not paid for twice (§24) — but it also
			// makes auth "strictly ANTHROPIC_API_KEY or apiKeyHelper (OAuth and
			// keychain are never read)", so on a Claude subscription every call
			// returned `Not logged in · Please run /login` and the backend was dead.
			// Verified against the installed CLI: with `--bare` and a subscription
			// login the request fails; without it the same prompt runs.
			//
			// What that costs, measured rather than assumed: `--strict-mcp-config`
			// and `--disable-slash-commands` replace the MCP and skill halves, but
			// hooks, LSP, auto-memory and CLAUDE.md discovery come back, so a worker
			// re-reads context LeanPi already assembled (§24's double pay — 2 KB of
			// CLAUDE.md + AGENTS.md in this repository, more in a large one). The two
			// alternatives were tried and both fail: `CLAUDE_CODE_SIMPLE=1` without
			// `--bare` is the same switch and returns `Not logged in`, and a
			// `--settings` JSON disabling hooks/memory still loaded CLAUDE.md
			// (verified: the model read a token planted there). A subscription login
			// cannot have `--bare`'s suppression; an API-key run can, and does.
			...((env ?? process.env).ANTHROPIC_API_KEY ? ["--bare"] : ["--strict-mcp-config", "--disable-slash-commands"]),
			// The role's model, when the config names one. Without it the vendor's
			// own configured default runs and the role map is decoration: `strong`
			// and `quick` would be the same model at the same price.
			...(packet.model ? ["--model", packet.model] : []),
			"--output-format",
			"json",
			"--allowedTools",
			[
				...(packet.allowedTools ?? Object.keys(CLAUDE_TOOL_NAMES)).map((tool) => CLAUDE_TOOL_NAMES[tool] ?? tool),
				// Claude names MCP tools the same way LeanPi does, so the selection is
				// spelled once. `--strict-mcp-config` keeps every other config out.
				...(packet.mcpServers ?? []).flatMap((server) => server.tools),
			].join(","),
			...(packet.mcpServers && packet.mcpServers.length > 0 ? ["--mcp-config", claudeMcpConfig(packet.mcpServers)] : []),
			...(schema ? ["--json-schema", schema] : []),
			...(packet.sessionId ? ["--resume", packet.sessionId] : []),
			// `--allowedTools` is variadic (`<tools...>`), so a prompt that follows it
			// is read as one more tool name and the CLI exits with "Input must be
			// provided either through stdin or as a prompt argument". Verified
			// against the installed CLI both ways. `--` ends option parsing.
			"--",
			prompt,
		],
		parse: (stdout) => {
			const envelope = parseEnvelope(stdout, {
				session: ["session_id", "sessionId"],
				text: ["result", "summary"],
				structured: ["structured_output", "structuredOutput", "structured"],
				error: ["error", "error_message"],
			});
			const run = claudeRunFacts(stdout);
			return run ? { ...envelope, run } : envelope;
		},
		limitSignal: (_exitCode, stderr, stdout) => matchLimit(`${stderr}\n${stdout}`, LIMIT_PATTERN),
	},
	codex: {
		vendor: "codex",
		defaultCommand: "codex",
		schemaAsFile: true,
		argv: ({ packet, prompt, schemaPath }) => [
			"exec",
			...(packet.sessionId ? ["resume", packet.sessionId] : []),
			// An explicit sandbox is mandatory: an unsandboxed vendor loop is not a
			// bounded job (FR-058).
			"--sandbox",
			"workspace-write",
			// Codex refuses to run outside a trusted directory — "Not inside a
			// trusted directory and --skip-git-repo-check was not specified" — and
			// every Codex worker invocation failed with exit 1 before reaching the
			// model. The trust question is Codex's own onboarding prompt, which a
			// non-interactive worker cannot answer; the boundary LeanPi relies on is
			// the explicit sandbox above (FR-058).
			"--skip-git-repo-check",
			"--json",
			...(packet.model ? ["--model", packet.model] : []),
			// Codex takes reasoning effort as a config override, not a flag. The
			// compiler decides it per turn from execution complexity
			// (`EFFORT_BY_COMPLEXITY`); without this the vendor's own
			// `model_reasoning_effort` — `xhigh` on the machine this was written on —
			// runs on every turn including the mechanical ones.
			...(packet.effort ? ["-c", `model_reasoning_effort="${packet.effort}"`] : []),
			// PRD-045: the allowed MCP servers, one override per field. Codex's MCP
			// table is `mcp_servers.<name>` in `config.toml`.
			...(packet.mcpServers ? codexMcpArgs(packet.mcpServers) : []),
			...(schemaPath ? ["--output-schema", schemaPath] : []),
			prompt,
		],
		parse: (stdout) =>
			parseEnvelope(stdout, {
				session: ["thread_id", "session_id", "sessionId"],
				text: ["item.text", "text", "message"],
				structured: ["structured", "structured_output", "item.structured"],
				error: ["error", "message"],
			}),
		limitSignal: (_exitCode, stderr, stdout) => matchLimit(`${stderr}\n${stdout}`, LIMIT_PATTERN),
	},
	opencode: {
		vendor: "opencode",
		defaultCommand: "opencode",
		schemaAsFile: false,
		// `opencode run` exposes no per-run MCP flag; the installed CLI merges
		// `OPENCODE_CONFIG_CONTENT` over its own config, which is the route.
		env: ({ packet }): Record<string, string> => (packet.mcpServers && packet.mcpServers.length > 0 ? { OPENCODE_CONFIG_CONTENT: opencodeMcpConfig(packet.mcpServers) } : {}),
		argv: ({ packet, prompt }) => [
			"run",
			"--format",
			"json",
			// Its only report of a provider 429 — `run` itself retries in silence.
			"--print-logs",
			"--log-level",
			"ERROR",
			...(packet.model ? ["--model", packet.model] : []),
			...(packet.agent ? ["--agent", packet.agent] : []),
			...(packet.sessionId ? ["--session", packet.sessionId] : []),
			prompt,
		],
		parse: (stdout) =>
			parseEnvelope(stdout, {
				session: ["sessionID", "session_id", "sessionId"],
				text: ["part.text", "text", "message"],
				structured: ["structured", "structured_output", "part.structured"],
				error: ["error"],
			}),
		limitSignal: (_exitCode, stderr, stdout) => matchLimit(`${stderr}\n${stdout}`, LIMIT_PATTERN),
		// A rate-limited main agent (`small=false`; the title agent's own give-up is
		// not the turn's) is retried with no end: the Manual turn sat on "Thinking…".
		stopWhen: (stderr) => /message="stream error"[^\n]*small=false[^\n]*error\.error="[^"\n]*(?:usage limit|rate limit|too many requests|\b429\b)/i.test(stderr),
	},
};

export interface HarnessSpawnRequest {
	command: string;
	args: string[];
	cwd: string;
	stdin: string | null;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	/** Kills the process group when aborted — Esc on a Manual turn (PRD-051). */
	signal?: AbortSignal;
	/** Kills the process group once stderr satisfies it (`HarnessDescriptor.stopWhen`). */
	stopWhen?: (stderr: string) => boolean;
}

export interface HarnessSpawnResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	error: Error | null;
	timedOut: boolean;
}

export type HarnessSpawn = (request: HarnessSpawnRequest) => Promise<HarnessSpawnResult>;

/**
 * Spawn with the inherited environment and nothing added. That inheritance is
 * deliberate: a vendor CLI authenticates from its own environment (OAuth token,
 * API key, config path), and the guarded `execute` tool's allowlist (PRD-017) is
 * not applied here. `request.env` is `process.env` by construction in
 * `runHarness`; LeanPi adds no variable of its own.
 */
export const spawnProcess: HarnessSpawn = async (request) => {
	const child = spawn(request.command, request.args, {
		cwd: request.cwd,
		env: request.env,
		stdio: ["pipe", "pipe", "pipe"],
		// Its own process group, so a timeout can reap descendants too: without it
		// only the direct child dies and a vendor CLI's children are left running.
		detached: true,
	});
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
	child.stdin.on("error", () => {});
	child.stdin.end(request.stdin ?? "");
	const terminate = (): void => {
		const pid = child.pid;
		// `kill(-1)` broadcasts to every signalable process the user owns, so only an
		// owned PID > 1 may be signalled; an invalid/reserved PID reaches neither
		// `process.kill` nor `child.kill`. Mirrors `execShell`'s teardown.
		if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return;
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
	};
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
		if (request.stopWhen?.(stderr)) terminate();
	});
	const timer = setTimeout(() => {
		timedOut = true;
		terminate();
	}, request.timeoutMs);
	if (request.signal?.aborted) terminate();
	request.signal?.addEventListener("abort", terminate, { once: true });
	try {
		// `once` rejects on the child's `error` event (a spawn failure) and resolves
		// with the exit code once the process is gone.
		const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
		return { code, signal, stdout, stderr, error: null, timedOut };
	} catch (error) {
		return { code: null, signal: null, stdout, stderr, error: error as Error, timedOut };
	} finally {
		clearTimeout(timer);
		request.signal?.removeEventListener("abort", terminate);
	}
};

export interface RunHarnessDeps {
	cwd: string;
	/** Test seam: the stub CLI records argv/env instead of running a real vendor. */
	spawn?: HarnessSpawn;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function isJsonSchemaType(value: unknown): boolean {
	if (typeof value === "string") return true;
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Minimal JSON Schema check (type/required/properties/items/enum/const), enough
 * for the packet's result contract without taking on a validator dependency.
 * Returns a failure message, or `null` when the value conforms.
 */
export function validateJsonSchema(schema: unknown, value: unknown, path = "$"): string | null {
	if (schema === null || typeof schema !== "object") return null;
	const node = schema as Record<string, unknown>;
	if (node.enum !== undefined) {
		if (!Array.isArray(node.enum) || !node.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
			return `${path} is not one of the enumerated values`;
		}
	}
	if (node.const !== undefined && JSON.stringify(node.const) !== JSON.stringify(value)) {
		return `${path} must equal ${JSON.stringify(node.const)}`;
	}
	if (node.type !== undefined && isJsonSchemaType(node.type)) {
		const types = (Array.isArray(node.type) ? node.type : [node.type]) as string[];
		const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
		const matches = types.some((type) =>
			type === actual || (type === "integer" && typeof value === "number" && Number.isInteger(value)),
		);
		if (!matches) return `${path} must be ${types.join(" | ")}, got ${actual}`;
	}
	if (Array.isArray(node.required) && value !== null && typeof value === "object" && !Array.isArray(value)) {
		for (const key of node.required) {
			if (typeof key === "string" && !(key in (value as Record<string, unknown>))) return `${path} is missing required key "${key}"`;
		}
	}
	if (node.properties !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)) {
		const properties = node.properties as Record<string, unknown>;
		for (const [key, sub] of Object.entries(properties)) {
			const child = (value as Record<string, unknown>)[key];
			if (child === undefined) continue;
			const failure = validateJsonSchema(sub, child, `${path}.${key}`);
			if (failure) return failure;
		}
	}
	if (node.items !== undefined && Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			const failure = validateJsonSchema(node.items, item, `${path}[${index}]`);
			if (failure) return failure;
		}
	}
	return null;
}

function failureReason(exitCode: number | null, stderr: string, envelope: ParsedHarnessEnvelope): string {
	const text = envelope.error ?? stderr.trim().split("\n").slice(-3).join(" ").trim();
	const detail = text.length > 0 ? text : "no vendor diagnostic";
	return `exit ${exitCode ?? "signal"}: ${detail.slice(0, 300)}`;
}

/**
 * Run one external harness worker. Never throws: a spawn error, a timeout, a
 * vendor limit, a non-zero exit, an unparseable envelope or a schema violation
 * all become a typed `WorkerFailure` the caller falls back from (FR-046).
 */
export async function runHarness(backend: RegisteredBackend, packet: WorkerTaskPacket, deps: RunHarnessDeps): Promise<WorkerOutcome> {
	const descriptor = HARNESS_DESCRIPTORS[backend.vendor as HarnessVendor];
	if (!descriptor) {
		return { status: "failed", failure: "spawn", reason: `backend "${backend.name}" has no harness descriptor` };
	}
	// `default` is the config's way of saying "this vendor names no model, let
	// its CLI choose" (see `cli/allocate.ts`); passing it as an id would make the
	// vendor look up a model called "default" and fail.
	if (packet.model === VENDOR_MODEL_DEFAULT) {
		const { model: _ignored, ...rest } = packet;
		packet = rest;
	}
	const spawnImpl = deps.spawn ?? spawnProcess;
	const before = changeSnapshot(deps.cwd);
	const prompt = packet.prompt ?? packet.objective;
	const schema = packet.outputSchema;
	const schemaJson = schema ? JSON.stringify(schema) : undefined;

	let schemaDir: string | null = null;
	let schemaPath: string | undefined;
	if (schema && descriptor.schemaAsFile) {
		try {
			schemaDir = mkdtempSync(join(tmpdir(), "leanpi-schema-"));
			schemaPath = join(schemaDir, "result.schema.json");
			writeFileSync(schemaPath, schemaJson as string);
		} catch (error) {
			return { status: "failed", failure: "schema", reason: `could not stage the output schema: ${(error as Error).message}` };
		}
	}

	try {
		const args = descriptor.argv({ packet, prompt, schema: schemaJson, schemaPath, env: deps.env ?? process.env });
		const extraEnv = descriptor.env?.({ packet, prompt, schema: schemaJson, schemaPath, env: deps.env ?? process.env }) ?? {};
		const result = await spawnImpl({
			command: backend.command,
			args,
			cwd: deps.cwd,
			// The vendor CLI reads its prompt from argv; stdin is closed empty so a
			// CLI that accepts both never waits on a terminal.
			stdin: null,
			// Inherited verbatim and deliberately: the vendor CLI may need its own
			// credential from the environment, and LeanPi adds no variable of its own
			// beyond the per-vendor config a route like OpenCode's requires. With no
			// extra config the parent's own object crosses untouched.
			env: Object.keys(extraEnv).length === 0 ? (deps.env ?? process.env) : { ...(deps.env ?? process.env), ...extraEnv },
			timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			...(deps.signal ? { signal: deps.signal } : {}),
			...(descriptor.stopWhen ? { stopWhen: descriptor.stopWhen } : {}),
		});
		if (deps.signal?.aborted) return { status: "failed", failure: "exit", reason: "aborted", exitCode: result.code };

		if (result.error) {
			const reason =
				(result.error as NodeJS.ErrnoException).code === "ENOENT"
					? `command not found: ${backend.command}`
					: result.error.message;
			return { status: "failed", failure: "spawn", reason };
		}
		if (result.timedOut) {
			return {
				status: "failed",
				failure: "timeout",
				reason: `${backend.command} exceeded ${deps.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
				exitCode: result.code,
			};
		}
		const envelope = descriptor.parse(result.stdout);
		// A successful run's stdout is the vendor's answer, not a diagnostic: a
		// task that merely mentions "rate limit" or a `src/api.ts:429` line must
		// not be classified as the vendor being limited. Only the envelope's own
		// `error` field can make an exit-0 run a limit; stdout-wide scanning stays
		// for non-zero exits, where it is the failing run's diagnostic.
		const limit =
			result.code === 0
				? descriptor.limitSignal(result.code, envelope.error ?? "", "")
				: descriptor.limitSignal(result.code, result.stderr, result.stdout);
		if (limit) {
			return { status: "failed", failure: "limit", reason: limit, exitCode: result.code };
		}

		if (result.code !== 0 && result.code !== null) {
			return {
				status: "failed",
				failure: "exit",
				reason: failureReason(result.code, result.stderr, envelope),
				exitCode: result.code,
				sessionId: envelope.sessionId,
			};
		}
		if (envelope.sessionId === undefined && envelope.summary.length === 0 && envelope.error === undefined) {
			return {
				status: "failed",
				failure: "parse",
				reason: `${backend.command} produced no parsable result envelope`,
				exitCode: result.code,
			};
		}
		if (envelope.error !== undefined && envelope.structured === undefined) {
			return {
				status: "failed",
				failure: "exit",
				reason: `exit ${result.code ?? "signal"}: ${envelope.error.slice(0, 300)}`,
				exitCode: result.code,
			};
		}
		if (schema) {
			if (envelope.structured === undefined) {
				return {
					status: "failed",
					failure: "schema",
					reason: `${backend.command} returned no structured output for the requested schema`,
					exitCode: result.code,
					sessionId: envelope.sessionId,
				};
			}
			const violation = validateJsonSchema(schema, envelope.structured);
			if (violation) {
				return {
					status: "failed",
					failure: "schema",
					reason: `structured output violates the schema: ${violation}`,
					exitCode: result.code,
					sessionId: envelope.sessionId,
				};
			}
		}

		const changed = before === null ? null : changedPathsSince(before, deps.cwd);
		return {
			status: "ok",
			changedFiles: changed ?? [],
			...(changed === null ? { changedFilesUnknown: true } : {}),
			summary: envelope.summary.length > 0 ? envelope.summary : `${descriptor.vendor} completed without a summary`,
			...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}),
			...(envelope.run ? { run: envelope.run } : {}),
			raw: { vendor: descriptor.vendor, argv: args, structured: envelope.structured },
		};
	} finally {
		if (schemaDir) rmSync(schemaDir, { recursive: true, force: true });
	}
}
