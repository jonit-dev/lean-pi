/**
 * PRD-042 Phase 1 — AC-1 and AC-2: the provider seam.
 *
 * AC-1 is a regression claim: a client built without a provider resolves exactly
 * as PRD-002 shipped it. That is proven by the pre-existing JEV specs, which run
 * unchanged; the assertion here pins the one behaviour the refactor could have
 * moved — the request still lands on the configured endpoint with the resolved
 * credential and the configured model in the body.
 *
 * AC-2 is the new capability: an injected provider decides where `ask()` goes,
 * and a provider that cannot resolve degrades to the site's registered fallback
 * instead of throwing into a turn.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSites,
	createJevClient,
	loadConfig,
	readDecisions,
	registerSite,
	typesafeProvider,
	type ControlPlaneProvider,
	type JevQuestion,
	type JevResult,
} from "../src/index.js";
import { tempDir } from "./helpers/fixtures.js";
import { startStubJev, type StubJev, type StubJevRequest } from "./helpers/stub-jev.js";

const QUESTION: JevQuestion = { id: "route", kind: "Choice", text: "Which route?", options: { quick: "cheap", strong: "expensive" } };

function config(cwd: string, endpoint: string, apiKey: string | null = "test-key") {
	return loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { quick: { backend: "local", model: "m" } },
		jev: { endpoint, apiKey, model: "jev-latest", mode: "enabled" },
	});
}

function registerFixtureSite(id: string, fallbackChoice: string): void {
	registerSite({
		id,
		questions: [QUESTION],
		returnType: ["Choice"],
		consequence: "normal",
		telemetryTag: id,
		fallback: ({ questions }): JevResult[] =>
			questions.map((question) => ({ kind: "Choice", questionId: question.id, choice: fallbackChoice, probabilities: {}, confidence: 1 })),
	});
}

/** A provider that answers from a fixed target and records how often it resolved. */
function stubProvider(target: { endpoint: string; key: string | null; model: string }, name: ControlPlaneProvider["name"] = "laya"): ControlPlaneProvider & { calls: number } {
	const provider = {
		name,
		source: "laya" as const,
		calls: 0,
		async resolve() {
			provider.calls += 1;
			return { ...target, source: "laya" as const };
		},
	};
	return provider;
}

describe("PRD-042 Phase 1 — control-plane provider seam", () => {
	let stub: StubJev;
	let cwd: string;

	beforeEach(async () => {
		clearSites();
		stub = await startStubJev();
		cwd = tempDir("leanpi-provider-");
	});

	afterEach(async () => {
		clearSites();
		await stub.close();
	});

	it("AC-1: with no provider the client resolves the TypeSafe path unchanged", async () => {
		registerFixtureSite("fixture.route", "fallback");
		const client = createJevClient({ config: config(cwd, stub.url), cwd });

		const [answer] = await client.ask("fixture.route", [QUESTION], { task: "pick" });

		expect(answer).toMatchObject({ kind: "Choice", questionId: "route" });
		const asked = stub.requests.at(-1) as StubJevRequest;
		expect(asked.url).toBe("/v1/systemone");
		expect(asked.headers.authorization).toBe("Bearer test-key");
		expect((asked.body as { model?: string }).model).toBe("jev-latest");
		expect(client.credentialSource()).toBe("config");
		expect(client.providerName()).toBe("typesafe");
	});

	it("AC-2: an injected provider decides the endpoint, and a rejecting one falls back without throwing", async () => {
		registerFixtureSite("fixture.route", "fallback");
		const base = config(cwd, "http://127.0.0.1:1/never");
		const provider = stubProvider({ endpoint: stub.url, key: "laya-local", model: "laya-english" });
		const client = createJevClient({ config: base, cwd, provider });

		const [answer] = await client.ask("fixture.route", [QUESTION], { task: "pick" });

		// The stub answers its first option ("quick"); the site's fallback is
		// "fallback", so a fallback would be visible here.
		expect(answer).toMatchObject({ kind: "Choice", choice: "quick" });
		expect(stub.requests).toHaveLength(1);
		expect((stub.requests[0]!.body as { model?: string }).model).toBe("laya-english");
		expect(client.providerName()).toBe("laya");
		expect(client.credentialSource()).toBe("laya");
		expect(provider.calls).toBe(1);

		// A provider that cannot resolve is the same failure class as an unreachable
		// service: the site takes its registered fallback and nothing is thrown.
		clearSites();
		registerFixtureSite("fixture.route", "fallback");
		const broken: ControlPlaneProvider = {
			name: "laya",
			source: "laya",
			async resolve() {
				throw new Error("laya runtime missing");
			},
		};
		const brokenClient = createJevClient({ config: base, cwd, provider: broken });
		const [fellBack] = await brokenClient.ask("fixture.route", [QUESTION], { task: "pick" });

		expect(fellBack).toMatchObject({ kind: "Choice", choice: "fallback" });
		expect(stub.requests).toHaveLength(1);
		const row = readDecisions(cwd).find((entry) => entry.siteId === "fixture.route" && entry.fallbackUsed);
		expect(row?.reason).toBe("laya runtime missing");
	});

	it("AC-2: the extracted typesafeProvider is the same resolution the inline path performs", async () => {
		registerFixtureSite("fixture.route", "fallback");
		const base = config(cwd, stub.url, null);
		// The provider reads the same credential function the client would.
		const provider = typesafeProvider({
			endpoint: stub.url,
			model: "jev-latest",
			credential: () => ({ key: "from-env", source: "env" }),
		});
		const client = createJevClient({ config: base, cwd, provider });

		const [answer] = await client.ask("fixture.route", [QUESTION], { task: "pick" });

		expect(answer).toMatchObject({ kind: "Choice" });
		expect((stub.requests.at(-1) as StubJevRequest).headers.authorization).toBe("Bearer from-env");
		expect(client.credentialSource()).toBe("env");
	});
});
