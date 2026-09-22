/**
 * `/model` reaches LeanPi (PRD-016 Phase 2, FR-141).
 *
 * The red half is Pi's own shipped build: it routes `/model` to its selector
 * before the extension runner is ever consulted, which is why registering the
 * name only earned "Extension command '/model' conflicts with built-in
 * interactive command". The green half is the same source after the patch.
 *
 * Read from Pi's real bundle rather than a fixture on purpose: the point of the
 * test is that the claimed branch is still *there*, so a Pi upgrade that moves
 * it fails here instead of silently handing `/model` back to Pi.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPiModelPatch, findPiModelChunk, piChunkDir, PI_MODEL_PATCHES } from "../../scripts/patch-pi-model-command.mjs";

const chunk = findPiModelChunk(piChunkDir(process.cwd()));

describe("pi's /model branch", () => {
	it("is where the patch claims it is, so an upgrade that moves it fails here", () => {
		expect(chunk).toBeDefined();
	});

	it("routes to pi's own selector before the patch, and to the extension after it", () => {
		const source = readFileSync(chunk!.path, "utf8");
		// Pi's build, or Pi's build as we already patched it — normalise to the
		// unpatched text so the red half is the same assertion either way.
		const original = source.replace(PI_MODEL_PATCHES[0].replace, PI_MODEL_PATCHES[0].find);

		// Red: the branch fires on `/model` unconditionally. Nothing asks whether
		// an extension registered the name, so LeanPi's picker cannot be reached.
		expect(original).toContain(PI_MODEL_PATCHES[0].find);
		expect(original).not.toContain("isExtensionCommand(text)){");

		// Green: the same branch now defers, using pi's own helper — the one the
		// command chain already calls at its end.
		const patched = applyPiModelPatch(original);
		expect(patched).toContain(PI_MODEL_PATCHES[0].replace);
		expect(patched).not.toContain(PI_MODEL_PATCHES[0].find);
	});

	it("drops the conflict diagnostic, which now reports a name /model no longer loses", () => {
		const source = readFileSync(chunk!.path, "utf8");
		const original = source.replace(PI_MODEL_PATCHES[1].replace, PI_MODEL_PATCHES[1].find);

		expect(original).toContain("conflicts with built-in interactive command");
		expect(applyPiModelPatch(original)).toContain(PI_MODEL_PATCHES[1].replace);
	});

	it("is safe to re-apply, because the launcher patches on every start", () => {
		const once = applyPiModelPatch(`before${PI_MODEL_PATCHES[0].find}mid${PI_MODEL_PATCHES[1].find}after`);
		expect(applyPiModelPatch(once)).toBe(once);
	});

	it("refuses a source it does not recognise rather than patching the wrong branch", () => {
		expect(() => applyPiModelPatch("nothing like pi's handler")).toThrowError(/expected exactly one match, found 0/);
	});
});
