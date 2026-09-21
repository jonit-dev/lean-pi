/**
 * The frames have to land on the loader *after* `pi-claude-code-ui` patched it,
 * which is why they are installed at session start and not at activate().
 */
import { Loader } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { SPINNER_FRAMES, installSpinnerFrames } from "../../src/cli/spinner.js";

function drawnFrames(count: number, advance = true): string[] {
	installSpinnerFrames();
	const drawn: string[] = [];
	// Through the prototype, because that is what the patch replaces.
	const loader = Object.assign(Object.create(Loader.prototype) as Record<string, unknown>, {
		currentFrame: 0,
		message: "Compiling",
		messageColorFn: (text: string) => text,
		spinnerColorFn: (text: string) => text,
		setText: (text: string) => drawn.push(text.split(" ")[0] as string),
	});
	for (let index = 0; index < count; index += 1) {
		loader.currentFrame = advance ? index : 0;
		(loader as unknown as { updateDisplay(): void }).updateDisplay();
	}
	return drawn;
}

describe("LeanPi's spinner frames", () => {
	it("draws its own glyphs, not the vendor's star set", () => {
		const drawn = drawnFrames(SPINNER_FRAMES.length);
		expect(drawn).toEqual([...SPINNER_FRAMES]);
		expect(drawn.join("")).not.toMatch(/[✳✶✻✽]/);
	});

	it("wraps at the end of the cycle, and redraws nothing that did not change", () => {
		expect(drawnFrames(SPINNER_FRAMES.length + 1).at(-1)).toBe(SPINNER_FRAMES[0]);
		// The vendor's dedupe key: a tick that produces the same line is dropped
		// before it reaches the UI, so the loader does not re-render for nothing.
		expect(drawnFrames(3, false)).toEqual([SPINNER_FRAMES[0]]);
	});
});
