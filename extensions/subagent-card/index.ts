/**
 * The `subagent` card under the compact UI, attached after it.
 *
 * Runs on `session_start` rather than at load, because that is the first point at
 * which every extension has been loaded — the compact UI patches its tool rows
 * while loading, so this is the first moment its `subagent` row exists to be named.
 * `src/cli/subagent-card.ts` carries the why. The compiled entry uses the native
 * bridge to reach the exact prototype the interactive mode renders with.
 */
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { installSubagentCard } from "../../dist/cli/subagent-card.js";

export default function (pi: { on(event: "session_start", handler: () => Promise<void> | void): void }): void {
	pi.on("session_start", () => {
		installSubagentCard(ToolExecutionComponent.prototype);
	});
}
