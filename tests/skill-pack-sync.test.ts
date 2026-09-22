/**
 * PRD-026 Phase 1 — AC-4, AC-6, AC-7: the sync tool's allowlist, symlink and
 * licence rules, its idempotence, the generated notice, and what the published
 * package actually contains.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkPack, listPackFiles, PACK_UNLOCKED, readJson, renderNotice, VendorError, vendorPack } from "../src/skills/vendor.mjs";
import { PACKAGE_ROOT } from "../src/core/package-info.js";
import { tempDir } from "./helpers/fixtures.js";

/**
 * The published file list, packed once per process. `npm pack --dry-run` triggers
 * `prepack` (vendor + tsc), which on a cold, loaded CI runner exceeds the 30s
 * default, so two assertions must not pack twice.
 */
let packedPaths: Set<string> | undefined;
function publishedPaths(): Set<string> {
	packedPaths ??= new Set(
		(
			JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: PACKAGE_ROOT, encoding: "utf8" })) as Array<{ files: Array<{ path: string }> }>
		)[0]!.files.map((file) => file.path),
	);
	return packedPaths;
}

/** An upstream that reproduces both hazards the PRD names: a symlink and a `.bak`. */
function fixtureUpstream(options: { adhdVersion?: string; licenceless?: boolean } = {}): string {
	const root = tempDir("leanpi-upstream-");
	const real = join(root, "real/prd-creator");
	mkdirSync(real, { recursive: true });
	writeFileSync(join(real, "SKILL.md"), "---\nname: prd-creator\ndescription: authoring\n---\n\nBODY_CREATOR\n");
	writeFileSync(join(real, "SKILL.md.bak"), "---\nname: stale\n---\n\nBACKUP_MUST_NOT_SHIP\n");
	mkdirSync(join(root, "skills"), { recursive: true });
	symlinkSync(real, join(root, "skills/prd-creator"));

	const adhd = join(root, `plugins/cache/i-have-adhd/i-have-adhd/${options.adhdVersion ?? "0.3.0"}/skills/i-have-adhd`);
	mkdirSync(join(adhd, "agents"), { recursive: true });
	writeFileSync(join(adhd, "SKILL.md"), "---\nname: i-have-adhd\nlicense: MIT\n---\n\nBODY_ADHD\n");
	writeFileSync(join(adhd, "agents/openai.yaml"), "agent: openai\n");
	writeFileSync(join(dirname(dirname(adhd)), "LICENSE"), "MIT License\n\nCopyright (c) 2026 Ayoub Ghriss\n");

	if (options.licenceless) {
		const bare = join(root, "skills/no-licence");
		mkdirSync(bare, { recursive: true });
		writeFileSync(join(bare, "SKILL.md"), "---\nname: no-licence\n---\n\nBODY_BARE\n");
	}
	return root;
}

function fixtureSpec(options: { adhdVersion?: string; includeLicenceless?: boolean } = {}) {
	const spec = [
		{ name: "prd-creator", source: "skills/prd-creator", allowlist: ["SKILL.md"], licence: "First-party", attribution: "joao" },
		{ name: "i-have-adhd", source: `plugins/cache/i-have-adhd/i-have-adhd/${options.adhdVersion ?? "0.3.0"}/skills/i-have-adhd`, allowlist: ["SKILL.md", "agents/**"], attribution: "Ayoub Ghriss" },
	];
	if (options.includeLicenceless) spec.push({ name: "no-licence", source: "skills/no-licence", allowlist: ["SKILL.md"], attribution: "nobody" } as (typeof spec)[number]);
	return spec;
}

describe("PRD-026 Phase 1 — the sync tool", () => {
	it("AC-4: vendors the allowlist only, resolves the symlink, and pins the bumped version", () => {
		const sourceRoot = fixtureUpstream({ adhdVersion: "0.4.0" });
		const destRoot = tempDir("leanpi-pack-");
		const lock = vendorPack({ spec: fixtureSpec({ adhdVersion: "0.4.0" }), sourceRoot, destRoot });

		const files = listPackFiles(destRoot);
		expect(files).toContain("prd-creator/SKILL.md");
		// The stray backup next to the symlinked SKILL.md must not ship.
		expect(files.some((file) => file.endsWith(".bak"))).toBe(false);
		// The symlink was followed: the pack holds the real file's content.
		expect(readFileSync(join(destRoot, "prd-creator/SKILL.md"), "utf8")).toContain("BODY_CREATOR");

		const adhd = lock.skills.find((skill) => skill.name === "i-have-adhd")!;
		expect(adhd.version).toBe("0.4.0");
		expect(adhd.licence).toBe("MIT");
		expect(adhd.files.map((file) => file.path)).toContain("i-have-adhd/LICENSE");
		for (const file of adhd.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);

		// A skill that declares no version gets a content pin, never a blank.
		expect(lock.skills.find((skill) => skill.name === "prd-creator")!.version).toMatch(/^sha256-[0-9a-f]{12}$/);
	});

	it("AC-4: a second run with no upstream change leaves the lock byte-identical, syncedAt included", () => {
		const sourceRoot = fixtureUpstream();
		const destRoot = tempDir("leanpi-pack-");
		const spec = fixtureSpec();
		const first = vendorPack({ spec, sourceRoot, destRoot, now: () => new Date("2026-01-01T00:00:00.000Z") });
		const second = vendorPack({ spec, sourceRoot, destRoot, previousLock: first, now: () => new Date("2026-06-06T06:06:06.000Z") });
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));

		// A real upstream change does move the stamp — the negative control that
		// proves the equality above is not just a frozen clock.
		writeFileSync(join(sourceRoot, "real/prd-creator/SKILL.md"), "---\nname: prd-creator\n---\n\nBODY_CREATOR_V2\n");
		const third = vendorPack({ spec, sourceRoot, destRoot, previousLock: second, now: () => new Date("2026-06-06T06:06:06.000Z") });
		const changed = third.skills.find((skill) => skill.name === "prd-creator")!;
		expect(changed.syncedAt).toBe("2026-06-06T06:06:06.000Z");
		expect(third.skills.find((skill) => skill.name === "i-have-adhd")!.syncedAt).toBe(first.skills.find((skill) => skill.name === "i-have-adhd")!.syncedAt);
	});

	it("AC-7: an unlicensable skill aborts the run and vendors nothing", () => {
		const sourceRoot = fixtureUpstream({ licenceless: true });
		const destRoot = tempDir("leanpi-pack-");
		expect(() => vendorPack({ spec: fixtureSpec({ includeLicenceless: true }), sourceRoot, destRoot })).toThrow(VendorError);
		expect(() => vendorPack({ spec: fixtureSpec({ includeLicenceless: true }), sourceRoot, destRoot })).toThrow(/no-licence/);
		// Nothing was written: the abort happens before the first copy.
		expect(listPackFiles(destRoot)).toEqual([]);
	});

	it("AC-7: the shipped lock and notice carry a licence and attribution for every entry", () => {
		const lock = readJson(join(PACKAGE_ROOT, "skills/pack.lock.json"));
		expect(lock.skills.length).toBeGreaterThanOrEqual(7);
		for (const skill of lock.skills) {
			expect(skill.licence, skill.name).toBeTruthy();
			expect(skill.attribution, skill.name).toBeTruthy();
			expect(skill.version, skill.name).toBeTruthy();
			// No machine path is written into a shipped file.
			expect(skill.source, skill.name).not.toContain("/home/");
		}
		const notice = readFileSync(join(PACKAGE_ROOT, "skills/NOTICE.md"), "utf8");
		for (const skill of lock.skills) expect(notice).toContain(`\`${skill.name}\``);
		expect(notice).toBe(renderNotice(lock));
		// An MIT upstream's LICENSE travels with the bytes.
		expect(existsSync(join(PACKAGE_ROOT, "skills/i-have-adhd/LICENSE"))).toBe(true);
	});

	it("AC-6: the published file list carries the pack, no ponytail skill copy and no install hook", () => {
		const published = publishedPaths();
		const lock = readJson(join(PACKAGE_ROOT, "skills/pack.lock.json"));

		for (const skill of lock.skills) for (const file of skill.files) expect(published.has(`skills/${file.path}`), file.path).toBe(true);
		expect(published.has("skills/pack.lock.json")).toBe(true);
		expect(published.has("skills/NOTICE.md")).toBe(true);
		// The Ponytail prefix is PRD-001's and is not duplicated as a pack entry.
		expect([...published].some((path) => path.startsWith("skills/ponytail/"))).toBe(false);
		expect(published.has("src/core/instructions/ponytail.md")).toBe(true);

		const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
		for (const hook of ["install", "postinstall", "preinstall", "prepare"]) expect(manifest.scripts[hook], hook).toBeUndefined();
		// `npm pack --dry-run` triggers `prepack` (vendor + tsc), which on a cold,
		// loaded CI runner exceeds the 30s default.
	}, 120_000);

	it("AC-6: the packed bin entry point can resolve every relative import it makes", () => {
		// A shipped `bin/leanpi.js` that imports a file `files` left out is a package
		// that cannot start: 0.1.1 shipped `bin/leanpi.js` importing
		// `../scripts/patch-pi-model-command.mjs` while `files` omitted `scripts/`,
		// so `npx leanpi --version` died on ERR_MODULE_NOT_FOUND. Every relative
		// import the entry point makes has to be in the tarball.
		const published = publishedPaths();
		const source = readFileSync(join(PACKAGE_ROOT, "bin/leanpi.js"), "utf8");
		const specifiers = [...source.matchAll(/from\s+"(\.[^"]+)"/g)].map((match) => match[1]!);
		expect(specifiers.length).toBeGreaterThan(0);
		for (const specifier of specifiers) {
			const shipped = relative(PACKAGE_ROOT, resolve(PACKAGE_ROOT, "bin", specifier));
			expect(published.has(shipped), `${specifier} -> ${shipped} is not in the published file list`).toBe(true);
		}
	}, 120_000);

	it("AC-6: no bundled-skill code path reaches the network", () => {
		// A source-level assertion, because a passing offline run proves only that
		// this machine was offline-tolerant, not that no fetch exists.
		for (const file of ["vendor.mjs", "pack.ts"]) {
			const source = readFileSync(resolve(PACKAGE_ROOT, "src/skills", file), "utf8");
			expect(source, file).not.toMatch(/\bfetch\(|node:https?|axios|undici/);
		}
		const loader = readFileSync(resolve(PACKAGE_ROOT, "src/capabilities/skills.ts"), "utf8");
		expect(loader).not.toMatch(/\bfetch\(|node:https?/);
	});

	it("AC-4: --check fails on a drifted pack and passes on the shipped one", () => {
		const pristine = execFileSync("node", [join(PACKAGE_ROOT, "scripts/sync-skills.mjs"), "--check"], { encoding: "utf8" });
		expect(pristine).toContain("OK");

		const destRoot = tempDir("leanpi-pack-");
		const sourceRoot = fixtureUpstream();
		const lock = vendorPack({ spec: fixtureSpec(), sourceRoot, destRoot });
		writeFileSync(join(destRoot, "prd-creator/SKILL.md"), "tampered\n");
		const result = checkPack({ lock, destRoot });
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("prd-creator/SKILL.md");
	});
});

describe("PRD-026 Phase 1 — the pack on disk", () => {
	it("AC-6: every vendored directory is covered by the lock", () => {
		const root = join(PACKAGE_ROOT, "skills");
		const lock = readJson(join(root, "pack.lock.json"));
		const locked = new Set<string>(lock.skills.flatMap((skill: { files: Array<{ path: string }> }) => skill.files.map((file) => file.path)));
		// The one definition of what the lock does not cover lives with the checker,
		// so this test cannot drift from `checkPack()`'s own rule.
		for (const path of listPackFiles(root)) {
			if (PACK_UNLOCKED.has(path)) continue;
			expect(locked.has(path), path).toBe(true);
		}
		expect(readdirSync(root).length).toBeGreaterThan(2);
	});
});
