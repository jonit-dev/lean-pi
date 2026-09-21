/**
 * LeanPi's spinner glyphs.
 *
 * `pi-claude-code-ui` replaces Pi's loader with Claude Code's own star set
 * (`· ✢ ✳ ✶ ✻ ✽`) at module load, and its `/cc-spinner` only sets colours — the
 * glyphs are a constant inside that file. This puts LeanPi's own frames back on
 * top of it: a rising and falling bar, which is what a harness that meters every
 * turn should look like while it waits.
 *
 * ponytail: this re-implements the vendor's `updateDisplay` (ten lines of dedupe
 * and re-render) because the frames are not reachable any other way. It reuses
 * the vendor's own symbols, so the two agree about the last text drawn and the
 * active UI; if the vendor's loader patch grows a behaviour this copy lacks,
 * take the frames upstream instead of widening this.
 */
import { Loader } from "@earendil-works/pi-tui";

/** One cycle of the bar, rise and fall. */
export const SPINNER_FRAMES: readonly string[] = ["▁", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃"];

/** The vendor's keys, so a frame this draws is deduped against the one it drew. */
const LAST_TEXT = Symbol.for("pi-claude-style-tools:loader-last-text");
const ACTIVE_UI = Symbol.for("pi-claude-style-tools:active-ui");

const RAW_ANSI = /\x1b\[[0-9;]*m/;

/**
 * Installs the frames on Pi's loader prototype.
 *
 * Must run after every extension is loaded — `pi-claude-code-ui` patches the
 * same method at module load, and LeanPi's extension is attached first. Session
 * start is the first point at which the load order is settled.
 */
export function installSpinnerFrames(frames: readonly string[] = SPINNER_FRAMES): void {
	const loader = Loader.prototype as unknown as Record<string, unknown>;
	loader.updateDisplay = function patchedUpdateDisplay(this: unknown) {
		const self = this as Record<string | symbol, any>;
		if (self.ui?.stopped) {
			self.stop?.();
			return;
		}
		const frame = frames[self.currentFrame % frames.length] as string;
		// A message that already carries its own colour keeps it: the vendor's
		// verb line is pre-coloured, and re-wrapping it drops the highlight.
		const message = typeof self.message === "string" && RAW_ANSI.test(self.message) ? self.message : self.messageColorFn(self.message);
		const next = `${self.spinnerColorFn(frame)} ${message}`;
		if (self[LAST_TEXT] === next) return;
		self[LAST_TEXT] = next;
		self.setText(next);
		if (self.ui && !self.ui.stopped) {
			(globalThis as Record<string | symbol, unknown>)[ACTIVE_UI] = self.ui;
			self.ui.requestRender();
		}
	};
}
