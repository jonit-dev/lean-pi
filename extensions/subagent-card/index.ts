/**
 * The `subagent` card under the compact UI, attached after it.
 *
 * Runs on `session_start` rather than at load, because that is the first point at
 * which every extension has been loaded — the compact UI patches its tool rows
 * while loading, so this is the first moment its `subagent` row exists to be named.
 * `src/cli/subagent-card.ts` carries the why, and why this is a source entry: the
 * prototype patched here has to be the one the interactive mode renders with, and
 * only jiti's module map resolves `@earendil-works/*` to it. The card's facts come
 * from `dist/`, so the compiled extension and this entry share one copy of them.
 */
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { installSubagentCard } from "../../dist/cli/subagent-card.js";

export default function (pi: { on(event: "session_start", handler: () => Promise<void> | void): void }): void {
	pi.on("session_start", () => {
		installSubagentCard(ToolExecutionComponent.prototype);
	});
}
