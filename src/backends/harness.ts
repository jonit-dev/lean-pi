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
import type { RegisteredBackend } from "./registry.js";
import {
	changedFilesSince,
	parseMaybeJson,
	snapshotFiles,
	type WorkerOutcome,
	type WorkerTaskPacket,
} from "./worker.js";

export const HARNESS_VENDORS = ["claude", "codex", "opencode"] as const;

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

export interface HarnessArgvContext {
	packet: WorkerTaskPacket;
	prompt: string;
	/** JSON Schema string form (Claude takes the schema inline). */
	schema?: string;
	/** Schema file path (Codex takes a file). */
	schemaPath?: string;
}

export interface ParsedHarnessEnvelope {
	sessionId?: string;
	summary: string;
	/** The vendor's structured payload; validated against the packet's schema. */
	structured?: unknown;
	error?: string;
}

export interface HarnessDescriptor {
	vendor: HarnessVendor;
	/** Executable name looked up on PATH when the config sets no `command`. */
	defaultCommand: string;
	/** Documented non-interactive argv for this vendor. */
	argv(context: HarnessArgvContext): string[];
	/** `true` when the vendor wants the schema as a file path rather than inline JSON. */
	schemaAsFile: boolean;
	/** Parse one result envelope (single JSON object or JSONL events). */
	parse(stdout: string): ParsedHarnessEnvelope;
	/** Vendor's documented rate/quota signal, as a human reason; `null` when absent. */
	limitSignal(exitCode: number | null, stderr: string, stdout: string): string | null;
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
		argv: ({ packet, prompt, schema }) => [
			"-p",
			// `--bare` skips the vendor's own skill/plugin/MCP/CLAUDE.md discovery so
			// LeanPi's assembled context is not paid for twice (§24).
			"--bare",
			"--output-format",
			"json",
			"--allowedTools",
			(packet.allowedTools ?? Object.keys(CLAUDE_TOOL_NAMES)).map((tool) => CLAUDE_TOOL_NAMES[tool] ?? tool).join(","),
			...(schema ? ["--json-schema", schema] : []),
			...(packet.sessionId ? ["--resume", packet.sessionId] : []),
			prompt,
		],
		parse: (stdout) =>
			parseEnvelope(stdout, {
				session: ["session_id", "sessionId"],
				text: ["result", "summary"],
				structured: ["structured_output", "structuredOutput", "structured"],
				error: ["error", "error_message"],
			}),
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
			"--json",
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
		argv: ({ packet, prompt }) => [
			"run",
			"--format",
			"json",
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
	},
};

export interface HarnessSpawnRequest {
	command: string;
	args: string[];
	cwd: string;
	stdin: string | null;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
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
 * Spawn with the inherited environment and nothing added — the whole credential
 * story of this PRD is `env: request.env`, where `request.env` is `process.env`
 * by construction in `runHarness`.
 */
export const spawnProcess: HarnessSpawn = async (request) => {
	const child = spawn(request.command, request.args, {
		cwd: request.cwd,
		env: request.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
	child.stdin.on("error", () => {});
	child.stdin.end(request.stdin ?? "");
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, request.timeoutMs);
	try {
		// `once` rejects on the child's `error` event (a spawn failure) and resolves
		// with the exit code once the process is gone.
		const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
		return { code, signal, stdout, stderr, error: null, timedOut };
	} catch (error) {
		return { code: null, signal: null, stdout, stderr, error: error as Error, timedOut };
	} finally {
		clearTimeout(timer);
	}
};

export interface RunHarnessDeps {
	cwd: string;
	/** Test seam: the stub CLI records argv/env instead of running a real vendor. */
	spawn?: HarnessSpawn;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
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
	const spawnImpl = deps.spawn ?? spawnProcess;
	const files = packet.files ?? [];
	const before = snapshotFiles(deps.cwd, files);
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
		const args = descriptor.argv({ packet, prompt, schema: schemaJson, schemaPath });
		const result = await spawnImpl({
			command: backend.command,
			args,
			cwd: deps.cwd,
			// The vendor CLI reads its prompt from argv; stdin is closed empty so a
			// CLI that accepts both never waits on a terminal.
			stdin: null,
			// Inherited verbatim: LeanPi adds no variable, so no credential crosses it.
			env: deps.env ?? process.env,
			timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		});

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
		const limit = descriptor.limitSignal(result.code, result.stderr, result.stdout);
		if (limit) {
			return { status: "failed", failure: "limit", reason: limit, exitCode: result.code };
		}

		const envelope = descriptor.parse(result.stdout);
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

		const changed = changedFilesSince(before, deps.cwd, files);
		return {
			status: "ok",
			changedFiles: changed,
			summary: envelope.summary.length > 0 ? envelope.summary : `${descriptor.vendor} completed without a summary`,
			...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}),
			raw: { vendor: descriptor.vendor, argv: args, structured: envelope.structured },
		};
	} finally {
		if (schemaDir) rmSync(schemaDir, { recursive: true, force: true });
	}
}
