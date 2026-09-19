/**
 * PRD-014 Phase 3 — AC-3 and AC-6: layered assembly, stable prefix and dedup.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assemble, createArtifactStore, buildWorkingState, stubSources } from "../src/index.js";
import { tempDir } from "./helpers/fixtures.js";

const CONFIG = { instructions: { ponytail: true } };
const WORKING_STATE = buildWorkingState(
	stubSources({
		goal: () => "fix the torpedo crash",
		acceptance: () => ["selection is stable"],
		verificationByKind: () => ({ affected_tests: "fail" }),
	}),
);

function sha(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

describe("PRD-014 Phase 3 — layered assembly", () => {
	it("AC-6: the cacheable prefix is byte-identical across turns and volatile content follows it", () => {
		const first = assemble({
			config: CONFIG,
			projectInstructions: ["AGENTS.md: run pnpm test"],
			skills: [{ name: "debugging", source: "user", body: "debug body" }],
			workingState: WORKING_STATE,
			evidence: ["first turn evidence"],
			diff: "diff --git a/src/game/torpedo.ts",
			currentFailure: "scene did not load",
		});
		const second = assemble({
			config: CONFIG,
			projectInstructions: ["AGENTS.md: run pnpm test"],
			skills: [{ name: "debugging", source: "user", body: "debug body" }],
			workingState: WORKING_STATE,
			evidence: ["second turn evidence"],
			diff: "diff --git a/src/game/scene.ts",
		});

		expect(second.cacheablePrefix.length).toBe(first.cacheablePrefix.length);
		expect(sha(second.cacheablePrefix)).toBe(sha(first.cacheablePrefix));
		expect(first.prefix).toContain("ponytail@4.9.0");

		// Every turn-specific marker lands strictly after the cacheable prefix.
		const boundary = first.cacheablePrefix.length;
		for (const marker of ["working state:", "current diff:", "current failure:", "evidence:"]) {
			const at = first.text.indexOf(marker);
			expect(at, marker).toBeGreaterThan(boundary);
		}

		// Changing the skill selection changes only the SEMI-STABLE segment.
		const changed = assemble({
			config: CONFIG,
			projectInstructions: ["AGENTS.md: run pnpm test"],
			skills: [{ name: "prd-creator", source: "user", body: "prd body" }],
			workingState: WORKING_STATE,
		});
		expect(changed.layers.static).toBe(first.layers.static);
		expect(sha(changed.layers.static)).toBe(sha(first.layers.static));
		expect(changed.layers.semiStable).not.toBe(first.layers.semiStable);
		expect(sha(changed.cacheablePrefix)).not.toBe(sha(first.cacheablePrefix));
	});

	it("AC-3: identical tool output emitted twice is stored once and assembled once", () => {
		const store = createArtifactStore({ sessionDir: tempDir("leanpi-session-") });
		const big = `identical tool output\n${"payload ".repeat(4000)}`;

		const once = assemble({ config: CONFIG, workingState: WORKING_STATE, evidence: [big], artifacts: store });
		const twice = assemble({ config: CONFIG, workingState: WORKING_STATE, evidence: [big, big], artifacts: store });

		expect(once.text).toContain("identical tool output");
		expect(twice.text.match(/identical tool output/g)).toHaveLength(1);
		expect(twice.text).toContain("[same content as earlier block: artifact://context/");
		const growth = Buffer.byteLength(twice.text, "utf8") - Buffer.byteLength(once.text, "utf8");
		expect(growth).toBeLessThan(200);

		// One artifact, and it expands to the exact bytes that were deduped.
		const ref = /artifact:\/\/context\/[0-9a-f]{64}/.exec(twice.text)![0];
		expect(store.expand(ref).toString("utf8")).toBe(`evidence: ${big}`);
	});
});
