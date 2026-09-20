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
import { runWorkerTurn, type BackendRegistry } from "../backends/registry.js";
import type { PrdCommandDeps } from "./commands.js";
// Type-only: `creator.js` is a lane module and importing its *values* here
// would load the lane on the quick path, which FR-032/AC-7 forbid.
import type { AuthoringModel } from "./creator.js";
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
	const { createPrdManager, NoActivePrdError } = await import("./manager.js");
	try {
		return createPrdManager({ ...options, contract: record.contract });
	} catch (error) {
		// The compiler decides a task needs a PRD *before* one exists — that is the
		// normal order — and the lane tracks a PRD document the user creates with
		// `/prd create`. Treating the absence as a fatal error made every
		// PRD-classified first turn in a fresh project die with "No active PRD
		// state", including the very first thing a new user types. The turn
		// continues on the direct path; the status line says a PRD is wanted.
		if (error instanceof NoActivePrdError) return null;
		throw error;
	}
}

/** What `/help` prints for `/prd`; the lane module registers with the same text. */
export const PRD_COMMAND_HELP = {
	summary: "author, inspect and close the active PRD",
	usage: '/prd create ["<objective>"] | /prd status | /prd close',
};

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
	registry.register("prd", handler, PRD_COMMAND_HELP);
}

/**
 * The authoring pass `/prd create` needs, as one worker turn on the planning
 * role.
 *
 * Nothing wired this before: `activate()` registered `/prd` with no `author`,
 * so the command the status line tells the user to run answered "needs an
 * authoring model; none is wired in this session" on every machine. The turn
 * runs through the same backend chain every other worker call uses, so the
 * authoring pass is subject to the same fallbacks, cooldowns and telemetry.
 *
 * `strong` is the role: a PRD is the document every later criterion is verified
 * against, and it is written once per feature.
 */
export function createPrdAuthor(options: { cwd: string; registry: BackendRegistry; env?: NodeJS.ProcessEnv }): AuthoringModel {
	return async (request) => {
		const reask = request.reask;
		const prompt = [
			request.contract,
			"",
			`Objective: ${request.objective}`,
			"",
			// The worker writes files by default; this pass wants the document on
			// stdout, because `writePrdFile` owns where a PRD lives in this repo.
			"Write the complete PRD as Markdown in your final message. Create no files.",
			...(reask
				? [
						"",
						"Your previous draft was rejected. Fix exactly this:",
						...(reask.missingSections.length > 0 ? [`- empty or missing sections: ${reask.missingSections.join(", ")}`] : []),
						...reask.commandless.map((criterion) => `- ${criterion.id} has no runnable verification command: ${criterion.text}`),
					]
				: []),
		].join("\n");
		const outcome = await runWorkerTurn(
			{ objective: request.objective, role: "strong", prompt },
			{ registry: options.registry, cwd: options.cwd, ...(options.env ? { env: options.env } : {}) },
		);
		if (outcome.status !== "completed" || !outcome.result) {
			const detail = outcome.attempts.map((attempt) => `${attempt.backend}: ${attempt.failure}`).join("; ");
			throw new Error(`no backend could author the PRD${detail.length > 0 ? ` (${detail})` : ""}`);
		}
		return outcome.result.summary;
	};
}
