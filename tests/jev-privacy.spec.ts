/**
 * PRD-002 Phase 4 — AC-8, AC-9, AC-10: privacy modes and secret non-egress.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	REDACTED,
	clearSites,
	createJevClient,
	loadConfig,
	readDecisions,
	redactSecrets,
	registerSite,
	semanticQuestion,
	type GoalClause,
	type JevQuestion,
	type JevResult,
} from "../src/index.js";
import { tempDir } from "./helpers/fixtures.js";
import { startStubJev, type StubJev } from "./helpers/stub-jev.js";

const SECRET = "sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const PROSE = "Selecting the torpedo sometimes crashes the aircraft game before the scene loads.";
const FILE_BODY = `export function selectTorpedo() {\n  // ${PROSE}\n  return process.env.API_KEY;\n}\nAPI_KEY=${SECRET}\n`;

const QUESTIONS: JevQuestion[] = [
	{ id: "route", kind: "Choice", text: "Which route?", options: { quick: "cheap", strong: "expensive" } },
];

function fallback(questions: JevQuestion[]): JevResult[] {
	return questions.map((question) => ({
		kind: "Choice" as const,
		questionId: question.id,
		choice: "quick",
		probabilities: {},
		confidence: 1,
	}));
}

function configFor(cwd: string, endpoint: string, mode: string) {
	return loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { quick: { backend: "local", model: "m" } },
		jev: { endpoint, apiKey: SECRET, model: "jev-latest", mode: mode as "enabled" },
	});
}

/** Scans the surfaces a run produces, never the workspace the fixture planted the secret in. */
function scanArtifacts(cwd: string, literal: string): string[] {
	const hits: string[] = [];
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (statSync(path).isDirectory()) walk(path);
			else if (readFileSync(path, "utf8").includes(literal)) hits.push(path);
		}
	};
	for (const surface of [join(cwd, ".leanpi"), join(cwd, "artifacts"), join(cwd, "transcripts")]) walk(surface);
	return hits;
}

describe("PRD-002 Phase 4 — privacy modes", () => {
	let stub: StubJev;
	let cwd: string;
	let workspace: string;

	beforeEach(async () => {
		clearSites();
		stub = await startStubJev();
		cwd = tempDir("leanpi-privacy-");
		workspace = join(cwd, "src");
		writeFileSync(join(cwd, "leanpi.config.yaml"), "");
		mkdirSync(workspace, { recursive: true });
		writeFileSync(join(workspace, "select.ts"), FILE_BODY);

		registerSite({
			id: "fixture.route",
			questions: QUESTIONS,
			returnType: ["Choice"],
			consequence: "normal",
			telemetryTag: "fixture.route",
			fallback: ({ questions }) => fallback(questions),
		});
	});

	afterEach(async () => {
		clearSites();
		await stub.close();
	});

	const state = () => ({
		files: [{ path: "src/select.ts", content: FILE_BODY }],
		command: `cat src/select.ts  # API_KEY=${SECRET}`,
	});

	it("AC-8: metadata-only sends counts, kinds, extensions and path hashes — never content", async () => {
		const client = createJevClient({ config: configFor(cwd, stub.url, "metadata-only"), cwd, salt: "fixed-salt" });
		await client.ask("fixture.route", QUESTIONS, state());

		const raw = stub.raw[0]!;
		expect(raw).not.toContain(SECRET);
		expect(raw).not.toContain(PROSE);
		expect(raw).not.toContain("selectTorpedo");
		const sent = stub.requests[0]!.body.state as { files: Array<Record<string, Record<string, unknown>>>; command: Record<string, unknown> };
		expect(sent.files[0]!.path).toMatchObject({ kind: "path", ext: ".ts", pathHash: expect.any(String) });
		expect(sent.files[0]!.content).toMatchObject({ kind: "text", chars: FILE_BODY.length });
		expect(sent.command).toMatchObject({ kind: "text", chars: expect.any(Number) });
		expect(raw).not.toContain("src/select.ts");
	});

	it("AC-8: metadata-only keeps dynamic question text and identifiers out of the request", async () => {
		const clause: GoalClause = { id: "semantic:0", text: "CONFIDENTIAL-AUDIT-GOAL-7831", kind: "semantic", kinds: [], criterion: null };
		registerSite({
			id: "fixture.semantic",
			// The site's declared template is the static question surface.
			questions: [semanticQuestion({ ...clause, text: "<clause>" })],
			returnType: ["Choice"],
			consequence: "normal",
			telemetryTag: "fixture.semantic",
			fallback: ({ questions }) =>
				questions.map(
					(question): JevResult => ({ kind: "Choice", questionId: question.id, choice: "no", probabilities: {}, confidence: 1 }),
				),
		});

		const client = createJevClient({ config: configFor(cwd, stub.url, "metadata-only"), cwd, salt: "fixed-salt" });
		const question = semanticQuestion(clause);
		const results = await client.ask("fixture.semantic", [question], state());

		const raw = stub.raw[0]!;
		expect(raw).not.toContain("CONFIDENTIAL-AUDIT-GOAL-7831");
		// Question ids can name paths (`test:<path>` in exploration), so they are opaque too.
		expect(Object.keys(stub.requests[0]!.body.questions as Record<string, unknown>)).not.toContain(question.id);
		// The static template still says what the service is answering.
		expect(raw).toContain("Given this evidence, is the goal clause");
		// The answer still maps back to the caller's question and choice.
		expect(results[0]).toMatchObject({ questionId: question.id, choice: "yes" });
	});

	it("AC-9: redacted keeps prose, removes secret shapes, and /jev mode switches without a restart", async () => {
		const client = createJevClient({ config: configFor(cwd, stub.url, "redacted"), cwd });
		await client.ask("fixture.route", QUESTIONS, state());

		const raw = stub.raw[0]!;
		expect(raw).not.toContain(SECRET);
		expect(raw).toContain(PROSE);
		expect(raw).toContain(REDACTED);
		expect(redactSecrets(FILE_BODY)).not.toContain(SECRET);

		// The runtime switch changes the next payload's shape with no restart.
		client.setMode("metadata-only");
		await client.ask("fixture.route", QUESTIONS, state());
		expect(stub.requests).toHaveLength(2);
		expect(stub.raw[1]).not.toContain(PROSE);
		expect(stub.raw[1]).not.toContain(SECRET);
		expect((stub.requests[1]!.body.state as { files: Array<Record<string, Record<string, unknown>>> }).files[0]!.path).toMatchObject({
			kind: "path",
		});
	});

	it("AC-10: no artifact carries the key, and the scan detects a deliberate leak", async () => {
		const client = createJevClient({ config: configFor(cwd, stub.url, "redacted"), cwd });
		await client.ask("fixture.route", QUESTIONS, state());
		await client.test();

		const artifactsBefore = scanArtifacts(cwd, SECRET);
		expect(artifactsBefore).toEqual([]);
		expect(readDecisions(cwd).length).toBeGreaterThan(0);
		// The recorded rows are readable without the key and carry the redaction.
		expect(JSON.stringify(readDecisions(cwd))).not.toContain(SECRET);

		appendFileSync(join(cwd, ".leanpi", "decisions.jsonl"), `${JSON.stringify({ leak: SECRET })}\n`);
		expect(scanArtifacts(cwd, SECRET)).toContain(join(cwd, ".leanpi", "decisions.jsonl"));
	});
});
