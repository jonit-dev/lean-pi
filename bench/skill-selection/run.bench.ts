/**
 * Skill-selection benchmark (PRD-005 Phase 2, AC-5).
 *
 * Replays `fixtures.jsonl` — positively-labelled requests naming an expected
 * installed skill, and negatively-labelled requests that need none — through the
 * shipped `selectSkills()` pipeline against the machine's real skill corpus, and
 * reports measured wrong-load and unnecessary-load rates next to the ROADMAP §5
 * figures, which are recorded as comparison context and not as claims about
 * LeanPi. The run fails when the measured unnecessary-load rate exceeds
 * `bench.skills.maxUnnecessaryLoadRate`.
 *
 * Run: `pnpm bench:skills`.
 */
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createJevClient, createSkillControl, defaultSkillRoots, loadConfig, PACKAGE_ROOT, scanSkills, selectSkills } from "../../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROADMAP_TARGETS = {
	wrong_load_rate: 0.073,
	unnecessary_load_rate: 0.04,
	note: "ROADMAP §5 TypeSafe 488-request experiment — recorded as comparison context, not a claim about LeanPi",
};

interface Fixture {
	request: string;
	expected: string | null;
}

describe("PRD-005 AC-5 — skill-selection benchmark", () => {
	it("measures wrong-load and unnecessary-load rates over the labelled fixture set", async () => {
		const cwd = PACKAGE_ROOT;
		// The benchmark measures the shipped pipeline. It uses the real JEV service
		// when a key resolves (the repo `.env` is gitignored), and the deterministic
		// lexical path otherwise — the report records which mode produced the numbers.
		const envFile = join(PACKAGE_ROOT, ".env");
		if (existsSync(envFile)) process.loadEnvFile(envFile);
		const hasKey = typeof process.env.JEV_API_KEY === "string" && process.env.JEV_API_KEY.length > 0;
		const config = loadConfig(cwd, {
			configPath: null,
			backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
			models: { quick: { backend: "local", model: "bench" } },
			jev: { mode: hasKey && process.env.LEANPI_BENCH_LEXICAL !== "1" ? "enabled" : "disabled" },
		});
		const records = scanSkills(cwd, { roots: defaultSkillRoots(cwd, homedir()) });
		const control = createSkillControl();
		const client = createJevClient({ config, cwd });

		const fixtures: Fixture[] = readFileSync(join(here, "fixtures.jsonl"), "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Fixture);
		expect(fixtures.length).toBeGreaterThanOrEqual(40);
		expect(fixtures.filter((fixture) => fixture.expected !== null).length).toBeGreaterThanOrEqual(20);
		expect(fixtures.filter((fixture) => fixture.expected === null).length).toBeGreaterThanOrEqual(20);

		const rows: Array<Record<string, unknown>> = [];
		let wrongLoads = 0;
		let unnecessaryLoads = 0;
		let positives = 0;
		let negatives = 0;

		for (const fixture of fixtures) {
			const { skills, decision } = await selectSkills({ records, control, request: fixture.request, config, client });
			const loaded = skills.map((skill) => skill.name);
			const wrong = fixture.expected !== null && !loaded.includes(fixture.expected);
			const unnecessary = fixture.expected === null && loaded.length > 0;
			if (fixture.expected !== null) positives += 1;
			else negatives += 1;
			if (wrong) wrongLoads += 1;
			if (unnecessary) unnecessaryLoads += 1;
			rows.push({
				request: fixture.request,
				expected: fixture.expected,
				loaded,
				wrong_load: wrong,
				unnecessary_load: unnecessary,
				fallback_used: decision.fallbackUsed,
				reason: decision.reason,
			});
		}

		const wrongLoadRate = wrongLoads / positives;
		const unnecessaryLoadRate = unnecessaryLoads / negatives;
		const ceiling = config.bench.skills.maxUnnecessaryLoadRate;
		const verdict = unnecessaryLoadRate <= ceiling ? "pass" : "fail";

		const report = {
			mode: config.jev.mode === "disabled" ? "lexical" : "jev",
			corpus_size: records.length,
			fixtures: fixtures.length,
			positives,
			negatives,
			wrong_loads: wrongLoads,
			unnecessary_loads: unnecessaryLoads,
			wrong_load_rate: wrongLoadRate,
			unnecessary_load_rate: unnecessaryLoadRate,
			ceiling,
			verdict,
			roadmap_targets: ROADMAP_TARGETS,
			rows,
		};
		writeFileSync(join(here, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

		// Every negatively-labelled request loads zero bodies.
		expect(rows.filter((row) => row.unnecessary_load).map((row) => row.request)).toEqual([]);
		expect(verdict).toBe("pass");
		expect(unnecessaryLoadRate).toBeLessThanOrEqual(ceiling);
	}, 120_000);
});
