/**
 * PRD-005 Phase 1 — AC-1 and AC-2: the out-of-context registry and its controls.
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createSkillControl,
	defaultSkillRoots,
	loadConfig,
	scanSkills,
	resetScanStats,
	scanStats,
	FRONTMATTER_READ_LIMIT,
	writeSkillsState,
	type SkillRoot,
} from "../src/index.js";
import { nativeBackend, tempDir, writeConfig } from "./helpers/fixtures.js";

const BODY_MARKER = "BODY_MARKER_THAT_MUST_NEVER_BE_INDEXED";

function writeSkill(root: string, name: string, frontmatter: string, body = `${BODY_MARKER}\n`.repeat(4000)): void {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(join(root, name, "SKILL.md"), `---\n${frontmatter}\n---\n\n# ${name}\n\n${body}`);
}

describe("PRD-005 Phase 1 — skill registry", () => {
	it("AC-1: precedence is project > user global > plugin, and no body is read", () => {
		const cwd = tempDir("leanpi-skills-");
		const roots: SkillRoot[] = [
			{ path: join(cwd, ".claude/skills"), class: "project" },
			{ path: join(cwd, "user-skills"), class: "user" },
			{ path: join(cwd, "plugin-skills"), class: "plugin" },
		];
		for (const [index, root] of roots.entries()) {
			writeSkill(root.path, "dup", `name: dup\ndescription: copy number ${index}\ntags: [fixture]`);
			writeSkill(root.path, `only-${root.class}`, `name: only-${root.class}\ndescription: only in ${root.class}`);
		}

		resetScanStats();
		const records = scanSkills(cwd, { roots });
		const dup = records.filter((record) => record.name === "dup");
		expect(dup).toHaveLength(1);
		expect(dup[0]!.source.class).toBe("project");
		expect(dup[0]!.source.path).toBe(join(cwd, ".claude/skills/dup/SKILL.md"));
		expect(dup[0]!.description).toBe("copy number 0");
		expect(records.map((record) => record.name).sort()).toEqual(["dup", "only-plugin", "only-project", "only-user"]);

		// The out-of-context claim, measured: a ~140 KB body per skill is never
		// indexed. The scan touches at most one frontmatter-sized head per file,
		// which is a small fraction of what is on disk.
		expect(JSON.stringify(records)).not.toContain(BODY_MARKER);
		expect(scanStats.bytesRead).toBeLessThanOrEqual(scanStats.files * FRONTMATTER_READ_LIMIT);
		const onDisk = records.reduce((total, record) => total + statSync(record.source.path).size, 0);
		expect(scanStats.bytesRead).toBeLessThan(onDisk / 10);

		// Pointing at an empty root yields nothing: the count assertion is sensitive.
		expect(scanSkills(cwd, { roots: [{ path: tempDir("leanpi-empty-"), class: "user" }] })).toEqual([]);
	});

	// This machine's real `$HOME/.claude/skills` install; skipped unless asked
	// for, because another machine's roots are not this suite's contract — and
	// on a clean runner `prd-creator` resolves to the bundled copy instead.
	const realInstall = process.env.LEANPI_REAL_SKILLS === "1" ? it : it.skip;
	realInstall("AC-1: the machine's real roots produce a library, prd-creator resolving to the .claude copy", () => {
		const cwd = tempDir("leanpi-skills-real-");
		const roots = defaultSkillRoots(cwd, homedir());
		resetScanStats();
		const records = scanSkills(cwd, { roots });

		expect(records.length).toBeGreaterThan(0);
		const prdCreator = records.find((record) => record.name === "prd-creator");
		expect(prdCreator?.source.path.endsWith(".claude/skills/prd-creator/SKILL.md")).toBe(true);
		expect(JSON.stringify(records)).not.toContain(BODY_MARKER);
		expect(scanStats.bytesRead).toBeLessThan(scanStats.files * 4096);
	});

	it("AC-2: disable wins over pin, state persists, and enable restores", () => {
		const cwd = tempDir("leanpi-skills-state-");
		writeConfig(cwd, {
			backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
			models: { quick: { backend: "local", model: "m" } },
		});
		const roots: SkillRoot[] = [{ path: join(cwd, "skills"), class: "user" }];
		writeSkill(join(cwd, "skills"), "alpha", "name: alpha\ndescription: first skill\ntags: [alpha]");
		const records = scanSkills(cwd, { roots });

		// Persist through PRD-001's config writer so a resume rehydrates it.
		const persisted: Record<string, { enabled?: boolean; pinned?: boolean }> = {};
		const control = createSkillControl(persisted, (state) => writeSkillsState(cwd, state));
		expect(control.candidates(records).map((record) => record.name)).toEqual(["alpha"]);

		control.disable("alpha");
		expect(control.isEnabled("alpha")).toBe(false);
		expect(control.candidates(records)).toEqual([]);
		expect(control.pin("alpha")).toEqual({ ok: false, message: expect.stringContaining("disabled") });
		expect(control.isPinned("alpha")).toBe(false);
		expect(control.isEnabled("alpha")).toBe(false);

		// Resume: a fresh control hydrated from the persisted config sees the same state.
		const resumed = createSkillControl(loadConfig(cwd).skills.state);
		expect(resumed.isEnabled("alpha")).toBe(false);
		expect(resumed.candidates(records)).toEqual([]);

		resumed.enable("alpha");
		expect(resumed.candidates(records).map((record) => record.name)).toEqual(["alpha"]);
		expect(resumed.pin("alpha").ok).toBe(true);
		expect(resumed.isPinned("alpha")).toBe(true);
		// Pinned skills leave the ranking pool but are still loaded unconditionally.
		expect(resumed.candidates(records)).toEqual([]);
		expect(resumed.pinnedRecords(records).map((record) => record.name)).toEqual(["alpha"]);
	});
});
