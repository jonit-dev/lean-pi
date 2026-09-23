/**
 * The launcher's transpile-only build must emit source maps a debugger can
 * resolve: `sources` is the source path relative to the map's directory, as
 * `tsc` writes it, not the `src`-relative path handed to `transpileModule`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("dev-build source maps", () => {
	it("points each map's sources at the source relative to the map", () => {
		const root = mkdtempSync(join(tmpdir(), "leanpi-devbuild-"));
		mkdirSync(join(root, "scripts"), { recursive: true });
		writeFileSync(join(root, "scripts", "dev-build.mjs"), readFileSync(join(ROOT, "scripts", "dev-build.mjs"), "utf8"));
		writeFileSync(join(root, "tsconfig.json"), readFileSync(join(ROOT, "tsconfig.json"), "utf8"));
		mkdirSync(join(root, "src", "cli"), { recursive: true });
		writeFileSync(join(root, "src", "cli", "x.ts"), "export const a = 1;\n");
		symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");

		execFileSync("node", [join(root, "scripts", "dev-build.mjs")], { stdio: "pipe" });

		const map = JSON.parse(readFileSync(join(root, "dist", "cli", "x.js.map"), "utf8")) as { sources: string[] };
		expect(map.sources).toEqual(["../../src/cli/x.ts"]);
	});
});
