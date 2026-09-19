/**
 * `/status` — one screen composed from existing readouts (PRD-016 Phase 1, FR-140).
 *
 * Every value here is read, never recomputed: the session identity comes from
 * Pi's session manager, the bindings from PRD-001's role resolver (plus this
 * session's `/model` overrides), the backend counts from the probe cache
 * `/doctor` fills, and the cost from PRD-015's store filtered on the record's
 * `session_id`. A divergence between `/status` and `/cost` is therefore
 * impossible by construction — both read the same rows.
 */
import { readPrdState } from "../prd/state.js";
import { aggregateRuns } from "../telemetry/index.js";
import { readRuns } from "../telemetry/store.js";
import { MODEL_ROLES } from "../core/types.js";
import type { CommandRegistry, CommandResult } from "./registry.js";
import { money, probeBackends, type CommandSurface } from "./surface.js";

function bindingLine(surface: CommandSurface): string {
	const parts = MODEL_ROLES.map((role) => {
		const binding = surface.bindingFor(role);
		if (!binding.ref) return `${role}=unresolved`;
		const mark = binding.source === "session" ? " (session)" : "";
		return `${role}=${binding.ref.backend}/${binding.ref.model}${mark}`;
	});
	return parts.join(" · ");
}

export async function renderStatus(surface: CommandSurface): Promise<string> {
	const manager = surface.host.current();
	const header = manager.getHeader();
	const parent = header?.parentSession ? header.parentSession.split("/").pop() : "none";
	const sessionId = manager.getSessionId();

	const probes = surface.probes.size > 0 ? surface.probes : await probeBackends(surface);
	const counts = { ok: 0, degraded: 0, unavailable: 0 };
	for (const probe of probes.values()) counts[probe.status] += 1;

	const agent = surface.host.agent();
	const reasoning = agent?.thinkingLevel ?? surface.contract?.reasoning.effort ?? "unknown";

	const prd = readPrdState(surface.cwd);
	const prdLine = prd
		? `prd: ${prd.prdId} — ${prd.criteria.filter((criterion) => criterion.status === "VERIFIED").length}/${prd.criteria.length} criteria verified`
		: "prd: none";

	// The same rows `/cost` totals, narrowed by this session's id.
	const runs = readRuns(surface.cwd, { sessionId }, surface.cost);
	const aggregate = aggregateRuns(runs);

	return [
		`session: ${manager.getSessionName() ?? "unnamed"} (id ${sessionId}) parent: ${parent ?? "none"}`,
		`roles: ${bindingLine(surface)}`,
		`reasoning: ${reasoning}`,
		`backends: ${counts.ok} ok · ${counts.degraded} degraded · ${counts.unavailable} unavailable`,
		prdLine,
		`session cost: ${money(aggregate.effectiveCostUsd)} over ${aggregate.runs} run${aggregate.runs === 1 ? "" : "s"}`,
	].join("\n");
}

export function registerStatusCommand(registry: CommandRegistry, surface: CommandSurface): void {
	registry.register({
		name: "status",
		summary: "session identity, role bindings, reasoning level, backend health and session cost",
		usage: "/status",
		run: async (): Promise<CommandResult> => ({ ok: true, text: await renderStatus(surface) }),
	});
}
