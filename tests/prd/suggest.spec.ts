/**
 * PRD-044's preference: `/prd suggest` is the only way back after "No, don't ask
 * again", and it shares `ui.json` with `/thinking-fold` without clobbering it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prdSuggestEnabled, setPrdSuggest, setThinkingFold, thinkingFoldEnabled, uiPrefsPath } from "../../src/cli/ui-settings.js";
import { createPrdHandler } from "../../src/prd/commands.js";
import { tempDir } from "../helpers/fixtures.js";
import { artifactStoreFor, prdConfig } from "./helpers.js";

describe("PRD suggestion preference (PRD-044)", () => {
	it("keeps the other key when either one is written", () => {
		const env = { XDG_CONFIG_HOME: tempDir("leanpi-prefs-") };
		setThinkingFold(false, env);
		setPrdSuggest(false, env);
		expect(thinkingFoldEnabled(env)).toBe(false);
		expect(prdSuggestEnabled(env)).toBe(false);
		setThinkingFold(true, env);
		expect(JSON.parse(readFileSync(uiPrefsPath(env), "utf8"))).toEqual({ thinkingFold: true, prdSuggest: false });
	});

	it("/prd suggest reports, turns off and back on", async () => {
		const env = { XDG_CONFIG_HOME: tempDir("leanpi-prefs-") };
		const cwd = tempDir("leanpi-repo-");
		const prd = createPrdHandler({ cwd, config: prdConfig(cwd), artifactStore: artifactStoreFor(tempDir("leanpi-agent-")), prefsEnv: env });
		expect((await prd("suggest", { cwd })).text).toContain("on");
		expect((await prd("suggest off", { cwd })).ok).toBe(true);
		expect(prdSuggestEnabled(env)).toBe(false);
		expect((await prd("suggest on", { cwd })).ok).toBe(true);
		expect(prdSuggestEnabled(env)).toBe(true);
		expect((await prd("suggest maybe", { cwd })).ok).toBe(false);
	});
});
