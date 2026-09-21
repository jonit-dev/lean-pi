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
 *
 * This file is the extension Pi is handed — the `.ts` source, not its build
 * output — and that is the reason the glyphs were still Claude's stars. Pi
 * loads a `.ts` extension through jiti, which resolves `@earendil-works/pi-tui`
 * through its virtual-module map to the Loader class the interactive mode
 * renders with. A compiled `.js` extension is imported by Node itself, so it
 * gets this package's own copy of pi-tui and patches a prototype nothing draws
 * with. Keep it TypeScript, and keep the import a value import.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
 * Must run after every extension is loaded: `pi-claude-code-ui` patches the
 * same method at module load, and session start is the first point at which the
 * load order is settled.
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

/**
 * The entry Pi attaches for the frames.
 *
 * Session start, not module load: it is the first point at which every
 * extension has patched the loader, so LeanPi's frames land on top of the
 * compact UI's rather than under them.
 */
export default function registerSpinnerFrames(pi: ExtensionAPI): void {
	pi.on("session_start", () => installSpinnerFrames());
}
