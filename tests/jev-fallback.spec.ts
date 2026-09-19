/**
 * PRD-002 Phase 5 — AC-11 and AC-12: deterministic fallback and asymmetric confidence.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearLanes,
	clearSites,
	readDecisions,
	registerLane,
	registerSite,
	type JevQuestion,
	type JevResult,
	type LeanPiSession,
} from "../src/index.js";
import { bootSession, fixtureRepo, nativeBackend, writeConfig } from "./helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "./helpers/stub-backend.js";
import { startStubJev, type StubJev } from "./helpers/stub-jev.js";

const QUESTION: JevQuestion[] = [{ id: "route", kind: "Choice", text: "Which route?", options: { quick: "cheap", strong: "expensive" } }];

function fallbackPick(choice: string) {
	return ({ questions }: { questions: JevQuestion[] }): JevResult[] =>
		questions.map((question) => ({ kind: "Choice", questionId: question.id, choice, probabilities: {}, confidence: 1 }));
}

function answered(choice: string, confidence: number) {
	return (_body: Record<string, unknown>): { answers: Record<string, unknown> } => ({
		answers: {
			route: { type: "choice", choice, probabilities: { [choice]: confidence, quick: 1 - confidence }, confidence },
		},
	});
}

describe("PRD-002 Phase 5 — fallback and confidence asymmetry", () => {
	let openBackends: Array<{ close(): Promise<void> }>;

	beforeEach(() => {
		clearSites();
		clearLanes();
		openBackends = [];
	});

	afterEach(async () => {
		clearLanes();
		clearSites();
		for (const backend of openBackends) await backend.close();
	});

	async function bootWithJev(jevUrl: string, mode: string, extraConfig: Record<string, unknown> = {}) {
		const agentBackend: StubBackend = await startStubBackend([{ text: "ok" }]);
		openBackends.push(agentBackend);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(agentBackend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			jev: { endpoint: jevUrl, apiKey: "test-key", mode },
			...extraConfig,
		});
		const session = await bootSession({ cwd, agentDir });
		return { session, cwd };
	}

	function branchLane(session: LeanPiSession, siteId: string, file: string) {
		registerLane({
			name: `${siteId}-lane`,
			async run() {
				const [answer] = await session.jev.ask(siteId, QUESTION, { task: "pick a route" });
				writeFileSync(file, answer && answer.kind === "Choice" ? answer.choice : "none");
			},
		});
	}

	it("AC-11: the decision drives behaviour and survives JEV loss", async () => {
		// (a) The stub answers: the session takes branch A.
		const answering = await startStubJev([answered("strong", 0.95)]);
		registerSite({
			id: "fixture.route",
			questions: QUESTION,
			returnType: ["Choice"],
			consequence: "normal",
			telemetryTag: "fixture.route",
			fallback: fallbackPick("quick"),
		});
		const runA = await bootWithJev(answering.url, "enabled");
		branchLane(runA.session, "fixture.route", join(runA.cwd, "branch.txt"));
		await runA.session.runTurn("pick a route");
		expect(readFileSync(join(runA.cwd, "branch.txt"), "utf8")).toBe("strong");
		expect(answering.requests).toHaveLength(1);
		expect(readDecisions(runA.cwd)[0]!.fallbackUsed).toBe(false);
		runA.session.session.dispose();

		// (b) The service fails: the fallback branch runs and the task still completes.
		const failing = await startStubJev([() => ({ status: 503 })]);
		clearLanes();
		const runB = await bootWithJev(failing.url, "enabled");
		branchLane(runB.session, "fixture.route", join(runB.cwd, "branch.txt"));
		await runB.session.runTurn("pick a route");
		expect(readFileSync(join(runB.cwd, "branch.txt"), "utf8")).toBe("quick");
		const rowB = readDecisions(runB.cwd)[0]!;
		expect(rowB.fallbackUsed).toBe(true);
		expect(rowB.reason).toContain("503");
		runB.session.session.dispose();

		// (c) Privacy mode disables JEV entirely: zero requests, same fallback branch.
		const disabled = await startStubJev([answered("strong", 0.95)]);
		clearLanes();
		const runC = await bootWithJev(disabled.url, "disabled");
		branchLane(runC.session, "fixture.route", join(runC.cwd, "branch.txt"));
		await runC.session.runTurn("pick a route");
		expect(readFileSync(join(runC.cwd, "branch.txt"), "utf8")).toBe("quick");
		expect(disabled.requests).toHaveLength(0);
		expect(readDecisions(runC.cwd)[0]!.reason).toBe("privacy-mode-disabled");
		runC.session.session.dispose();

		await answering.close();
		await failing.close();
		await disabled.close();
	});

	it("AC-12: the same confidence is rejected for a high-consequence site and accepted for a low one", async () => {
		const stub: StubJev = await startStubJev([answered("accepted", 0.55)]);
		for (const [id, consequence] of [
			["fixture.high", "high"],
			["fixture.low", "low"],
		] as const) {
			registerSite({
				id,
				questions: QUESTION,
				returnType: ["Choice"],
				consequence,
				telemetryTag: id,
				fallback: fallbackPick("fallback"),
			});
		}

		const { session, cwd } = await bootWithJev(stub.url, "enabled");
		registerLane({
			name: "outcome-lane",
			async run() {
				const outcomes: string[] = [];
				for (const id of ["fixture.high", "fixture.low"]) {
					const [answer] = await session.jev.ask(id, QUESTION, { task: "same confidence" });
					outcomes.push(answer && answer.kind === "Choice" ? answer.choice : "none");
				}
				writeFileSync(join(cwd, "outcomes.txt"), outcomes.join(","));
			},
		});
		await session.runTurn("same confidence, different consequence");

		expect(readFileSync(join(cwd, "outcomes.txt"), "utf8")).toBe("fallback,accepted");
		const rows = readDecisions(cwd);
		expect(rows.find((row) => row.siteId === "fixture.high")?.reason).toBe("below-threshold");
		expect(rows.find((row) => row.siteId === "fixture.low")?.fallbackUsed).toBe(false);

		session.session.dispose();
		await stub.close();
	});
});
