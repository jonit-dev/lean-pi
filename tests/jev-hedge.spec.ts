/**
 * A slow JEV replica must not hold the turn: every compile site sits between
 * the user's Enter and Pi drawing the message. A request still unanswered after
 * `JEV_HEDGE_MS` is sent again and the first answer wins, so the turn keeps
 * JEV's decision instead of waiting out the slow request or falling back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSites, createJevClient, loadConfig, registerSite, type JevQuestion, type JevTransportRequest, type JevTransportResponse } from "../src/index.js";
import { JEV_HEDGE_MS } from "../src/jev/client.js";
import type { ControlPlaneProvider } from "../src/jev/provider.js";
import { tempDir } from "./helpers/fixtures.js";

const QUESTIONS: JevQuestion[] = [{ id: "needs_review", kind: "Noul", text: "Does this need review?" }];
const ANSWER: JevTransportResponse = { status: 200, text: JSON.stringify({ answers: { needs_review: { type: "noul", noul: 0.92 } } }) };

function config(cwd: string) {
	return loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { quick: { backend: "local", model: "m" } },
		jev: { endpoint: "http://jev.test/v1/systemone", apiKey: "test-key", model: "jev-latest", mode: "enabled" },
	});
}

/** The first request hangs like the slow replica; every later one answers at once. */
function slowFirst(): { transport: (request: JevTransportRequest) => Promise<JevTransportResponse>; calls: () => number } {
	let calls = 0;
	return {
		transport: () => (++calls === 1 ? new Promise<JevTransportResponse>(() => {}) : Promise.resolve(ANSWER)),
		calls: () => calls,
	};
}

describe("JEV request hedging", () => {
	let cwd: string;

	beforeEach(() => {
		clearSites();
		cwd = tempDir("leanpi-jev-hedge-");
		registerSite({
			id: "fixture.hedge",
			questions: QUESTIONS,
			returnType: ["Noul"],
			consequence: "normal",
			telemetryTag: "fixture.hedge",
			fallback: () => [{ kind: "Noul", questionId: "needs_review", value: 0, confidence: 0 }],
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		clearSites();
	});

	it("a request unanswered after the hedge delay is re-sent and the first answer wins", async () => {
		const wire = slowFirst();
		const client = createJevClient({ config: config(cwd), cwd, transport: wire.transport });
		const pending = client.ask("fixture.hedge", QUESTIONS, {});
		await vi.advanceTimersByTimeAsync(JEV_HEDGE_MS);
		const [result] = await pending;
		expect(wire.calls()).toBe(2);
		expect(client.fallbackCount()).toBe(0);
		expect(result).toMatchObject({ kind: "Noul", value: 0.92 });
	});

	it("a prompt answer sends exactly one request", async () => {
		let calls = 0;
		const client = createJevClient({ config: config(cwd), cwd, transport: () => (calls++, Promise.resolve(ANSWER)) });
		await client.ask("fixture.hedge", QUESTIONS, {});
		await vi.advanceTimersByTimeAsync(JEV_HEDGE_MS * 5);
		expect(calls).toBe(1);
	});

	it("a local Laya model is never hedged: a second request only doubles its load", async () => {
		const wire = slowFirst();
		const laya: ControlPlaneProvider = { name: "laya", source: "config", resolve: async () => ({ endpoint: "http://127.0.0.1:9/v1", key: "local", source: "config", model: "laya" }) };
		const client = createJevClient({ config: config(cwd), cwd, transport: wire.transport, provider: laya });
		void client.ask("fixture.hedge", QUESTIONS, {});
		await vi.advanceTimersByTimeAsync(JEV_HEDGE_MS * 5);
		expect(wire.calls()).toBe(1);
	});
});
