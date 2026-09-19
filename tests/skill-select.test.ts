/**
 * PRD-005 Phase 2 — AC-3, AC-4, AC-6, AC-7: rank → verify → load, pins, and the
 * assembled provider request.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	assemble,
	clearLanes,
	createJevClient,
	createSkillControl,
	decisionLogPath,
	loadConfig,
	registerLane,
	scanSkills,
	selectSkills,
	type LeanPiConfig,
	type SkillRecord,
	type SkillRoot,
} from "../src/index.js";
import { bootSession, fixtureRepo, nativeBackend, tempDir, writeConfig } from "./helpers/fixtures.js";
import { startStubBackend } from "./helpers/stub-backend.js";
import { startStubJev, type StubJev } from "./helpers/stub-jev.js";

const MAX_LOADED = 3;

interface Corpus {
	cwd: string;
	roots: SkillRoot[];
	records: SkillRecord[];
	bodyOf(name: string): string;
}

function writeSkill(root: string, name: string, description: string, tags: string[] = []): void {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(
		join(root, name, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\ntags: [${tags.join(", ")}]\nversion: 1.0.0\n---\n\n# ${name}\n\nBODY_OF_${name}\n${description}\n`,
	);
}

/** A project root and a user root, ≥200 skills, with `dup` in both. */
function corpus(): Corpus {
	const cwd = tempDir("leanpi-skill-corpus-");
	const roots: SkillRoot[] = [
		{ path: join(cwd, ".claude/skills"), class: "project" },
		{ path: join(cwd, "user-skills"), class: "user" },
	];
	writeSkill(roots[0]!.path, "dup", "project copy of the duplicate skill", ["fixture"]);
	writeSkill(roots[1]!.path, "dup", "user copy of the duplicate skill", ["fixture"]);
	writeSkill(roots[1]!.path, "debugging", "debug a crashing scene in the game", ["debug", "game"]);
	writeSkill(roots[1]!.path, "aux-helper", "handles the selection path", ["aux"]);
	writeSkill(roots[1]!.path, "unrelated-skill", "writes invoices and pays suppliers", ["billing"]);
	for (let index = 0; index < 205; index += 1) {
		writeSkill(roots[1]!.path, `gen-${String(index).padStart(3, "0")}`, `generated fixture skill number ${index}`, ["generated"]);
	}
	const records = scanSkills(cwd, { roots });
	return {
		cwd,
		roots,
		records,
		bodyOf: (name) => records.find((record) => record.name === name)!.source.path,
	};
}

/** Answers the disclosure pipeline's two stages from a simple relevance list. */
function skillResponder(relevant: string[], anySkill = true) {
	return (body: Record<string, unknown>) => {
		const questions = (body.questions ?? {}) as Record<string, { type?: string }>;
		const answers: Record<string, unknown> = {};
		for (const id of Object.keys(questions)) {
			if (id === "any_skill") {
				answers[id] = { type: "choice", choice: anySkill ? "yes" : "no", probabilities: {}, confidence: 0.95 };
			} else if (id.startsWith("relevance:")) {
				const name = id.slice("relevance:".length);
				answers[id] = { type: "score", score: relevant.includes(name) ? 3 : 0, legend: {}, probabilities: {}, confidence: 0.95 };
			} else if (id.startsWith("fit:")) {
				const name = id.slice("fit:".length);
				const fits = relevant.includes(name);
				answers[id] = { type: "choice", choice: fits ? "yes" : "no", probabilities: {}, confidence: 0.95 };
			}
		}
		return { answers };
	};
}

async function harness(responders: Parameters<typeof startStubJev>[0], overrides: Partial<LeanPiConfig> = {}) {
	const stub: StubJev = await startStubJev(responders);
	const cwd = tempDir("leanpi-skill-select-");
	const config = loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { quick: { backend: "local", model: "m" } },
		jev: { endpoint: stub.url, apiKey: "test-key", model: "jev-latest", mode: "enabled" },
		skills: { maxLoaded: MAX_LOADED, state: {} },
		...overrides,
	});
	const client = createJevClient({ config, cwd });
	return { stub, config, client, cwd, close: () => stub.close() };
}

let cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	clearLanes();
	for (const cleanup of cleanups) await cleanup();
	cleanups = [];
});

describe("PRD-005 Phase 2 — skill disclosure", () => {
	it("AC-4: the assembled request carries exactly the selected bodies and nothing else", async () => {
		const { records, cwd } = corpus();
		const active = await harness([skillResponder(["debugging"])]);
		cleanups.push(active.close);

		const selected = await selectSkills({
			records,
			control: createSkillControl(),
			request: "selecting the torpedo sometimes crashes the aircraft game",
			config: active.config,
			client: active.client,
		});
		expect(selected.decision.loaded).toEqual(["debugging"]);
		const assembled = assemble({ config: active.config, skills: selected.skills });
		expect(assembled.text).toContain("BODY_OF_debugging");
		for (const unselected of ["aux-helper", "unrelated-skill", "dup", "gen-000"]) {
			expect(assembled.text, unselected).not.toContain(`BODY_OF_${unselected}`);
		}
		expect(selected.skills.length).toBeLessThanOrEqual(MAX_LOADED);

		// "No skill required" is the normal, cheapest outcome: no skill block at all.
		const noneStub = await startStubJev([skillResponder([], false)]);
		cleanups.push(() => noneStub.close());
		const noneConfig = { ...active.config, jev: { ...active.config.jev, endpoint: noneStub.url } };
		const none = await selectSkills({
			records,
			control: createSkillControl(),
			request: "selecting the torpedo sometimes crashes the aircraft game",
			config: noneConfig,
			client: createJevClient({ config: noneConfig, cwd }),
		});
		expect(none.skills).toEqual([]);
		const emptyPrompt = assemble({ config: active.config, skills: none.skills });
		expect(emptyPrompt.text).not.toContain("### skill:");
		expect(emptyPrompt.text).not.toContain("BODY_OF_");

		// And the same assembled text reaches a real provider request.
		const backend = await startStubBackend([{ text: "ok" }]);
		cleanups.push(() => backend.close());
		const { cwd: repo, agentDir } = fixtureRepo();
		writeConfig(repo, {
			backends: { local: nativeBackend(backend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
			skills: { maxLoaded: MAX_LOADED },
		});
		const session = await bootSession({ cwd: repo, agentDir });
		registerLane({
			name: "skills-lane",
			async run(_turn, context) {
				const chosen = await selectSkills({
					records,
					control: createSkillControl(),
					request: "selecting the torpedo sometimes crashes the aircraft game",
					config: context.config,
					client: active.client,
				});
				context.skills = chosen.skills;
			},
		});
		await session.runTurn("selecting the torpedo sometimes crashes the aircraft game");
		const sent = JSON.stringify(backend.requests[0]!.body);
		expect(sent).toContain("BODY_OF_debugging");
		expect(sent).not.toContain("BODY_OF_unrelated-skill");
		session.session.dispose();
	});

	it("AC-3: a pin bypasses relevance, and disabling a pinned skill wins", async () => {
		const { records } = corpus();
		const active = await harness([skillResponder([])]);
		cleanups.push(active.close);
		const persisted: Record<string, { enabled?: boolean; pinned?: boolean }> = {};
		const control = createSkillControl(persisted);

		expect(control.pin("unrelated-skill").ok).toBe(true);
		const selected = await selectSkills({
			records,
			control,
			request: "selecting the torpedo sometimes crashes the aircraft game",
			config: active.config,
			client: active.client,
		});
		// The relevance answer was "not relevant" for every candidate, yet the pin loaded.
		expect(selected.decision.pinned).toEqual(["unrelated-skill"]);
		const pinnedPrompt = assemble({ config: active.config, skills: selected.skills });
		expect(pinnedPrompt.text).toContain("BODY_OF_unrelated-skill");

		control.disable("unrelated-skill");
		expect(control.pin("unrelated-skill").ok).toBe(false);
		const afterDisable = await selectSkills({
			records,
			control,
			request: "selecting the torpedo sometimes crashes the aircraft game",
			config: active.config,
			client: active.client,
		});
		const disabledPrompt = assemble({ config: active.config, skills: afterDisable.skills });
		expect(disabledPrompt.text).not.toContain("BODY_OF_unrelated-skill");
		expect(afterDisable.decision.pinned).toEqual([]);
	});

	it("AC-7: the trusted project copy of a duplicated skill is the one that reaches the request", async () => {
		const { records, bodyOf } = corpus();
		const active = await harness([skillResponder(["dup"])]);
		cleanups.push(active.close);

		const selected = await selectSkills({
			records,
			control: createSkillControl(),
			request: "use the duplicate fixture skill",
			config: active.config,
			client: active.client,
		});
		expect(selected.decision.loaded).toEqual(["dup"]);
		const assembled = assemble({ config: active.config, skills: selected.skills });
		expect(assembled.text).toContain("BODY_OF_dup");
		expect(assembled.text).toContain("project copy of the duplicate skill");
		expect(assembled.text).not.toContain("user copy of the duplicate skill");
		expect(selected.skills[0]!.source).toContain(".claude/skills/dup/SKILL.md");
		expect(selected.skills[0]!.source).not.toContain(bodyOf("gen-000"));
	});

	it("AC-6: JEV off keeps the pipeline working lexically, pins included, and says so in telemetry", async () => {
		const { records } = corpus();
		const active = await harness([skillResponder(["aux-helper"])]);
		cleanups.push(active.close);

		const jevSelected = await selectSkills({
			records,
			control: createSkillControl(),
			request: "selecting the torpedo sometimes crashes the aircraft game",
			config: active.config,
			client: active.client,
		});
		expect(jevSelected.decision.loaded).toEqual(["aux-helper"]);
		expect(jevSelected.decision.fallbackUsed).toBe(false);

		// Disabled JEV: same registry, lexical/tag routing, pins still honored.
		const offConfig = { ...active.config, jev: { ...active.config.jev, mode: "disabled" as const } };
		const offClient = createJevClient({ config: offConfig, cwd: active.cwd });
		const control = createSkillControl();
		expect(control.pin("unrelated-skill").ok).toBe(true);
		const lexical = await selectSkills({
			records,
			control,
			request: "selecting the torpedo sometimes crashes the aircraft game",
			config: offConfig,
			client: offClient,
		});
		expect(lexical.decision.fallbackUsed).toBe(true);
		expect(lexical.decision.loaded).toContain("unrelated-skill");
		// Two JEV requests for the enabled run (relevance, then fit) and none added
		// by the disabled run.
		expect(active.stub.requests).toHaveLength(2);
		// The JEV answer, not the heuristic, decided the set.
		expect(lexical.decision.loaded).not.toEqual(jevSelected.decision.loaded);

		// The telemetry row records the fallback.
		const rows = readFileSync(decisionLogPath(active.cwd), "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as { siteId: string; fallbackUsed: boolean });
		expect(rows.some((row) => row.siteId === "skill.disclosure" && row.fallbackUsed)).toBe(true);
	});
});
