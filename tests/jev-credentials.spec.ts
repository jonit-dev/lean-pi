/**
 * PRD-002 Phase 3 — AC-5, AC-6, AC-7: credentials and the `/jev` surface.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearLanes,
	clearSites,
	createCommandRegistry,
	createJevClient,
	credentialsPath,
	loadConfig,
	readDecisions,
	readStoredKey,
	registerLane,
	registerSite,
	resolveCredential,
	type CommandRegistry,
	type JevQuestion,
	type JevResult,
} from "../src/index.js";
import { bootSession, fixtureRepo, gitCommitAll, gitInit, nativeBackend, tempDir, writeConfig } from "./helpers/fixtures.js";
import { startStubBackend } from "./helpers/stub-backend.js";
import { startStubJev, type StubJev } from "./helpers/stub-jev.js";

const QUESTIONS: JevQuestion[] = [
	{ id: "route", kind: "Choice", text: "Which route?", options: { quick: "cheap", strong: "expensive" } },
];

function fallbackChoice(questions: JevQuestion[]): JevResult[] {
	return questions.map((question) => ({
		kind: "Choice" as const,
		questionId: question.id,
		choice: "quick",
		probabilities: {},
		confidence: 1,
	}));
}

function fixtureConfig(cwd: string, endpoint: string, extra: Record<string, unknown> = {}) {
	return loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { quick: { backend: "local", model: "m" } },
		jev: { endpoint, apiKey: null, model: "jev-latest", mode: "enabled" },
		...extra,
	});
}

describe("PRD-002 Phase 3 — credentials and /jev", () => {
	let stub: StubJev;
	let configHome: string;
	let env: Record<string, string>;
	let openBackends: Array<{ close(): Promise<void> }>;

	beforeEach(async () => {
		clearSites();
		clearLanes();
		stub = await startStubJev();
		configHome = tempDir("leanpi-xdg-");
		env = { XDG_CONFIG_HOME: configHome, HOME: configHome };
		openBackends = [];
	});

	afterEach(async () => {
		clearLanes();
		clearSites();
		await stub.close();
		for (const backend of openBackends) await backend.close();
	});

	async function freshSession(externalEnv: Record<string, string> = env) {
		const agentBackend = await startStubBackend([{ text: "ok" }]);
		openBackends.push(agentBackend);
		const { cwd, agentDir } = fixtureRepo();
		gitInit(cwd);
		writeConfig(cwd, {
			backends: { local: nativeBackend(agentBackend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			jev: { endpoint: stub.url, model: "jev-latest" },
		});
		gitCommitAll(cwd);
		const commands: CommandRegistry = createCommandRegistry();
		const session = await bootSession({ cwd, agentDir, env: externalEnv, commands });
		return { session, cwd, commands };
	}

	it("AC-5: /jev setup prompts once, validates once, persists outside the repo and reports the source", async () => {
		const { session, cwd, commands } = await freshSession();
		let prompts = 0;
		const context = {
			cwd,
			prompt: async () => {
				prompts += 1;
				return "stored-key-value";
			},
		};

		const status = await commands.dispatch("/jev", context);
		expect(status.text).toContain("not configured");

		const setup = await commands.dispatch("/jev setup", context);
		expect(setup.ok).toBe(true);
		expect(prompts).toBe(1);
		expect(stub.requests).toHaveLength(1);
		expect(stub.requests[0]!.headers.authorization).toBe("Bearer stored-key-value");

		const path = credentialsPath(env);
		expect(existsSync(path)).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readStoredKey(env)).toBe("stored-key-value");
		// The credential never lands in the project.
		expect(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim()).toBe("");

		const after = await commands.dispatch("/jev", context);
		expect(after.text).toContain("configured (source: credential store)");
		expect(after.text).toContain("reachable: true");
		expect(after.text).toContain("model: jev-stub-1.0");

		// Precedence: stored beats the environment; explicit config beats both.
		const withEnv = resolveCredential(fixtureConfig(cwd, stub.url), { ...env, JEV_API_KEY: "env-key" });
		expect(withEnv).toEqual({ key: "stored-key-value", source: "credential store" });
		const withConfig = resolveCredential(fixtureConfig(cwd, stub.url, { jev: { endpoint: stub.url, apiKey: "config-key" } }), env);
		expect(withConfig).toEqual({ key: "config-key", source: "config" });

		session.session.dispose();
	});

	it("AC-6: declining keeps the harness working on fallback, and an invalid key fails exactly once", async () => {
		registerSite({
			id: "fixture.route",
			questions: QUESTIONS,
			returnType: ["Choice"],
			consequence: "normal",
			telemetryTag: "fixture.route",
			fallback: ({ questions }) => fallbackChoice(questions),
		});
		const { session, cwd, commands } = await freshSession();

		const declined = await commands.dispatch("/jev setup", { cwd, prompt: async () => undefined });
		expect(declined.ok).toBe(true);
		expect(declined.text).toContain("degraded");
		expect(stub.requests).toHaveLength(0);

		const status = await commands.dispatch("/jev", { cwd });
		expect(status.text).toContain("not configured");
		expect(status.text).toContain("planning gate");

		// A fixture task still completes end to end through the heuristic branch.
		registerLane({
			name: "route-lane",
			async run() {
				await session.jev.ask("fixture.route", QUESTIONS, { task: "declined run" });
			},
		});
		await session.runTurn("complete on fallback");
		const rows = readDecisions(cwd);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.fallbackUsed).toBe(true);
		expect(rows[0]!.reason).toBe("no-credential");

		// An invalid key produces one clear error after exactly one attempt.
		const failing = await startStubJev([() => ({ status: 401 })]);
		const failingConfig = fixtureConfig(cwd, failing.url);
		const client = createJevClient({ config: failingConfig, cwd, env });
		const result = await client.validateKey("bad-key");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("401");
		expect(failing.requests).toHaveLength(1);
		await failing.close();

		session.session.dispose();
	});

	it("AC-7: /jev key clear removes the credential and the task still completes on fallback", async () => {
		registerSite({
			id: "fixture.route",
			questions: QUESTIONS,
			returnType: ["Choice"],
			consequence: "normal",
			telemetryTag: "fixture.route",
			fallback: ({ questions }) => fallbackChoice(questions),
		});
		const { session, cwd, commands } = await freshSession();
		await commands.dispatch("/jev setup", { cwd, prompt: async () => "stored-key-value" });
		expect(readStoredKey(env)).toBe("stored-key-value");

		const cleared = await commands.dispatch("/jev key clear", { cwd });
		expect(cleared.ok).toBe(true);
		expect(readStoredKey(env)).toBeNull();
		expect(existsSync(credentialsPath(env))).toBe(false);

		registerLane({
			name: "route-lane",
			async run() {
				await session.jev.ask("fixture.route", QUESTIONS, { task: "after clear" });
			},
		});
		await session.runTurn("complete after clear");

		const status = await commands.dispatch("/jev", { cwd });
		expect(status.text).toContain("not configured");
		expect(status.text).toMatch(/session fallbacks: [1-9]/);
		expect(session.jev.fallbackCount()).toBeGreaterThan(0);

		session.session.dispose();
	});
});
