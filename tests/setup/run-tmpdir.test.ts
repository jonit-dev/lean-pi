import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";

describe("suite temp directory", () => {
	it("points tmpdir() at a per-run directory the global teardown removes", () => {
		expect(basename(tmpdir())).toMatch(/^leanpi-run-/);
		expect(dirname(tmpdir())).toBe(process.env.LEANPI_HOST_TMPDIR);
	});
});
