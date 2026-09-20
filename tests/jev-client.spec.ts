/**
 * PRD-002 Phase 1 — AC-1 and AC-2.
 *
 * One batched request per decision point, typed results in question order, and
 * a JEV client the executor cannot reach.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSites,
	createJevClient,
	loadConfig,
	registerSite,
	readDecisions,
	UnknownSiteError,
	type JevQuestion,
	type JevResult,
} from "../src/index.js";
import { bootSession, fixtureRepo, nativeBackend, tempDir, toolNamesOf, writeConfig } from "./helpers/fixtures.js";
import { startStubBackend } from "./helpers/stub-backend.js";
import { requestsForQuestion, startStubJev, type StubJev } from "./helpers/stub-jev.js";

const QUESTIONS: JevQuestion[] = [
	{ id: "route", kind: "Choice", text: "Which route?", options: { quick: "cheap", strong: "expensive" } },
	{ id: "burden", kind: "Score", text: "How hard is this?", levels: ["trivial", "easy", "moderate", "hard"] },
	{ id: "needs_review", kind: "Noul", text: "Does this need review?" },
];

function jevConfig(cwd: string, endpoint: string) {
	return loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { quick: { backend: "local", model: "m" } },
		jev: { endpoint, apiKey: "test-key", model: "jev-latest", mode: "enabled" },
	});
}

describe("PRD-002 Phase 1 — typed batched client", () => {
	let stub: StubJev;
	let cwd: string;

	beforeEach(async () => {
		clearSites();
		stub = await startStubJev();
		cwd = tempDir("leanpi-jev-");
	});

	afterEach(async () => {
		clearSites();
		await stub.close();
	});

	it("AC-1: three atomic questions resolve in exactly one request, in order, with matching discriminants", async () => {
		registerSite({
			id: "fixture.three",
			questions: QUESTIONS,
			returnType: ["Choice", "Score", "Noul"],
			consequence: "normal",
			telemetryTag: "fixture.three",
			fallback: ({ questions: asked }) =>
				asked.map((question): JevResult => {
					if (question.kind === "Choice") return { kind: "Choice", questionId: question.id, choice: "quick", probabilities: {}, confidence: 1 };
					if (question.kind === "Score") return { kind: "Score", questionId: question.id, score: 0, legend: {}, confidence: 1 };
					return { kind: "Noul", questionId: question.id, value: 0, confidence: 1 };
				}),
		});

		const client = createJevClient({ config: jevConfig(cwd, stub.url), cwd });
		const results = await client.ask("fixture.three", QUESTIONS, { task: "change a button label" });

		expect(stub.requests).toHaveLength(1);
		const request = stub.requests[0]!;
		expect(request.url).toBe("/v1/systemone");
		expect(request.headers.authorization).toBe("Bearer test-key");
		expect(Object.keys(request.body.questions as object)).toEqual(["route", "burden", "needs_review"]);
		expect(request.body.state).toEqual({ task: "change a button label" });
		expect(request.body.model).toBe("jev-latest");

		expect(results.map((result) => result.kind)).toEqual(["Choice", "Score", "Noul"]);
		expect(results.map((result) => result.questionId)).toEqual(["route", "burden", "needs_review"]);
		expect((results[0] as Extract<JevResult, { kind: "Choice" }>).choice).toBe("quick");

		// The resolved site is recorded once, with the fields PRD-015 will aggregate.
		const rows = readDecisions(cwd);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.telemetryTag).toBe("fixture.three");
		expect(rows[0]!.fallbackUsed).toBe(false);
		expect(rows[0]!.tokens).toEqual({ inputTokens: 120, outputTokens: 8 });

		// An unregistered id never reaches the wire.
		await expect(client.ask("nope.not.registered", QUESTIONS, {})).rejects.toBeInstanceOf(UnknownSiteError);
		expect(stub.requests).toHaveLength(1);
	});

	it("AC-2: JEV is unreachable from the executor", async () => {
		const agentBackend = await startStubBackend([
			{ toolCalls: [{ name: "jev", args: { site: "gate.prd_required" } }] },
			{ text: "done" },
		]);
		const { cwd: repo, agentDir } = fixtureRepo();
		writeConfig(repo, {
			backends: { local: nativeBackend(agentBackend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			jev: { endpoint: stub.url, apiKey: "test-key" },
		});

		const session = await bootSession({ cwd: repo, agentDir });
		expect(session.activation.tools).toEqual(["read", "search", "edit", "write", "execute"]);

		// Every tool the session offers is enumerated and none of them is JEV-backed.
		expect(toolNamesOf(agentBackend.requests[0]?.body ?? {})).toEqual([]);
		await session.runTurn("try to call jev");
		const offered = toolNamesOf(agentBackend.requests[0]!.body);
		// AC-2's claim is the absence of a JEV tool, not the exact surface: the
		// baseline five must be offered and nothing named `jev*` may be.
		expect(offered).toEqual(expect.arrayContaining(["edit", "execute", "read", "search", "write"]));
		expect(offered.some((name) => name.startsWith("jev"))).toBe(false);

		// The fabricated call is rejected as an unknown tool. The compiler asks the
		// gate site itself on every native turn, so the count is one *more* thing the
		// executor did not cause: exactly one gate ask for the turn, none from the tool.
		const secondRequest = JSON.stringify(agentBackend.requests[1]!.body);
		expect(secondRequest).toMatch(/unknown tool|not found|Unknown tool/i);
		expect(requestsForQuestion(stub.requests, "architecture")).toHaveLength(1);
		expect(session.jev.fallbackCount()).toBe(0);

		session.session.dispose();
		await agentBackend.close();
	});
});
