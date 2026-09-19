/**
 * The stdio LSP client (PRD-018 Phase 2, ROADMAP §18).
 *
 * JSON-RPC 2.0 over `Content-Length` framing, hand-rolled on `node:child_process`.
 * The ecosystem's `vscode-jsonrpc` / `vscode-languageserver-protocol` packages are
 * not dependencies of this package, and the frame grammar is a header plus one
 * length-prefixed JSON body — far less code than a vendored protocol surface.
 *
 * Lifecycle rules this module owns:
 * - one client per root+language, started lazily on first use and shut down with
 *   the session, so `LSP_OFF` provably spawns nothing;
 * - a spawn failure or a post-start crash is recorded once and turns the language
 *   unavailable for the rest of the session;
 * - every failure is an `LspUnavailableError` the caller can read, never a throw
 *   out of a tool call;
 * - a document's diagnostics are invalidated before `didChange` is sent, so a
 *   pre-edit result can never be replayed (the roadmap's staleness failure mode).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LeanPiConfig } from "../core/types.js";
import { lookupServer, type DetectOptions } from "./detect.js";

export class LspUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LspUnavailableError";
	}
}

export interface LspDiagnostic {
	file: string;
	/** 1-based line, as the executor reads it. */
	line: number;
	column: number;
	severity: number;
	message: string;
	code?: string | number;
}

export interface LspClientOptions {
	root: string;
	language: string;
	/** Absolute path of the resolved server executable. */
	command: string;
	args?: string[];
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
}

interface RawDiagnostic {
	range?: { start?: { line?: number; character?: number } };
	severity?: number;
	message?: string;
	code?: string | number;
}

interface IncomingMessage {
	id?: number;
	method?: string;
	result?: unknown;
	error?: { message?: string };
	params?: unknown;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DIAGNOSTICS_TIMEOUT_MS = 15_000;
const READINESS_TIMEOUT_MS = 10_000;

/** Process accounting, so "LSP_OFF spawns nothing" is measurable rather than assumed. */
export const lspProcessStats = { spawned: 0, live: 0 };

export class LspClient {
	readonly root: string;
	readonly language: string;
	readonly command: string;

	private readonly child: ChildProcessWithoutNullStreams;
	private readonly timeoutMs: number;
	private buffer: Buffer = Buffer.alloc(0);
	private nextId = 1;
	private version = 1;
	private stopped = false;
	private exitReason: string | null = null;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly diagnostics = new Map<string, LspDiagnostic[]>();
	private readonly publishes = new Map<string, number>();
	private readonly opened = new Map<string, string>();
	private readonly stderrTail: string[] = [];

	private constructor(options: LspClientOptions, child: ChildProcessWithoutNullStreams) {
		this.root = options.root;
		this.language = options.language;
		this.command = options.command;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.child = child;
		child.stdout.on("data", (chunk: Buffer) => this.ingest(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderrTail.push(chunk.toString("utf8"));
			if (this.stderrTail.length > 20) this.stderrTail.shift();
		});
		child.on("error", (error) => this.fail(`spawn error: ${error.message}`));
		child.on("exit", (code, signal) => {
			if (this.stopped) return;
			this.fail(`server exited (${signal ? `signal ${signal}` : `code ${code ?? "null"}`})`);
		});
	}

	/** Spawn + `initialize`/`initialized`. A failure here is recorded and thrown once. */
	static async open(options: LspClientOptions): Promise<LspClient> {
		const child = spawn(options.command, options.args ?? [], {
			cwd: options.root,
			env: options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		lspProcessStats.spawned += 1;
		lspProcessStats.live += 1;
		child.once("exit", () => {
			lspProcessStats.live -= 1;
		});
		const client = new LspClient(options, child);
		try {
			await client.request(
				"initialize",
				{
					processId: process.pid,
					clientInfo: { name: "leanpi" },
					rootUri: pathToFileURL(options.root).href,
					rootPath: options.root,
					workspaceFolders: [{ uri: pathToFileURL(options.root).href, name: basename(options.root) }],
					capabilities: {
						textDocument: {
							synchronization: { dynamicRegistration: false, willSave: false, didSave: false },
							publishDiagnostics: { relatedInformation: false },
							definition: {},
							references: {},
							hover: { contentFormat: ["markdown", "plaintext"] },
							documentSymbol: { hierarchicalDocumentSymbolSupport: true },
							callHierarchy: {},
						},
						workspace: { symbol: {}, configuration: true, workspaceFolders: true },
						window: { workDoneProgress: true },
					},
					initializationOptions: {},
				},
				options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			);
			client.notify("initialized", {});
			return client;
		} catch (error) {
			await client.shutdown();
			const detail = error instanceof Error ? error.message : "unknown";
			const stderr = client.stderrTail.join("").trim();
			throw new LspUnavailableError(stderr.length > 0 ? `${detail} — ${stderr.slice(0, 300)}` : detail);
		}
	}

	request<T = unknown>(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<T> {
		if (this.exitReason !== null) return Promise.reject(new LspUnavailableError(this.exitReason));
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new LspUnavailableError(`${this.language} server did not answer ${method} within ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (this.exitReason !== null) return;
		this.write({ jsonrpc: "2.0", method, params });
	}

	/**
	 * Opens (or re-syncs) a document and waits, bounded, until the server has
	 * published diagnostics for it. That publish is the observable "this document
	 * is loaded" signal a lazily started server gives us — navigation issued before
	 * it returns a partial program. A server that never publishes is not treated as
	 * broken: the request itself decides.
	 *
	 * ponytail: readiness is inferred from the first publish, not from a protocol
	 * handshake; a server that publishes late makes the first request slow rather
	 * than wrong. Upgrade to `$/progress` gating if a server appears that never
	 * publishes diagnostics.
	 */
	async ensureOpen(file: string, readyMs = READINESS_TIMEOUT_MS): Promise<void> {
		const state = await this.syncDocument(file);
		if (state.publishCount !== null) return;
		await this.waitForPublish(state.uri, state.count, readyMs).catch(() => undefined);
	}

	/**
	 * The current diagnostics for a file, requested rather than cached: any edit
	 * invalidates the stored result first and re-syncs the document, and the answer
	 * is the list the server publishes for the text just sent.
	 */
	async diagnosticsFor(file: string, waitMs = DIAGNOSTICS_TIMEOUT_MS): Promise<LspDiagnostic[]> {
		const before = await this.syncDocument(file);
		if (before.publishCount === null) await this.waitForPublish(before.uri, before.count, waitMs);
		return this.diagnostics.get(before.uri) ?? [];
	}

	private async syncDocument(file: string): Promise<{ uri: string; count: number; publishCount: number | null }> {
		const uri = pathToFileURL(file).href;
		const count = this.publishes.get(uri) ?? 0;
		const text = await readFile(file, "utf8");
		const previous = this.opened.get(uri);
		if (previous === undefined) {
			this.opened.set(uri, text);
			this.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.language, version: this.version, text } });
			return { uri, count, publishCount: null };
		}
		if (previous !== text) {
			// Staleness rule: the old result goes before the change does.
			this.diagnostics.delete(uri);
			this.version += 1;
			this.opened.set(uri, text);
			this.notify("textDocument/didChange", { textDocument: { uri, version: this.version }, contentChanges: [{ text }] });
			return { uri, count, publishCount: null };
		}
		return { uri, count, publishCount: count };
	}

	private async waitForPublish(uri: string, previousCount: number, waitMs: number): Promise<void> {
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline) {
			if (this.exitReason !== null) throw new LspUnavailableError(this.exitReason);
			if ((this.publishes.get(uri) ?? 0) > previousCount) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new LspUnavailableError(`${this.language} server published no diagnostics for ${fileURLToPath(uri)} within ${waitMs}ms`);
	}

	async shutdown(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		try {
			for (const uri of this.opened.keys()) this.notify("textDocument/didClose", { textDocument: { uri } });
			if (this.exitReason === null) {
				await this.request("shutdown", null, 2_000).catch(() => undefined);
				this.notify("exit", null);
			}
			await this.terminate();
		} finally {
			const reason = this.exitReason ?? `client for ${this.language} shut down`;
			this.fail(reason);
		}
	}

	private async terminate(): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		const exited = once(this.child, "exit");
		this.child.kill("SIGTERM");
		const killed = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]);
		if (!killed) this.child.kill("SIGKILL");
	}

	private fail(reason: string): void {
		if (this.exitReason === null) this.exitReason = reason;
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			this.pending.delete(id);
			entry.reject(new LspUnavailableError(reason));
		}
	}

	private write(message: Record<string, unknown>): void {
		try {
			const body = Buffer.from(JSON.stringify(message), "utf8");
			this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
			this.child.stdin.write(body);
		} catch (error) {
			this.fail(`could not write to the ${this.language} server: ${error instanceof Error ? error.message : "unknown"}`);
		}
	}

	private ingest(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				// Malformed header: skip it rather than desynchronise the stream.
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			const start = headerEnd + 4;
			if (this.buffer.length < start + length) return;
			const body = this.buffer.subarray(start, start + length).toString("utf8");
			this.buffer = this.buffer.subarray(start + length);
			let message: IncomingMessage;
			try {
				message = JSON.parse(body) as IncomingMessage;
			} catch {
				continue;
			}
			this.consume(message);
		}
	}

	private consume(message: IncomingMessage): void {
		if (message.id !== undefined && message.method === undefined) {
			const entry = this.pending.get(message.id);
			if (!entry) return;
			this.pending.delete(message.id);
			clearTimeout(entry.timer);
			if (message.error) entry.reject(new LspUnavailableError(`${this.language} server error: ${message.error.message ?? "unknown"}`));
			else entry.resolve(message.result);
			return;
		}
		if (message.id !== undefined && message.method !== undefined) {
			// Server → client request. Answering keeps the server from blocking on us.
			this.write({ jsonrpc: "2.0", id: message.id, result: message.method === "workspace/configuration" ? [] : null });
			return;
		}
		if (message.method !== "textDocument/publishDiagnostics") return;
		const params = message.params as { uri?: string; diagnostics?: RawDiagnostic[] } | undefined;
		if (!params?.uri) return;
		let file = params.uri;
		try {
			file = fileURLToPath(params.uri);
		} catch {
			// A non-file URI keeps its URI form; the file column is informational.
		}
		this.diagnostics.set(
			params.uri,
			(params.diagnostics ?? []).map((diagnostic) => ({
				file,
				line: (diagnostic.range?.start?.line ?? 0) + 1,
				column: (diagnostic.range?.start?.character ?? 0) + 1,
				severity: diagnostic.severity ?? 1,
				message: diagnostic.message ?? "",
				...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
			})),
		);
		this.publishes.set(params.uri, (this.publishes.get(params.uri) ?? 0) + 1);
	}
}

/** A resolved client, or the reason there is none. */
export type ClientLookup = { ok: true; client: LspClient } | { ok: false; reason: string };

const clients = new Map<string, Promise<ClientLookup>>();
/** Languages that failed this session; recorded once, never retried. */
const failed = new Map<string, string>();

export interface GetClientOptions extends DetectOptions {
	timeoutMs?: number;
}

/**
 * The lazy entry point: only a tool handler calls this, never selection or
 * session startup, so `LSP_OFF` cannot spawn a server by construction.
 */
export function getClient(root: string, language: string, options: GetClientOptions = {}): Promise<ClientLookup> {
	const key = `${root}\0${language}`;
	const failure = failed.get(key);
	if (failure !== undefined) return Promise.resolve({ ok: false, reason: failure });
	const existing = clients.get(key);
	if (existing) return existing;
	const started = (async (): Promise<ClientLookup> => {
		const lookup = lookupServer(root, language, options);
		if (!lookup.ok) return lookup;
		try {
			const client = await LspClient.open({
				root,
				language,
				command: lookup.server.path,
				args: lookup.server.args,
				...(options.env ? { env: options.env } : {}),
				...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
			});
			return { ok: true, client };
		} catch (error) {
			const detail = error instanceof Error ? error.message : "unknown";
			const reason = `language server ${lookup.server.path} failed to start: ${detail}`;
			failed.set(key, reason);
			clients.delete(key);
			return { ok: false, reason };
		}
	})();
	clients.set(key, started);
	return started;
}

/** Session teardown: every server this session started goes away with it. */
export async function closeLspClients(): Promise<void> {
	const open = [...clients.values()];
	clients.clear();
	failed.clear();
	const lookups = await Promise.all(open.map((pending) => pending.catch(() => ({ ok: false as const, reason: "closed" }))));
	await Promise.all(lookups.map((lookup) => (lookup.ok ? lookup.client.shutdown() : Promise.resolve())));
}
