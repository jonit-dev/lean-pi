/**
 * PRD-002 Phase 2 — AC-3 and AC-4: the decision-site registry and the log.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearLanes,
	clearSites,
	getSite,
	listSites,
	readDecisions,
	registerLane,
	registerSite,
	UnknownSiteError,
	type JevQuestion,
	type JevResult,
} from "../src/index.js";
import { bootSession, fixtureRepo, nativeBackend, writeConfig } from "./helpers/fixtures.js";
import { startStubBackend } from "./helpers/stub-backend.js";
import { startStubJev, typedAnswers, type StubJev } from "./helpers/stub-jev.js";

const QUESTIONS: JevQuestion[] = [
	{ id: "gate", kind: "Choice", text: "Needs a PRD?", options: { yes: "structured", no: "direct" } },
	{ id: "confidence", kind: "Noul", text: "Is the answer clear?" },
];

function fallbackFor(questions: JevQuestion[]): JevResult[] {
	return questions.map((question) =>
		question.kind === "Choice"
			? { kind: "Choice", questionId: question.id, choice: "no", probabilities: {}, confidence: 1 }
			: { kind: "Noul", questionId: question.id, value: 0, confidence: 1 },
	);
}

describe("PRD-002 Phase 2 — registry and decision log", () => {
	let stub: StubJev;
	let openBackends: Array<{ close(): Promise<void> }>;

	beforeEach(async () => {
		clearSites();
		clearLanes();
		stub = await startStubJev();
		openBackends = [];
	});

	afterEach(async () => {
		clearLanes();
		clearSites();
		await stub.close();
		for (const backend of openBackends) await backend.close();
	});

	it("AC-3: every site is enumerable with a non-null fallback, and a null fallback aborts startup", async () => {
		registerSite({
			id: "fixture.gate",
			questions: QUESTIONS,
			returnType: ["Choice", "Noul"],
			consequence: "high",
			telemetryTag: "gate.prd_required",
			fallback: ({ questions }) => fallbackFor(questions),
		});

		const agentBackend = await startStubBackend([{ text: "ok" }]);
		openBackends.push(agentBackend);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(agentBackend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			jev: { endpoint: stub.url, apiKey: "test-key" },
		});

		const session = await bootSession({ cwd, agentDir });
		const sites = session.jev.sites();
		expect(sites).toHaveLength(1);
		const site = sites[0]!;
		expect(site.id).toBe("fixture.gate");
		expect(site.questions.map((question) => question.id)).toEqual(["gate", "confidence"]);
		expect(site.returnType).toEqual(["Choice", "Noul"]);
		expect(site.consequence).toBe("high");
		expect(site.telemetryTag).toBe("gate.prd_required");
		expect(typeof site.fallback).toBe("function");
		expect(getSite("fixture.gate")).toBe(site);

		// A site shipped without a fallback cannot start the harness (§49).
		expect(() =>
			registerSite({
				id: "fixture.no-fallback",
				questions: QUESTIONS,
				returnType: ["Choice", "Noul"],
				consequence: "low",
				telemetryTag: "fixture.no-fallback",
				fallback: null as unknown as () => JevResult[],
			}),
		).toThrowError(/fixture\.no-fallback/);
		expect(() => registerSite({ ...site })).toThrowError(/already registered/);
		expect(listSites()).toHaveLength(1);

		// An unregistered id issues no request.
		await expect(session.jev.ask("fixture.absent", QUESTIONS, {})).rejects.toBeInstanceOf(UnknownSiteError);
		expect(stub.requests).toHaveLength(0);

		session.session.dispose();
	});

	it("AC-4: a fixture task resolving two sites writes exactly two complete log rows", async () => {
		const siteIds = ["fixture.first", "fixture.second"];
		for (const id of siteIds) {
			registerSite({
				id,
				questions: QUESTIONS,
				returnType: ["Choice", "Noul"],
				consequence: "normal",
				telemetryTag: `${id}.tag`,
				fallback: ({ questions }) => fallbackFor(questions),
			});
		}

		const agentBackend = await startStubBackend([{ text: "ok" }]);
		openBackends.push(agentBackend);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(agentBackend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			jev: { endpoint: stub.url, apiKey: "test-key" },
		});

		const session = await bootSession({ cwd, agentDir });
		registerLane({
			name: "fixture-lane",
			async run(_turn) {
				for (const id of siteIds) await session.jev.ask(id, QUESTIONS, { task: "fixture" });
			},
		});
		await session.runTurn("resolve two sites");

		const rows = readDecisions(cwd);
		expect(rows).toHaveLength(2);
		for (const [index, row] of rows.entries()) {
			expect(row.siteId).toBe(siteIds[index]);
			expect(row.telemetryTag).toBe(`${siteIds[index]}.tag`);
			expect(row.modelVersion).toBe("jev-stub-1.0");
			expect(row.fallbackUsed).toBe(false);
			// Site confidence is the lowest answer confidence: the choice answer is
			// 0.9, the noul answer's decisiveness is |0.92 - 0.5| * 2 = 0.84.
			expect(row.confidence).toBeCloseTo(0.84);
			expect(row.tokens).toEqual({ inputTokens: 120, outputTokens: 8 });
			expect(row.answers).toHaveLength(2);
			expect(row.answers[0]).toEqual({ questionId: "gate", kind: "Choice", value: "yes", confidence: 0.9 });
			expect(typeof row.timestamp).toBe("string");
		}
		// The stub answered real typed questions, so the fixture is not vacuous.
		expect(stub.requests).toHaveLength(2);
		expect(typedAnswers(stub.requests[0]!.body).gate).toBeDefined();

		session.session.dispose();
	});
});
