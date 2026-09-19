/**
 * PRD-003 AC-2, AC-3, AC-4 — the byte ceiling, determinism and degradation.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCOUT_PACKET_MAX_BYTES, scoutTask } from "../../src/index.js";
import { tempDir } from "../helpers/fixtures.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const FILE_BODY_MARKER = "export const HOSTILE_FILE_BODY_MARKER = 1;";
const MANIFEST_MARKER = "HOSTILE_MANIFEST_MARKER";
const INSTRUCTION_MARKER = "HOSTILE_INSTRUCTION_MARKER";
const COMMIT_MARKER = "HOSTILE_COMMIT_MARKER";

/** 3,000 changed files, a 400 KB manifest, a 2,000-line AGENTS.md, 50 commits, 8-deep nesting. */
function hostileFixture(): string {
	const cwd = tempDir("leanpi-scout-hostile-");
	git(cwd, ["init", "-q"]);
	git(cwd, ["config", "user.email", "fixture@example.com"]);
	git(cwd, ["config", "user.name", "Fixture"]);

	const deep = join(cwd, "a/b/c/d/e/f/g/h");
	mkdirSync(deep, { recursive: true });
	writeFileSync(join(deep, "leaf.ts"), FILE_BODY_MARKER);
	git(cwd, ["add", "-A"]);
	git(cwd, ["commit", "-q", "-m", `fixture ${COMMIT_MARKER}`]);
	for (let index = 0; index < 49; index += 1) {
		writeFileSync(join(cwd, `history-${index}.txt`), `history ${COMMIT_MARKER} ${index}\n`);
		git(cwd, ["add", "-A"]);
		git(cwd, ["commit", "-q", "-m", `history ${index} ${COMMIT_MARKER}`]);
	}

	writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: MANIFEST_MARKER, padding: MANIFEST_MARKER.repeat(20_000) }));
	writeFileSync(join(cwd, "AGENTS.md"), `${Array.from({ length: 2000 }, (_, index) => `line ${index} ${INSTRUCTION_MARKER}`).join("\n")}\n`);

	const changed = join(cwd, "changed");
	mkdirSync(changed, { recursive: true });
	for (let index = 0; index < 3000; index += 1) {
		writeFileSync(join(changed, `file-${String(index).padStart(5, "0")}.ts`), FILE_BODY_MARKER);
	}
	// Staged rather than merely untracked: git collapses an untracked directory
	// into one porcelain record, and the fixture must exercise 3,000 records.
	git(cwd, ["add", "-A"]);
	return cwd;
}

describe("PRD-003 AC-2/AC-3/AC-4 — ceiling, determinism, degradation", () => {
	it("AC-2: the hostile repo yields a packet inside the ceiling that leaks no content", () => {
		const cwd = hostileFixture();
		// Negative control: without truncation the assembled packet would not fit.
		const contents = execFileSync("git", ["status", "--porcelain=v1", "-z"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		expect(contents.length).toBeGreaterThan(SCOUT_PACKET_MAX_BYTES * 10);

		const packet = scoutTask(cwd, "refactor the host");
		const serialized = JSON.stringify(packet);
		expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(SCOUT_PACKET_MAX_BYTES);

		const markers = packet.workspace.changed_files.filter((entry) => entry.startsWith("+"));
		expect(markers.length).toBeGreaterThan(0);
		expect(markers[0]).toMatch(/^\+\d+ more changed$/);
		const kept = packet.workspace.changed_files.length - markers.length;
		const dropped = markers.reduce((sum, entry) => sum + Number(/\d+/.exec(entry)![0]), 0);
		// The marker carries the true total: what was kept plus what was dropped,
		// counted against git's own record of the changed files.
		const recorded = contents.split("\0").filter((record) => record.length > 0).length;
		expect(recorded).toBe(3002);
		expect(kept + dropped).toBe(recorded);

		for (const leaked of [FILE_BODY_MARKER, MANIFEST_MARKER, INSTRUCTION_MARKER, COMMIT_MARKER]) {
			expect(serialized).not.toContain(leaked);
		}
	});

	it("AC-3: no network access is required and consecutive calls are byte-identical", () => {
		const cwd = hostileFixture();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (() => {
			throw new Error("scout must not touch the network");
		}) as typeof fetch;
		try {
			const first = JSON.stringify(scoutTask(cwd, "refactor the host"));
			const second = JSON.stringify(scoutTask(cwd, "refactor the host"));
			expect(first).toBe(second);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("AC-4: a bare directory degrades instead of throwing", () => {
		const cwd = tempDir("leanpi-scout-bare-");
		const packet = scoutTask(cwd, "do something");
		expect(packet.repository.dirty).toBe(false);
		expect(packet.repository.package_manager).toBeNull();
		expect(packet.repository.project_type).toBe("unknown");
		expect(packet.workspace.git_branch).toBeNull();
		expect(packet.workspace.changed_files).toEqual([]);
		expect(packet.workspace.test_runners).toEqual([]);
	});
});
