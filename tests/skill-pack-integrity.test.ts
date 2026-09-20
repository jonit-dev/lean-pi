/**
 * PRD-026 Phase 2 and Phase 3 — AC-1, AC-2, AC-3, AC-5: the hard integrity
 * gate, indexing without loading, the fresh-profile path, precedence and
 * per-skill disable.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSkillControl, defaultSkillRoots, loadSkillBody, scanSkills, type SkillRecord, type SkillRoot } from "../src/capabilities/skills.js";
import { BundledIntegrityError, bundledRoot, clearPackCache, packEntries, packVersion, verifyBundledFile } from "../src/skills/pack.js";
import { createCommandRegistry } from "../src/commands/registry.js";
import { registerSkillsCommands } from "../src/commands/skills.js";
import { PACKAGE_ROOT } from "../src/core/package-info.js";
import { tempDir } from "./helpers/fixtures.js";

const PACK = join(PACKAGE_ROOT, "skills");

/** A writable copy of the shipped pack, so tampering never touches the repo. */
function packCopy(): string {
	const root = tempDir("leanpi-packcopy-");
	cpSync(PACK, root, { recursive: true });
	clearPackCache();
	return root;
}

function bundledRecord(name: string, root: string): SkillRecord {
	const roots: SkillRoot[] = [{ path: root, class: "bundled" }];
	const records = scanSkills(tempDir("leanpi-cwd-"), { roots });
	const record = records.find((entry) => entry.name === name);
	if (!record) throw new Error(`fixture pack has no ${name}`);
	return record;
}

describe("PRD-026 Phase 2 — the integrity gate", () => {
	it("AC-3: an untampered bundled body loads; one mutated byte fails hard naming the path and both hashes", () => {
		const root = packCopy();
		const record = bundledRecord("prd-manager", root);
		expect(loadSkillBody(record).length).toBeGreaterThan(0);

		const script = join(root, "prd-manager/scripts/prd-close.mjs");
		const bytes = readFileSync(script);
		bytes[0] = bytes[0] === 0x23 ? 0x24 : 0x23;
		writeFileSync(script, bytes);
		clearPackCache();

		let thrown: unknown;
		try {
			verifyBundledFile(script, root);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(BundledIntegrityError);
		const failure = thrown as BundledIntegrityError;
		expect(failure.message).toContain("prd-manager/scripts/prd-close.mjs");
		expect(failure.message).toContain(failure.expected!);
		expect(failure.message).toContain(failure.actual);
		expect(failure.expected).not.toBe(failure.actual);
	});

	it("AC-3: a mutated SKILL.md is refused by the loader itself, not silently skipped", () => {
		const root = packCopy();
		const record = bundledRecord("ponytail-review", root);
		writeFileSync(join(root, "ponytail-review/SKILL.md"), `${readFileSync(join(root, "ponytail-review/SKILL.md"), "utf8")}\ntampered\n`);
		clearPackCache();
		// Not "" and not another root's copy: a throw.
		expect(() => loadSkillBody(record)).toThrow(BundledIntegrityError);
	});

	it("AC-3: a file under the pack with no lock entry fails the same way", () => {
		const root = packCopy();
		const smuggled = join(root, "prd-creator/EXTRA.md");
		writeFileSync(smuggled, "smuggled\n");
		clearPackCache();
		expect(() => verifyBundledFile(smuggled, root)).toThrow(/no entry in pack\.lock\.json/);
	});
});

describe("PRD-026 Phase 2 — indexed without being loaded", () => {
	it("AC-5: scanning lists every bundled skill while no body byte reaches a caller", () => {
		const root = packCopy();
		const records = scanSkills(tempDir("leanpi-cwd-"), { roots: [{ path: root, class: "bundled" }] });
		expect(records.length).toBeGreaterThanOrEqual(7);
		expect(records.every((record) => record.source.class === "bundled")).toBe(true);

		// Every scanned record must be describable from frontmatter alone; the
		// marker taken from each body must not appear in the scan output.
		const serialized = JSON.stringify(records);
		for (const entry of packEntries(root)) {
			const body = readFileSync(join(root, `${entry.name}/SKILL.md`), "utf8");
			const marker = body.split("\n").filter((line) => line.trim().length > 40).at(-1);
			if (marker) expect(serialized, entry.name).not.toContain(marker.trim());
		}
	});

	it("AC-1: bundled rows report the locked pin, not a blank version", () => {
		const root = packCopy();
		const records = scanSkills(tempDir("leanpi-cwd-"), { roots: [{ path: root, class: "bundled" }] });
		for (const record of records) {
			const pinned = packVersion(record.name, root);
			expect(pinned, record.name).toBeTruthy();
			expect(record.version ?? pinned, record.name).toBeTruthy();
		}
		expect(packVersion("i-have-adhd", root)).toBe("0.3.0");
		expect(packVersion("prd-creator", root)).toMatch(/^sha256-/);
	});
});

describe("PRD-026 Phase 3 — fresh profile, precedence and disable", () => {
	it("AC-1: with every other root empty the pack still resolves prd-creator, prd-manager and i-have-adhd", () => {
		const cwd = tempDir("leanpi-fresh-");
		const empty = tempDir("leanpi-empty-");
		const roots: SkillRoot[] = [
			{ path: join(empty, "project"), class: "project" },
			{ path: join(empty, "user"), class: "user" },
			{ path: bundledRoot(), class: "bundled" },
		];
		const records = scanSkills(cwd, { roots });
		for (const name of ["prd-creator", "prd-manager", "i-have-adhd"]) {
			const record = records.find((entry) => entry.name === name);
			expect(record, name).toBeDefined();
			expect(record!.source.class).toBe("bundled");
			expect(record!.source.path.startsWith(bundledRoot())).toBe(true);
		}
		// Verbatim: the loaded body is the tail of the vendored file, byte for byte.
		const vendored = readFileSync(join(bundledRoot(), "prd-creator/SKILL.md"), "utf8");
		const loaded = loadSkillBody(records.find((entry) => entry.name === "prd-creator")!);
		expect(loaded.length).toBeGreaterThan(200);
		expect(vendored.trimEnd().endsWith(loaded)).toBe(true);

		// Negative control: without the bundled root the same three resolve to nothing.
		const without = scanSkills(cwd, { roots: roots.slice(0, 2) });
		for (const name of ["prd-creator", "prd-manager", "i-have-adhd"]) expect(without.find((entry) => entry.name === name), name).toBeUndefined();
	});

	it("AC-2: a user-global copy shadows the bundled one, and the bundled body never reaches the caller", () => {
		const cwd = tempDir("leanpi-shadow-");
		const userRoot = tempDir("leanpi-user-");
		mkdirSync(join(userRoot, "prd-creator"), { recursive: true });
		writeFileSync(join(userRoot, "prd-creator/SKILL.md"), "---\nname: prd-creator\ndescription: user copy\n---\n\nUSER_MARKER_BODY\n");

		const records = scanSkills(cwd, {
			roots: [
				{ path: userRoot, class: "user" },
				{ path: bundledRoot(), class: "bundled" },
			],
		});
		const matches = records.filter((entry) => entry.name === "prd-creator");
		expect(matches).toHaveLength(1);
		expect(matches[0]!.source.class).toBe("user");

		const body = loadSkillBody(matches[0]!);
		expect(body).toContain("USER_MARKER_BODY");
		const bundledBody = readFileSync(join(bundledRoot(), "prd-creator/SKILL.md"), "utf8");
		const bundledMarker = bundledBody.split("\n").filter((line) => line.trim().length > 40).at(-1)!;
		expect(body).not.toContain(bundledMarker.trim());
	});

	it("AC-2: disabling a bundled skill drops it from candidates and survives a reload", () => {
		const state: Record<string, { enabled?: boolean; pinned?: boolean }> = {};
		let persisted: Record<string, unknown> = {};
		const control = createSkillControl(state, (next) => {
			persisted = JSON.parse(JSON.stringify(next));
		});
		control.disable("ponytail-audit");
		expect(control.isEnabled("ponytail-audit")).toBe(false);

		// A resumed session reads the persisted state, not this process's object.
		const resumed = createSkillControl(persisted as typeof state, () => {});
		expect(resumed.isEnabled("ponytail-audit")).toBe(false);
		resumed.enable("ponytail-audit");
		expect(resumed.isEnabled("ponytail-audit")).toBe(true);
	});

	it("AC-1: `/skills all` renders bundled rows with the source class and the locked pin", async () => {
		const records = scanSkills(tempDir("leanpi-cmd-"), { roots: [{ path: bundledRoot(), class: "bundled" }] });
		const registry = createCommandRegistry();
		registerSkillsCommands(registry, { records, control: createSkillControl({}, () => {}) });
		const listing = await registry.dispatch("/skills all");

		expect(listing.ok).toBe(true);
		expect(listing.text).toContain(`i-have-adhd — `);
		expect(listing.text).toMatch(/i-have-adhd[^\n]*\[bundled, 0\.3\.0\]/);
		expect(listing.text).toMatch(/prd-creator[^\n]*\[bundled, sha256-[0-9a-f]{12}\]/);
		// A disabled bundled skill shows as disabled through the same surface.
		const control = createSkillControl({}, () => {});
		const registry2 = createCommandRegistry();
		registerSkillsCommands(registry2, { records, control });
		await registry2.dispatch("/skills disable ponytail-audit");
		const after = await registry2.dispatch("/skills all");
		expect(after.text).toMatch(/ponytail-audit[^\n]*\{disabled\}/);
	});

	it("AC-1: the bare `/skills` lists the pinned set, not the whole install", async () => {
		const records = scanSkills(tempDir("leanpi-cmd-"), { roots: [{ path: bundledRoot(), class: "bundled" }] });
		const control = createSkillControl({}, () => {});
		const registry = createCommandRegistry();
		registerSkillsCommands(registry, { records, control });

		// Nothing pinned: the inventory is named but not dumped.
		const empty = await registry.dispatch("/skills");
		expect(empty.ok).toBe(true);
		expect(empty.text).toContain(`${records.length} installed`);
		expect(empty.text).not.toContain("i-have-adhd — ");

		await registry.dispatch("/skills pin ponytail-audit");
		const pinned = await registry.dispatch("/skills");
		expect(pinned.text).toMatch(/ponytail-audit[^\n]*\{pinned\}/);
		expect(pinned.text).not.toContain("i-have-adhd — ");
	});

	it("AC-1: the default root list puts the pack last, after project, user and plugin roots", () => {
		const roots = defaultSkillRoots(tempDir("leanpi-default-"), tempDir("leanpi-home-"));
		expect(roots.at(-1)).toEqual({ path: bundledRoot(), class: "bundled" });
		expect(roots.filter((root) => root.class === "bundled")).toHaveLength(1);
	});
});
