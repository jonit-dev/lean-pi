/**
 * Per-subagent model and effort routing (PRD-049, FR-153).
 *
 * The parent turn is routed in `before_agent_start`; a `subagent` child was not,
 * so it ran on whatever pi-subagents resolved — usually the parent's model. This
 * hook classifies the handed-off task the same way the compiler classifies a
 * turn and writes `provider/id:level` into the call's `model`, the one field
 * upstream reads a thinking level from. Upstream's own resolution still runs
 * whenever this declines, so routing can only refine a dispatch, never block it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyExecution, type ComplexityInput } from "../compiler/classify.js";
import { EFFORT_BY_COMPLEXITY } from "../compiler/index.js";
import { routePins } from "../compiler/pins.js";
import { matrixDefault } from "../compiler/route.js";
import { thinkingLevelFor } from "../commands/session.js";
import { ownsExecutionLoop } from "../commands/turn-lanes.js";
import { resolveRole } from "../core/roles.js";
import type { LeanPiConfig } from "../core/types.js";
import { scoutTask } from "../scout/index.js";

export interface SubagentRoutingDeps {
	config: LeanPiConfig;
	cwd: string;
	client: ComplexityInput["client"];
}

export function registerSubagentRouting(pi: Pick<ExtensionAPI, "on">, deps: SubagentRoutingDeps): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "subagent") return;
		const input = event.input as Record<string, unknown>;
		// Declined without a JEV call: an explicit model is the parent's or the
		// operator's choice; an async child cannot see LeanPi's in-process
		// providers (PRD-041); a `/model` pin means the operator picked by hand
		// (PRD-048); an external harness has no Pi registry to route into. A
		// workflow call carries no single task, so its steps keep upstream's chain.
		if (typeof input.task !== "string" || input.model !== undefined || input.async === true) return;
		if (routePins().model !== undefined || ownsExecutionLoop(deps.config)) return;
		const agent = typeof input.agent === "string" ? input.agent : "child";
		try {
			const { complexity } = await classifyExecution({ client: deps.client, request: input.task, packet: scoutTask(deps.cwd, input.task), config: deps.config });
			const role = matrixDefault(false, complexity, "R0").executor_class;
			const ref = resolveRole(deps.config, role);
			const model = ctx.modelRegistry.find(ref.backend, ref.model);
			if (!model) {
				if (ctx.hasUI) ctx.ui.notify(`subagent ${agent} → inherit (${role} role has no native model)`, "info");
				return;
			}
			const level = thinkingLevelFor(deps.config, ref.backend, EFFORT_BY_COMPLEXITY[complexity]);
			input.model = `${model.provider}/${model.id}${level === undefined ? "" : `:${level}`}`;
			if (ctx.hasUI) ctx.ui.notify(`subagent ${agent} → ${model.id} · ${level ?? "default"} (${complexity})`, "info");
		} catch (error) {
			// An unresolved role or a scout failure leaves the call to upstream.
			process.stderr.write(`leanpi: subagent routing skipped: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	});
}
