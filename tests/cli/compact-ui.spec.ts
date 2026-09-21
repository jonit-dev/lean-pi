/**
 * The compact tool rows and LeanPi's baseline surface have to agree on who
 * registers `read`, `edit` and `write`: Pi refuses a duplicate registration and
 * drops the whole extension with it, which is how the renderer silently failed
 * to load at all.
 */
import { describe, expect, it } from "vitest";
import { BASELINE_TOOL_NAMES, YIELDED_TOOL_NAMES, registerBaselineTools } from "../../src/core/tools.js";

function registered(yielded: readonly string[]): string[] {
	const names: string[] = [];
	registerBaselineTools({ registerTool: (definition: { name: string }) => names.push(definition.name) } as never, process.cwd(), yielded);
	return names;
}

describe("the baseline surface under the compact UI", () => {
	it("registers all five when nothing is yielded", () => {
		expect(registered([])).toEqual([...BASELINE_TOOL_NAMES]);
	});

	it("leaves the yielded names to the extension that took them, and keeps them on the allowlist", () => {
		const names = registered(YIELDED_TOOL_NAMES);
		for (const name of YIELDED_TOOL_NAMES) expect(names).not.toContain(name);
		// `search` and `execute` are LeanPi's under both names — `execute` carries
		// the command timeout and the spawn environment, which nothing else does.
		expect(names).toEqual(["search", "execute"]);
		const allowlist = registerBaselineTools({ registerTool: () => {} } as never, process.cwd(), YIELDED_TOOL_NAMES);
		expect(allowlist).toEqual([...BASELINE_TOOL_NAMES]);
	});
});
