/**
 * The cost audit's regression net (PRD-028 follow-up).
 *
 * Three features were built and never connected, and each one showed up as
 * money on the benchmark's native path:
 *
 * - PRD-005 picks skills with JEV and fills a contract slot, but a native
 *   backend compiles no contract, so Pi disclosed its *whole* library instead —
 *   199 skills, 20,597 tokens, in the system prompt of every request.
 * - The compiler decides a reasoning effort per complexity and nothing applied
 *   it, so every turn thought at the session default and paid twice: once as
 *   output, then again as context on every later turn.
 *
 * Each assertion runs through the real session boot, so a registration that
 * only works when called by hand cannot pass.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearLanes,
	compileTask,
	createGoalStore,
	newGoalState,
	readDecisions,
	readRuns,
	scanSkills,
	scoutTask,
	SKILL_RANK_LIMIT,
	VERIFY_TOOL_DESCRIPTION,
	VERIFY_TOOL_NAME,
	withoutSkillCatalog,
} from "../src/index.js";
import { registerLane } from "../src/commands/session.js";
import { bootSession, fixtureRepo, nativeBackend, systemText, tempDir, writeConfig } from "./helpers/fixtures.js";
import { startStubBackend } from "./helpers/stub-backend.js";
import { startStubJev, typedAnswers } from "./helpers/stub-jev.js";

/** A skill library on disk, in the layout the registry scans. */
function writeSkills(root: string, skills: { name: string; description: string; body: string }[]): void {
	for (const skill of skills) {
		const dir = join(root, skill.name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}\n`);
	}
}

const SKILLS = [
	{ name: "targeted-testing", description: "Run the narrowest test that can fail", body: "RELEVANT-BODY: run the targeted test first" },
	{ name: "xlsx-workbooks", description: "Read and write Excel workbooks", body: "IRRELEVANT-BODY: open the workbook" },
];

afterEach(() => {
	clearLanes();
});

describe("PRD-028 follow-up — the wiring the cost audit found open", () => {
	it("does not disclose the whole skill library in the request (PRD-005)", async () => {
		const backend = await startStubBackend([{ text: "ok" }]);
		const { cwd } = fixtureRepo();
		const skillRoot = tempDir("leanpi-skills-");
		writeSkills(skillRoot, SKILLS);
		writeConfig(cwd, {
			backends: { local: nativeBackend(backend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			capabilities: { skillRoots: [skillRoot] },
		});
		const session = await bootSession({ cwd, agentDir: skillRoot });
		try {
			await session.runTurn("rename a helper");
			const system = systemText(backend.requests[0]!.body);
			// The library is disclosed by LeanPi's own selection, never enumerated
			// wholesale: a skill with nothing to do with the request must not be in
			// the prompt at all.
			expect(system).not.toContain("xlsx-workbooks");
			expect(system).not.toContain("<available_skills>");
		} finally {
			session.session.dispose();
			await backend.close();
		}
	});

	it("asks JEV which skills a native turn needs and discloses only those (PRD-005 §16)", async () => {
		// "yes, a skill is needed" plus a relevance batch that ranks the fixture
		// skill above every other candidate — including the bundled pack, which is
		// always a candidate — then a fit batch that confirms.
		const rank = (body: Record<string, unknown>) => {
			const asked = "relevance:targeted-testing" in (body.questions as Record<string, unknown>);
			const answers = asked
				? { "relevance:targeted-testing": { type: "score", score: 3, legend: {}, probabilities: {}, confidence: 0.95 } }
				: {};
			return { answers: typedAnswers(body, answers) };
		};
		const jev = await startStubJev([rank, rank, rank]);
		const backend = await startStubBackend([{ text: "ok" }]);
		const { cwd } = fixtureRepo();
		const skillRoot = tempDir("leanpi-skills-");
		writeSkills(skillRoot, SKILLS);
		writeConfig(cwd, {
			backends: { local: nativeBackend(backend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			capabilities: { skillRoots: [skillRoot] },
			skills: { maxLoaded: 1 },
			jev: { endpoint: jev.url, apiKey: "test-key" },
		});
		const session = await bootSession({ cwd, agentDir: skillRoot });
		try {
			await session.runTurn("run the targeted test for the helper");
			// The selection ran at all: a native turn reaches the JEV disclosure site
			// instead of skipping it because no contract was compiled.
			expect(jev.requests.length).toBeGreaterThan(0);
			expect(JSON.stringify(jev.requests)).toContain("targeted-testing");
			// Only the selected skill is disclosed, and as a pointer: what it is for
			// and where to read it, never the body — inside Pi's loop a body is
			// re-sent on every provider call.
			const body = JSON.stringify(backend.requests[0]!.body);
			expect(body).toContain("targeted-testing");
			expect(body).toContain("Run the narrowest test that can fail");
			expect(body).not.toContain("RELEVANT-BODY");
			expect(body).not.toContain("xlsx-workbooks");
		} finally {
			session.session.dispose();
			await backend.close();
			await jev.close();
		}
	});

	it("writes the native run's record after the loop, carrying what the loop spent", async () => {
		// The audit's last accounting gap: with Pi's own loop as the executor the
		// record used to be emitted before the loop spent anything, so a native turn
		// either wrote nothing or wrote zeros. It is written at `agent_end` now, from
		// the loop's own messages.
		const backend = await startStubBackend([
			{ toolCalls: [{ name: "write", args: { path: "a.txt", content: "x\n" } }] },
			{ text: "done" },
		]);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(backend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
		});
		const session = await bootSession({ cwd, agentDir });
		try {
			await session.session.prompt("create a.txt");
			const rows = readRuns(cwd);
			expect(rows).toHaveLength(1);
			// One call per assistant message the loop produced, and the tool call it
			// asked for — not a zeroed placeholder.
			expect(rows[0]!.calls).toHaveLength(2);
			expect(rows[0]!.execution.tool_calls).toBe(1);
			expect(rows[0]!.executor_backend).toBe("local");
			expect(rows[0]!.executor_model).toBe("cheap-fast");
		} finally {
			session.session.dispose();
			await backend.close();
		}
	});

	it("caps a compiled turn's effort at the backend's declared level", async () => {
		const backend = await startStubBackend([{ text: "ok" }, { text: "ok" }, { text: "ok" }]);
		// A config edit does not reach a booted session (it holds its own loaded
		// copy), so each level gets its own boot.
		const runWith = async (declared?: "off" | "low" | "medium" | "high"): Promise<string> => {
			const { cwd, agentDir } = fixtureRepo();
			writeConfig(cwd, {
				// A reasoning-capable model whose operator may have declared a level.
				// That declaration is the one switch that changes the bill on a
				// binary-thinking endpoint, so a classifier must not spend past it.
				backends: {
					local: nativeBackend(backend.baseUrl, {
						reasoning: true,
						...(declared === undefined ? {} : { thinkingLevel: declared }),
					}),
				},
				models: { balanced: { backend: "local", model: "cheap-fast" } },
			});
			const session = await bootSession({ cwd, agentDir });
			try {
				await session.runTurn("rename a helper");
				return (session.session as unknown as { thinkingLevel: string }).thinkingLevel;
			} finally {
				session.session.dispose();
			}
		};

		// The compiler runs on every native turn, so every turn below compiled an
		// effort of its own; the declared level is what caps it.
		const { cwd } = fixtureRepo();
		const compiled = await compileTask("rename a helper", scoutTask(cwd, "rename a helper"));
		expect(compiled.reasoning.effort).not.toBe("off");

		expect(await runWith("off")).toBe("off");
		expect(await runWith("high")).toBe(compiled.reasoning.effort);
		expect(await runWith()).toBe(compiled.reasoning.effort);
		await backend.close();
	});

	it("invents no level when the backend declares none and nothing compiled", async () => {
		const backend = await startStubBackend([{ text: "ok" }]);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(backend.baseUrl, { reasoning: true }) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
		});
		const session = await bootSession({ cwd, agentDir });
		try {
			const agent = session.session as unknown as { thinkingLevel: string };
			// No lanes: nothing compiled a decision.
			clearLanes();
			await session.runTurn("no contract here");
			// The session's own level — Pi's or the user's. LeanPi spending thinking
			// on a turn it compiled nothing for is a policy, and a policy an operator
			// did not set is not LeanPi's to choose.
			expect(agent.thinkingLevel).toBe("medium");
		} finally {
			session.session.dispose();
			await backend.close();
		}
	});

	it("sends the dialect's thinking control when the backend declares one (PRD-028)", async () => {
		const backend = await startStubBackend([{ text: "ok" }]);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			// OpenCode Go serves this model with DeepSeek's `thinking` field. Pi
			// detects that from the provider id and base URL, and a native backend
			// carries the operator's own name, so the declaration is the operator's.
			backends: {
				local: nativeBackend(backend.baseUrl, { reasoning: true, thinkingLevel: "off", compat: { thinkingFormat: "deepseek" } }),
			},
			models: { balanced: { backend: "local", model: "cheap-fast" } },
		});
		const session = await bootSession({ cwd, agentDir });
		try {
			await session.runTurn("rename a helper");
			// The money path: the level is `off`, and on this dialect `off` is the
			// only value the endpoint reads as "do not think". Without the
			// declaration Pi sends no control at all and the model thinks at the
			// server's default on every call.
			const body = backend.requests[0]!.body as { thinking?: unknown; reasoning_effort?: unknown };
			expect(body.thinking).toEqual({ type: "disabled" });
			expect(body.reasoning_effort).toBeUndefined();
			// And this is the operator's switch binding, not the absence of a
			// decision: the turn compiled a contract, whose effort the operator's
			// declared `off` has to cap — otherwise the only knob that changes the
			// bill on this endpoint would be overridden by the classifier.
			expect(readRuns(cwd)).toHaveLength(1);
		} finally {
			session.session.dispose();
			await backend.close();
		}
	});
	it("strips Pi's own skill catalog from the interactive entry's prompt (PRD-005 §16)", async () => {
		// `createLeanPiSession` suppresses the catalog at the resource loader, and
		// `pi --extension` — the documented interactive entry — never builds that
		// loader. Measured on this machine the block was 82,343 bytes of an 87,932
		// byte prompt, in every request of every turn.
		const prompt = [
			"You are an expert coding assistant.",
			"",
			"<available_skills>",
			"- one: BODY_OF_one",
			"- two: BODY_OF_two",
			"</available_skills>",
			"",
			"Guidelines: be concise.",
		].join("\n");

		const stripped = withoutSkillCatalog(prompt);
		expect(stripped).not.toContain("available_skills");
		expect(stripped).not.toContain("BODY_OF_one");
		// Everything Pi said around it survives: this removes a duplicate library,
		// not the host's instructions.
		expect(stripped).toContain("You are an expert coding assistant.");
		expect(stripped).toContain("Guidelines: be concise.");
		// A prompt without the block is returned untouched, so the handler can tell
		// "nothing to replace" from "replaced".
		expect(withoutSkillCatalog("no catalog here")).toBe("no catalog here");
	});

	it("bills a native turn for the JEV decisions it made", async () => {
		// The ledger recorded every decision and the run record said `jev_tokens: 0`:
		// the collector's JEV sink was wired in the bench and nowhere else, so the
		// control plane's own spend was invisible to `/cost` and to the goal budget
		// that reads it. The two must agree — the ledger is the only witness there is.
		const jev = await startStubJev();
		const backend = await startStubBackend([{ text: "done" }]);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(backend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			jev: { endpoint: jev.url, apiKey: "test-key" },
		});
		const session = await bootSession({ cwd, agentDir });
		try {
			await session.session.prompt("rename a helper");
			const ledger = readDecisions(cwd);
			expect(ledger.length).toBeGreaterThan(0);
			const spent = ledger.reduce((sum, row) => sum + row.tokens.inputTokens + row.tokens.outputTokens, 0);
			const run = readRuns(cwd)[0]!;
			expect(run.usage.jev_tokens).toBe(spent);
			// And priced: a config that names no rate still pays JEV's published one,
			// because "no rate configured" is not "the control plane is free".
			expect(run.cost.jev_usd).toBeGreaterThan(0);
			expect(run.cost.effective_cost).toBeGreaterThanOrEqual(run.cost.jev_usd);
		} finally {
			session.session.dispose();
			await backend.close();
			await jev.close();
		}
	});

	it("does not scale the disclosure batch with the size of the skill library", async () => {
		// One relevance question per candidate, and the operator's library is the
		// candidate set: 42 skills cost 29k JEV input tokens per turn on the audited
		// machine, for a library where nothing scored above "tangential". The rank
		// stage is a retrieval, so it is bounded; only the bounded set is reranked.
		const jev = await startStubJev();
		const backend = await startStubBackend([{ text: "ok" }]);
		const { cwd } = fixtureRepo();
		const skillRoot = tempDir("leanpi-skills-");
		writeSkills(skillRoot, [
			...SKILLS,
			...Array.from({ length: 40 }, (_, index) => ({
				name: `filler-${String(index).padStart(2, "0")}`,
				description: `unrelated fixture skill number ${index}`,
				body: "IRRELEVANT-BODY",
			})),
		]);
		writeConfig(cwd, {
			backends: { local: nativeBackend(backend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			capabilities: { skillRoots: [skillRoot] },
			jev: { endpoint: jev.url, apiKey: "test-key" },
		});
		const session = await bootSession({ cwd, agentDir: skillRoot });
		try {
			await session.runTurn("run the targeted test for the helper");
			const rank = jev.requests.find((request) => "any_skill" in (request.body.questions as Record<string, unknown>));
			expect(rank).toBeDefined();
			const asked = Object.keys(rank!.body.questions as Record<string, unknown>).filter((id) => id.startsWith("relevance:"));
			// The cap only means something if the library is bigger than it: 42
			// fixtures plus the bundled pack, against a stage that scores 12.
			expect(scanSkills(cwd, { roots: [{ path: skillRoot, class: "user" }] }).length).toBeGreaterThan(SKILL_RANK_LIMIT);
			expect(asked.length).toBeLessThanOrEqual(SKILL_RANK_LIMIT);
			// Bounded, not blind: the skill the request actually names survives the cut.
			expect(asked).toContain("relevance:targeted-testing");
		} finally {
			session.session.dispose();
			await backend.close();
			await jev.close();
		}
	});

	it("counts a native turn against the goal's turn cap", async () => {
		// The boundary lived inside the executor lane, which a native configuration
		// never registers: `turns_used` stayed 0 for the life of the session and
		// `max_turns` could not trip. Pi's loop is the executor there, so its turn
		// is the one the cap has to count.
		const backend = await startStubBackend([{ text: "done" }]);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(backend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
		});
		const goals = createGoalStore(cwd);
		goals.save(newGoalState("ship the parser", { max_turns: 5, max_cost: 2 }, new Date().toISOString()));
		const session = await bootSession({ cwd, agentDir });
		try {
			await session.session.prompt("work on the parser");
			expect(goals.load()?.turns_used).toBe(1);
		} finally {
			session.session.dispose();
			await backend.close();
		}
	});


	it("hands the executor the gate instead of running it for them", async () => {
		// The trigger belongs to whoever just changed the code. A rule in the
		// harness can only force the project's suite after every edit or never run
		// it, and the first of those is what an operator notices as their session
		// spending four minutes on a turn that renamed a variable.
		const backend = await startStubBackend([{ toolCalls: [{ name: "verify", args: {} }] }, { text: "done" }]);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(backend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			// A verifier that exists and passes: what the gate is being asked to run.
			verify: { commands: { targeted_test: "true", build: "true", lint: "true" }, timeoutMs: 10_000 },
		});
		// `verify` spawns the operator's verifier commands, so it is a shell call and
		// the PRD-017 guard asks about it like any other. `--safety low` is the
		// operator having already answered, which is what an unattended run is.
		const session = await bootSession({ cwd, agentDir, env: { ...process.env, LEANPI_SAFETY: "low" } });
		try {
			await session.session.prompt("fix the off-by-one in the parser");
			// Offered, and offered with its triggers: the description is the only
			// instruction the model reads at the moment it decides.
			const offered = (backend.requests[0]!.body as { tools?: { function?: { name?: string; description?: string } }[] }).tools ?? [];
			const tool = offered.find((entry) => entry.function?.name === VERIFY_TOOL_NAME);
			expect(tool).toBeDefined();
			expect(tool!.function!.description).toBe(VERIFY_TOOL_DESCRIPTION);
			expect(tool!.function!.description).toContain("regression risk");
			expect(tool!.function!.description).toContain("red to green");
			// And when the model calls it, the turn stops reporting `not_run`: the
			// record carries the gate's real answer.
			const run = readRuns(cwd)[0]!;
			expect(run.result.verification).not.toBe("not_run");
			expect(run.result.proof_gate).not.toBe("not_run");
		} finally {
			session.session.dispose();
			await backend.close();
		}
	});

});
