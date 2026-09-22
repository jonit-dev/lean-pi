/**
 * SURF-4 (same root cause, every consumer): the session registry was not the
 * only place that fell back to `defaultSkillRoots`. `/doctor` and PRD authoring
 * did too, so an untrusted repository could still index — and a PRD lane could
 * still load — its own `.claude/skills`. The trust filter now lives in one
 * shared selection path, `defaultRuntimeSkillRoots`, that all three call.
 *
 * `defaultSkillRoots` stays the full inventory: it must keep returning the
 * project root so a caller can reason about what a trusted project would
 * contribute.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRuntimeSkillRoots, defaultSkillRoots, grantTrust, loadConfig } from "../src/index.js";
import { resolveInstalledSkill } from "../src/prd/creator.js";
import { surfaceFixture } from "./commands/helpers.js";
import { nativeBackend, tempDir, writeConfig } from "./helpers/fixtures.js";

const CONFIG = {
	backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
	models: { quick: { backend: "local", model: "stub-model" } },
};

function projectWithSkill(): string {
	const cwd = tempDir("leanpi-skilltrust-");
	mkdirSync(join(cwd, ".claude", "skills", "proj-secret"), { recursive: true });
	writeFileSync(join(cwd, ".claude", "skills", "proj-secret", "SKILL.md"), "---\nname: proj-secret\ndescription: shipped by the checkout\n---\n\nbody\n");
	return cwd;
}

describe("SURF-4: the runtime default skill roots respect trust", () => {
	it("keeps the inventory whole but gates the project root in the runtime selection", () => {
		const cwd = projectWithSkill();
		const inventory = defaultSkillRoots(cwd, tempDir("leanpi-home-")).map((root) => root.path);
		expect(inventory).toContain(join(cwd, ".claude", "skills"));

		expect(defaultRuntimeSkillRoots(cwd, false, tempDir("leanpi-home-")).map((root) => root.path)).not.toContain(join(cwd, ".claude", "skills"));
		expect(defaultRuntimeSkillRoots(cwd, true, tempDir("leanpi-home-")).map((root) => root.path)).toContain(join(cwd, ".claude", "skills"));
	});

	it("does not index the project root in `/doctor` while untrusted", async () => {
		const cwd = projectWithSkill();
		const fixture = surfaceFixture({ config: CONFIG, cwd, writeConfigFile: true });
		const doctor = await fixture.dispatch("/doctor");
		expect(doctor.ok).toBe(true);
		expect(doctor.text).not.toContain(join(cwd, ".claude", "skills"));
	});

	it("does not resolve a project-local PRD authoring skill while untrusted", () => {
		const cwd = projectWithSkill();
		writeConfig(cwd, CONFIG);
		const env = { HOME: tempDir("leanpi-home-"), XDG_CONFIG_HOME: tempDir("leanpi-xdg-") };
		const untrusted = loadConfig(cwd, {}, env);
		expect(resolveInstalledSkill({ cwd, config: untrusted, name: "proj-secret" })).toBeNull();

		grantTrust(cwd, env);
		const trusted = loadConfig(cwd, {}, env);
		expect(resolveInstalledSkill({ cwd, config: trusted, name: "proj-secret" })).not.toBeNull();
	});
});
