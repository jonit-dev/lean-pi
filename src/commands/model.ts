/**
 * `/models` — the model inventory by role (PRD-016 Phase 2, FR-141).
 *
 * `/models` annotates the configured role bindings from PRD-024's bundled
 * ranking: the file ships with the harness, so there is no refresh, no fetch and
 * no cache to invalidate — freshness moves by a maintainer PR, and a model the
 * ranking does not list renders `coding_score: unavailable` rather than being
 * dropped from the listing.
 *
 * There is deliberately no `/model` here. Pi already ships an interactive model
 * selector under that name, and LeanPi's own switch is per *role*, which is what
 * `/route executor|reviewer <class>` already writes — a second spelling of it
 * would only shadow Pi's command with a weaker one.
 */
import { MODEL_ROLES, type BackendRef, type ModelRole } from "../core/types.js";
import { capabilityRows, loadRanking, roleResolutionsOf, type CapabilityRow } from "../capability/index.js";
import type { CommandRegistry, CommandResult } from "./registry.js";
import { probeBackends, type CommandSurface } from "./surface.js";

function rowFor(rows: readonly CapabilityRow[], ref: BackendRef): CapabilityRow | undefined {
	const model = ref.model.toLowerCase();
	return rows.find(
		(row) =>
			row.model_id.toLowerCase() === model ||
			(row.backend_binding !== null && row.backend_binding.backend === ref.backend && row.backend_binding.model === ref.model),
	);
}

function renderModelRow(surface: CommandSurface, role: ModelRole, rows: readonly CapabilityRow[]): string {
	const configured = surface.config.models[role];
	const override = surface.bindings.get(role);
	const resolved = surface.bindingFor(role);
	const configuredRef: BackendRef | null = configured
		? { backend: configured.backend, model: configured.model, type: surface.config.backends[configured.backend]?.type ?? "native" }
		: null;
	const shown = configuredRef ?? resolved.ref;
	if (!shown) return `${role.padEnd(14)} unresolved`;

	const probe = surface.probes.get(shown.backend);
	const availability = probe ? `backend: ${probe.status} (${probe.reason})` : "backend: not probed";
	const row = rowFor(rows, shown);
	const score = row ? (row.coding_score === null ? "coding_score: unavailable" : `coding_score: ${row.coding_score}`) : "coding_score: unavailable";
	const price = row
		? row.price_blended_per_mtok === null
			? "price: unknown"
			: `price: $${row.price_blended_per_mtok}/Mtok blended`
		: "price: unknown";
	const fills = row ? `roles: ${row.roles.join(", ") || "none"}` : "roles: unlisted";
	const evidence = row ? `evidence: ${row.evidence}` : "evidence: none";

	// A session override and the platform's own resolution are separate facts:
	// one someone set on the surface, one PRD-001/PRD-024 picked.
	const session = override ? `  session: ${override.backend}/${override.model}` : "";
	const differs =
		!override && resolved.ref !== null && (resolved.ref.backend !== shown.backend || resolved.ref.model !== shown.model)
			? `  resolved: ${resolved.ref.backend}/${resolved.ref.model}`
			: "";
	return `${role.padEnd(14)} ${`${shown.backend}/${shown.model}`.padEnd(28)} ${score}  ${price}  ${fills}  ${evidence}  ${availability}${session}${differs}`;
}

export async function renderModels(surface: CommandSurface): Promise<string> {
	const ranking = loadRanking(surface.config);
	const rows = capabilityRows(ranking, roleResolutionsOf(ranking, surface.config));
	if (surface.probes.size === 0) await probeBackends(surface);

	const lines = [
		`ranking revision ${ranking.revision} — oldest record ${ranking.oldest_updated_at} (${ranking.age_days} days old${ranking.stale ? ", stale" : ""})`,
		...MODEL_ROLES.filter((role) => surface.config.models[role] !== undefined || surface.bindings.has(role)).map((role) =>
			renderModelRow(surface, role, rows),
		),
	];
	return lines.join("\n");
}

export function registerModelCommands(registry: CommandRegistry, surface: CommandSurface): void {
	registry.register({
		name: "models",
		summary: "list configured models by role with availability, coding score and price",
		usage: "/models",
		run: async (args): Promise<CommandResult> => {
			if (args.trim().length > 0) {
				return {
					ok: false,
					text: `unknown flag \`${args.trim()}\` — the ranking ships with the harness and is never fetched; freshness moves by a maintainer PR`,
				};
			}
			return { ok: true, text: await renderModels(surface) };
		},
	});
}
