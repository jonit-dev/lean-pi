/**
 * `/models` — the model inventory by role (PRD-016 Phase 2, FR-141).
 *
 * The default view answers the question a person actually has — *which model
 * does each role use?* — by grouping the configured roles under the backend/model
 * they resolve to. It deliberately does not repeat six near-identical rows of
 * `unavailable/unknown/unlisted/none` when the bundled ranking (PRD-024) does not
 * describe the vendor-reported ids an auto-config writes: missing ranking
 * information is stated once, with what it means and how to see more.
 *
 * `/models --details` keeps the per-role rows, the ranking revision/staleness and
 * the backend probe reasons for callers that want the machine-parseable detail.
 *
 * There is deliberately no `/model` here. Pi already ships an interactive model
 * selector under that name, and LeanPi's own switch is per *role*, which is what
 * `/route executor|reviewer <class>` already writes — a second spelling of it
 * would only shadow Pi's command with a weaker one.
 */
import { MODEL_ROLES, type BackendRef, type ModelRole } from "../core/types.js";
import { capabilityRows, loadRanking, roleResolutionsOf, type CapabilityRow } from "../capability/index.js";
import type { CommandRegistry, CommandResult } from "./registry.js";
import { probeBackends, type CommandSurface, type ProbeResult } from "./surface.js";

function rowFor(rows: readonly CapabilityRow[], ref: BackendRef): CapabilityRow | undefined {
	const model = ref.model.toLowerCase();
	return rows.find(
		(row) =>
			row.model_id.toLowerCase() === model ||
			(row.backend_binding !== null && row.backend_binding.backend === ref.backend && row.backend_binding.model === ref.model),
	);
}

/** The static `models.<role>` entry, before ranking/pin resolution. */
function configuredRef(surface: CommandSurface, role: ModelRole): BackendRef | null {
	const configured = surface.config.models[role];
	return configured ? { backend: configured.backend, model: configured.model, type: surface.config.backends[configured.backend]?.type ?? "native" } : null;
}

/** The backend/model a role actually routes to, session override included (`bindingFor`). */
function shownRef(surface: CommandSurface, role: ModelRole): BackendRef | null {
	return surface.bindingFor(role).ref;
}

/** A probe result stated for what it tested: reachability, never authentication. */
function availabilityOf(probe: ProbeResult | undefined): string {
	if (!probe) return "backend: not probed";
	if (probe.status !== "ok") return `backend: ${probe.status} (${probe.reason})`;
	// `ok` here means the TCP port answered or the executable exists; neither
	// proves a credential works, so say so unless the probe already did.
	return /auth/i.test(probe.reason) ? `backend: ${probe.reason}` : `backend: ${probe.reason}; authentication not verified`;
}

/** The roles this config actually binds, in `MODEL_ROLES` order. */
function configuredRoles(surface: CommandSurface): ModelRole[] {
	return MODEL_ROLES.filter((role) => surface.config.models[role] !== undefined || surface.bindings.has(role));
}

async function rowsFor(surface: CommandSurface, probe: boolean): Promise<CapabilityRow[]> {
	const ranking = loadRanking(surface.config);
	const rows = capabilityRows(ranking, roleResolutionsOf(ranking, surface.config));
	// The default view never renders a probe verdict, so it never pays the
	// connect/executable latency; only `--details` probes.
	if (probe && surface.probes.size === 0) await probeBackends(surface);
	return rows;
}

/** One short legend, so `quick`/`balanced`/`review_quick` are not bare labels. */
const ROLE_LEGEND = "Roles: quick/balanced/strong/specialist run the task; review_quick/review_strong review it.";

/** The default view: grouped assignments plus one explanation of what the ranking does not know. */
export async function renderModels(surface: CommandSurface): Promise<string> {
	const rows = await rowsFor(surface, false);
	const roles = configuredRoles(surface);

	// Group roles by the model they resolve to, preserving `MODEL_ROLES` order.
	const groups = new Map<string, { ref: BackendRef; roles: ModelRole[] }>();
	const unresolved: ModelRole[] = [];
	for (const role of roles) {
		const ref = shownRef(surface, role);
		if (!ref) {
			// A configured role that resolves to nothing is a real state, not an
			// omission: it stays visible so the assignment view never hides a role.
			unresolved.push(role);
			continue;
		}
		const key = `${ref.backend}/${ref.model}`;
		const group = groups.get(key) ?? { ref, roles: [] };
		group.roles.push(role);
		groups.set(key, group);
	}

	const ranked = [...groups.values()].filter((group) => rowFor(rows, group.ref) !== undefined).length;
	const unranked = groups.size - ranked;
	const lines = ["Model assignments (role → backend/model):", ROLE_LEGEND];
	for (const group of groups.values()) {
		lines.push(`  ${group.roles.join(", ")} → ${group.ref.backend}/${group.ref.model}`);
	}
	if (unresolved.length > 0) lines.push(`  ${unresolved.join(", ")} → unresolved (no configured backend and no available fallback)`);
	if (roles.length === 0) lines.push("  no roles are configured");

	lines.push("");
	if (unranked > 0) {
		// One sentence, not one per role: the same missing ranking data repeated is
		// what made the old view unreadable. An unranked model is not a routing
		// error — the explicit assignment above still decides the route.
		lines.push(
			`Ranking: ${unranked} of ${groups.size} assigned model${groups.size === 1 ? "" : "s"} ` +
				`${unranked === 1 ? "is" : "are"} not in the bundled ranking, so no coding score, price or role-fill is known. ` +
				"Routing still uses the assignment above. Run `/models --details` for the ranking's records, per-role rows and backend health.",
		);
	} else {
		lines.push(`Ranking: all ${groups.size} assigned model${groups.size === 1 ? "" : "s"} are described by the bundled ranking. Run \`/models --details\` for scores, prices and role-fill.`);
	}
	return lines.join("\n");
}

function renderModelRow(surface: CommandSurface, role: ModelRole, rows: readonly CapabilityRow[]): string {
	const shown = shownRef(surface, role);
	if (!shown) return `${role.padEnd(14)} unresolved`;

	const override = surface.bindings.get(role);
	const configured = configuredRef(surface, role);
	const probe = surface.probes.get(shown.backend);
	const availability = availabilityOf(probe);
	const row = rowFor(rows, shown);
	const score = row && row.coding_score !== null ? `coding_score: ${row.coding_score}` : "coding_score: unavailable";
	const price = row && row.price_blended_per_mtok !== null ? `price: $${row.price_blended_per_mtok}/Mtok blended` : "price: unknown";
	const fills = row ? `roles: ${row.roles.join(", ") || "none"}` : "roles: unlisted";
	const evidence = row ? `evidence: ${row.evidence}` : "evidence: none";
	// A model the ranking does not describe says so once, on its own row, instead
	// of leaving the four bare fields above to read as a verdict on the model.
	const rank = row ? "" : "  not in bundled ranking";

	// The effective assignment is the model column; the notes below explain where
	// it came from when that is not the static config entry.
	const overrideNote = override ? `  override: ${override.backend}/${override.model}` : "";
	const configuredNote =
		configured && (configured.backend !== shown.backend || configured.model !== shown.model)
			? `  configured: ${configured.backend}/${configured.model}`
			: "";
	return `${role.padEnd(14)} ${`${shown.backend}/${shown.model}`.padEnd(28)} ${score}  ${price}  ${fills}  ${evidence}${rank}  ${availability}${overrideNote}${configuredNote}`;
}

/** The detailed view: ranking freshness, one row per configured role, probe reasons. */
export async function renderModelDetails(surface: CommandSurface): Promise<string> {
	const ranking = loadRanking(surface.config);
	const rows = await rowsFor(surface, true);
	return [
		`ranking revision ${ranking.revision} — oldest record ${ranking.oldest_updated_at} (${ranking.age_days} days old${ranking.stale ? ", stale" : ""})`,
		...configuredRoles(surface).map((role) => renderModelRow(surface, role, rows)),
	].join("\n");
}

export function registerModelCommands(registry: CommandRegistry, surface: CommandSurface): void {
	registry.register({
		name: "models",
		summary: "list configured models by role; `--details` adds scores, prices and backend health",
		usage: "/models [--details]",
		run: async (args): Promise<CommandResult> => {
			const flag = args.trim();
			if (flag === "--details") return { ok: true, text: await renderModelDetails(surface) };
			if (flag.length > 0) {
				return {
					ok: false,
					text: `unknown flag \`${flag}\` — use \`/models\` for the assignment view or \`/models --details\` for scores, prices and ranking diagnostics`,
				};
			}
			return { ok: true, text: await renderModels(surface) };
		},
	});
}
