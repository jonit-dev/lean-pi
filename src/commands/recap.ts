/**
 * `/recap` (PRD-036 Phase 3): regenerate the turn recap on demand, and toggle
 * automatic generation for the session.
 *
 * The regeneration reuses the last turn's ask and answer, so it costs one model
 * call and no re-derivation of the turn: `/recap` is "say that again", not "redo
 * the turn". The toggle is session-scoped and never written to config — a user
 * silencing it for one session has not changed the project's settings.
 */
import type { RecapController } from "../recap/index.js";
import type { CommandRegistry, CommandResult } from "./registry.js";

export interface RecapCommandDeps {
	/** The live controller; absent in a surface with no session behind it. */
	recap?: () => RecapController | undefined;
}

const USAGE = "usage: /recap [on|off]";

export function registerRecapCommand(registry: CommandRegistry, deps: RecapCommandDeps): void {
	registry.register({
		name: "recap",
		summary: "regenerate the turn recap, or turn automatic generation on/off for this session",
		usage: USAGE,
		run: async (args, context): Promise<CommandResult> => {
			const recap = deps.recap?.();
			if (recap === undefined) return { ok: false, text: "recap is not available in this session" };
			const mode = args.trim().toLowerCase();
			if (mode === "off") {
				recap.setEnabled(false);
				return { ok: true, text: "recap: automatic generation off for this session" };
			}
			if (mode === "on") {
				recap.setEnabled(true);
				return { ok: true, text: "recap: automatic generation on for this session" };
			}
			if (mode.length > 0) return { ok: false, text: USAGE };
			// The widget is the report; the echoed text is the same sentence.
			const host = context.recapHost;
			if (host === undefined) return { ok: false, text: "recap needs an interactive session to draw in" };
			const result = await recap.regenerate(host);
			if (result.status === "ok" || result.status === "cached") return { ok: true, text: `recap: ${result.recap}` };
			if (result.status === "failed") {
				// A real turn produced input and the call did not come back: that is
				// a generation failure, not an empty session.
				return { ok: false, text: "recap generation failed — the previous recap is unchanged" };
			}
			if (result.status === "unavailable") {
				// Each cause gets its own line: "off or cannot draw" named neither
				// the unresolved role nor which switch to flip.
				if (result.reason === "off") return { ok: false, text: "recap: automatic generation is off for this session — run /recap on to enable it" };
				if (result.reason === "no_ui") return { ok: false, text: "recap needs an interactive session to draw in" };
				if (result.reason === "superseded") return { ok: false, text: "recap was superseded by a newer turn — run /recap again" };
				return { ok: false, text: "recap's model role is unavailable — no backend resolves it" };
			}
			return { ok: false, text: "nothing to recap yet — no completed turn is available" };
		},
	});
}
