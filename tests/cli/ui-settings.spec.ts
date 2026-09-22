/**
 * The compact UI's defaults are a default: they fill a key the user left alone
 * and never touch one they answered.
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPACT_UI_DEFAULTS, ensureCompactUiDefaults } from "../../src/cli/ui-settings.js";

function home(): string {
	return mkdtempSync(join(tmpdir(), "leanpi-ui-"));
}

function settings(root: string): string {
	return readFileSync(join(root, ".pi", "settings.json"), "utf8");
}

describe("the compact UI's seeded settings", () => {
	it("writes the defaults once, then leaves the file alone", () => {
		const root = home();
		expect(ensureCompactUiDefaults(root)).toEqual(Object.keys(COMPACT_UI_DEFAULTS));
		expect(JSON.parse(settings(root))).toEqual(COMPACT_UI_DEFAULTS);
		expect(ensureCompactUiDefaults(root)).toEqual([]);
	});

	it("keeps every key the user already answered, and their other settings", () => {
		const root = home();
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "settings.json"), JSON.stringify({ diffTheme: "ayu-dark", previewLines: 3 }));
		expect(ensureCompactUiDefaults(root)).toEqual([]);
		expect(JSON.parse(settings(root))).toEqual({ diffTheme: "ayu-dark", previewLines: 3 });
	});

	it("does not rewrite a file it cannot read", () => {
		const root = home();
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "settings.json"), "{ not json");
		expect(ensureCompactUiDefaults(root)).toEqual([]);
		expect(settings(root)).toBe("{ not json");
	});
});
