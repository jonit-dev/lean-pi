/**
 * PRD-003 AC-1 — packet fields equal the workspace state the fixture created.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scoutTask } from "../../src/index.js";
import { tempDir } from "../helpers/fixtures.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Build the fixture through the package entry's own public API, with real git. */
function monorepoFixture(): string {
	const cwd = tempDir("leanpi-scout-repo-");
	git(cwd, ["init", "-q"]);
	git(cwd, ["config", "user.email", "fixture@example.com"]);
	git(cwd, ["config", "user.name", "Fixture"]);
	git(cwd, ["checkout", "-q", "-b", "feature/foo"]);

	writeFileSync(
		join(cwd, "package.json"),
		JSON.stringify(
			{
				name: "fixture-monorepo",
				private: true,
				type: "module",
				workspaces: ["packages/*"],
				devDependencies: { typescript: "^5.9.0", vitest: "^3.0.0" },
			},
			null,
			2,
		),
	);
	writeFileSync(join(cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
	writeFileSync(join(cwd, "vitest.config.ts"), "export default {};\n");
	mkdirSync(join(cwd, "packages/app/src"), { recursive: true });
	mkdirSync(join(cwd, "packages/native/src"), { recursive: true });
	writeFileSync(join(cwd, "packages/app/src/index.ts"), "export const value = 1;\n");
	writeFileSync(join(cwd, "packages/native/src/engine.cpp"), "int main() { return 0; }\n");
	git(cwd, ["add", "-A"]);
	git(cwd, ["commit", "-q", "-m", "fixture"]);

	// Two tracked files modified, as the test's own state claims.
	writeFileSync(join(cwd, "packages/app/src/index.ts"), "export const value = 2;\n");
	writeFileSync(join(cwd, "packages/native/src/engine.cpp"), "int main() { return 1; }\n");
	return cwd;
}

describe("PRD-003 AC-1 — packet builder returns real workspace facts", () => {
	it("reports the fixture's languages, project type, manager, dirtiness, files and branch", () => {
		const cwd = monorepoFixture();
		const packet = scoutTask(cwd, "fix crash selecting Douglas torpedo");

		expect(packet.repository.project_type).toBe("monorepo");
		expect(packet.repository.package_manager).toBe("npm");
		expect(packet.repository.dirty).toBe(true);
		expect(packet.repository.languages).toEqual(expect.arrayContaining(["typescript", "cpp"]));

		expect(packet.workspace.changed_files).toEqual([
			"packages/app/src/index.ts",
			"packages/native/src/engine.cpp",
		]);
		expect(packet.workspace.git_branch).toBe("feature/foo");
		expect(packet.workspace.test_runners).toEqual(["vitest"]);
		expect(packet.workspace.likely_modules).toEqual(
			expect.arrayContaining(["packages/app/src", "packages/native/src"]),
		);
		expect(typeof packet.workspace.lsp_available).toBe("boolean");
		expect(packet.task.user_request).toBe("fix crash selecting Douglas torpedo");
	});
});
