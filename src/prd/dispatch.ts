/**
 * The lazy PRD-lane entry point (PRD-012 Phase 4, FR-032).
 *
 * The quick path (`next_stage: "executor_lane"`) must cost zero PRD state, zero
 * files and zero module initialisation, so the lane modules are reached through
 * exactly one dynamic import here and nothing on the quick path imports them
 * statically. `laneLoads` is the instrumentation for that claim: each lane
 * module notes its own load, so AC-7 can observe an absence rather than trust a
 * promise. Loading *this* file is not a lane load — it is the gate.
 */
import type { CompileRecord } from "../compiler/contract.js";
import type { CommandHandler, CommandRegistry } from "../commands/registry.js";
import type { ArtifactStore } from "../context/artifacts.js";
import type { LeanPiConfig } from "../core/types.js";
import type { JevClient } from "../jev/client.js";
import type { PrdCommandDeps } from "./commands.js";
import type { ModelSelector, PrdManager } from "./manager.js";

/** Names of the `src/prd/*` modules loaded in this process, in load order. */
export const laneLoads: string[] = [];

export function noteLaneModuleLoad(name: string): void {
	if (!laneLoads.includes(name)) laneLoads.push(name);
}

/** Test seam for the absence assertion: the counter is session-scoped state. */
export function resetLaneLoads(): void {
	laneLoads.length = 0;
}

export interface PrdLaneOptions {
	config: LeanPiConfig;
	cwd: string;
	artifactStore: ArtifactStore;
	/** The JEV seam the lane asks through; it never manages credentials. */
	jev?: Pick<JevClient, "ask" | "getMode">;
	hashWorkspace?: () => string;
	selectModel?: ModelSelector;
}

/**
 * The branch the compiler's `PRD_REQUIRED` dispatch takes. `record.next_stage`
 * is the compiled decision; anything else returns `null` having loaded nothing.
 */
export async function openPrdLane(record: CompileRecord, options: PrdLaneOptions): Promise<PrdManager | null> {
	if (record.next_stage !== "prd_lane") return null;
	// A static import of `./manager.js` would load the lane on the quick path too,
	// which FR-032/AC-7 forbid: the module graph is the first thing that has to be
	// absent, so this literal specifier is deliberately a loading boundary.
	const { createPrdManager } = await import("./manager.js");
	return createPrdManager({ ...options, contract: record.contract });
}

/**
 * Registers `/prd` without loading the lane: the handler pulls `commands.js` in
 * on its first invocation. Wiring the command surface through this function
 * keeps a session that never enters the PRD lane at zero lane loads, which is
 * what AC-7 measures; `registerPrdCommands` in `commands.js` is the direct
 * equivalent for callers that already have the lane loaded.
 */
export function registerPrdCommandsLazily(registry: CommandRegistry, deps: PrdCommandDeps): void {
	let resolved: CommandHandler | undefined;
	const handler: CommandHandler = async (args, context) => {
		if (!resolved) {
			// Same boundary as above: `/prd` may be registered long before it is used.
			const { createPrdHandler } = await import("./commands.js");
			resolved = createPrdHandler(deps);
		}
		return resolved(args, context);
	};
	if (registry.has("prd")) registry.unregister("prd");
	registry.register("prd", handler);
}
