/**
 * `/thinking-fold` — which reasoning display the next session starts with.
 *
 * On (the default), the launcher attaches the vendored copy of
 * `@99percentpeople/pi-thinking-fold` (`vendor/`, see `cli/launch.ts`) and a
 * streaming reasoning block folds to a timed tail preview that Ctrl+T expands.
 * Off, nothing is attached and Pi's own live rendering — the one
 * `pi-claude-code-ui` styles — shows the reasoning as it streams.
 *
 * The choice is an extension attachment, and extensions are attached before a
 * session exists, so the command stores it and says the next session applies
 * it rather than pretending to change the display in place.
 */
import { setThinkingFold, thinkingFoldEnabled, type UiPrefsEnv } from "../cli/ui-settings.js";
import type { CommandRegistry, CommandResult } from "./registry.js";

function state(enabled: boolean): string {
	return enabled ? "on — reasoning folds to a tail preview, ctrl+t expands it" : "off — reasoning streams live, as Pi renders it";
}

export function registerThinkingFoldCommand(registry: CommandRegistry, env: UiPrefsEnv = process.env): void {
	registry.register({
		name: "thinking-fold",
		summary: "fold streaming reasoning into a tail preview (on by default)",
		usage: "/thinking-fold [on|off]",
		run: (args): CommandResult => {
			const value = args.trim();
			if (value === "") return { ok: true, text: `thinking fold: ${state(thinkingFoldEnabled(env))}` };
			if (value !== "on" && value !== "off") return { ok: false, text: "usage: /thinking-fold [on|off]" };
			const path = setThinkingFold(value === "on", env);
			return { ok: true, text: `thinking fold: ${state(value === "on")}\nstored in ${path}; the next session starts with it.` };
		},
	});
}
