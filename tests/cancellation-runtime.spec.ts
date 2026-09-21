/**
 * PRD-029 runtime audit: what actually happens when the user cancels.
 *
 * The prior audit recorded "the extension never observes Pi's Ctrl-C" as a gap.
 * This spec drives the real installed SDK session (`createLeanPiSession`) against
 * a fake local model and a deferred JEV transport, so the claim is measured, not
 * inferred from a missing event. Two phases are distinguished:
 *
 *  - **Deferred JEV preparation** (before the agent loop starts): `prompt()`
 *    awaits `before_agent_start`, so `agent.signal` does not exist yet and
 *    `session.abort()` sees an idle agent. The stop action here is SDK-bounded.
 *  - **Model running** (streaming): the agent owns an AbortSignal and
 *    `session.abort()` aborts the stream, which is Pi's own behaviour.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLeanPiSession, loadConfig, type LeanPiSession } from "../src/index.js";
import { startStubBackend, type StubBackend } from "./helpers/stub-backend.js";
import type { JevTransport } from "../src/jev/client.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

/** Config that makes Pi's own loop the executor (native backend). */
function nativeConfig(cwd: string, baseUrl: string, extra: Record<string, unknown> = {}) {
	return loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl, api: "openai-completions", apiKey: "sk-stub" } },
		models: {
			quick: { backend: "local", model: "cheap" },
			balanced: { backend: "local", model: "cheap" },
			strong: { backend: "local", model: "cheap" },
		},
		jev: { endpoint: "http://127.0.0.1:1/v1/systemone", apiKey: "test-key", model: "jev-latest", mode: "enabled" },
		lsp: { mode: "off" },
		...extra,
	});
}

/** A backend that writes SSE headers and one chunk, then holds the socket open. */
async function slowBackend(): Promise<{ baseUrl: string; closed: () => boolean; close: () => Promise<void>; requests: () => number }> {
	let clientClosed = false;
	let requests = 0;
	const server: Server = createServer((req, res) => {
		requests += 1;
		req.on("data", () => {});
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write(
				`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "cheap", choices: [{ index: 0, delta: { role: "assistant", content: "partial" }, finish_reason: null }] })}\n\n`,
			);
			res.on("close", () => {
				clientClosed = true;
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		closed: () => clientClosed,
		requests: () => requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

const sessions: LeanPiSession[] = [];
const backends: Array<{ close(): Promise<void> }> = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) session.session.dispose();
	for (const backend of backends.splice(0)) await backend.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function boot(baseUrl: string, jevTransport: JevTransport, extraConfig: Record<string, unknown> = {}): Promise<{ session: LeanPiSession; cwd: string }> {
	const root = mkdtempSync(join(tmpdir(), "leanpi-cancel-"));
	dirs.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const env = { HOME: join(root, "home"), PATH: "", XDG_CONFIG_HOME: join(root, "xdg") };
	const session = await createLeanPiSession({ cwd, agentDir, env, config: nativeConfig(cwd, baseUrl, extraConfig), jevTransport });
	sessions.push(session);
	return { session, cwd };
}

describe("PRD-029 runtime cancellation (real SDK session)", () => {
	it("a cancelled deferred JEV preparation cannot stop the model the awaited preflight then starts", async () => {
		const backend: StubBackend = await startStubBackend([{ text: "answer" }]);
		backends.push(backend);

		const entered = deferred();
		const release = deferred();
		let healthy = false;
		const transport: JevTransport = async (): Promise<{ status: number; text: string }> => {
			if (healthy) return { status: 500, text: "healthy-after" };
			entered.resolve();
			await release.promise;
			return { status: 500, text: "late" };
		};

		const { session } = await boot(backend.baseUrl, transport);
		const prompt = session.session.prompt("say hello");
		await entered.promise;

		// The documented stop action, exactly as Pi's Escape handler reaches it.
		expect(session.session.isStreaming).toBe(false);
		await session.session.abort();

		release.resolve();
		await prompt;

		// The model request still happened: during preflight there is no agent
		// signal for the abort to reach. This is the installed-SDK boundary, not a
		// LeanPi lane that failed to check a signal.
		expect(backend.requests.length).toBeGreaterThan(0);

		// The session survives: a later prompt on the same session answers.
		healthy = true;
		const before = backend.requests.length;
		await session.session.prompt("second prompt");
		expect(backend.requests.length).toBeGreaterThan(before);
	});

	it("aborting while the model is streaming closes the response and leaves the session usable", async () => {
		const backend = await slowBackend();
		backends.push(backend);
		// JEV answers unavailable immediately, so the compile does not defer.
		const { session } = await boot(backend.baseUrl, async () => ({ status: 500, text: "no-jev" }));

		const prompt = session.session.prompt("stream something");
		// Wait until the model request is actually in flight.
		for (let i = 0; i < 200 && backend.requests() === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
		expect(backend.requests()).toBeGreaterThan(0);

		await session.session.abort();
		await prompt;

		// Pi aborted the model stream: the backend saw the socket close.
		for (let i = 0; i < 100 && !backend.closed(); i += 1) await new Promise((r) => setTimeout(r, 5));
		expect(backend.closed()).toBe(true);
		expect(session.session.isIdle).toBe(true);
	}, 20_000);
});
