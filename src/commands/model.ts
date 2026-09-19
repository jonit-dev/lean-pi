/**
 * `/model` and `/models` — the model surface (PRD-016 Phase 2, FR-141).
 *
 * `/models` annotates the configured role bindings from PRD-024's bundled
 * ranking: the file ships with the harness, so there is no refresh, no fetch and
 * no cache to invalidate — freshness moves by a maintainer PR, and a model the
 * ranking does not list renders `coding_score: unavailable` rather than being
 * dropped from the listing.
 *
 * `/model <role>` writes a session-scoped binding the role resolver is consulted
 * through and pins the lane that role fills, so the switch is observable in
 * `/status` and `/route`, not just in this echo. It never edits config on disk.
 */
import { MODEL_ROLES, isModelRole, type BackendRef, type ModelRole } from "../core/types.js";
import { capabilityRows, loadRanking, roleResolutionsOf, type CapabilityRow } from "../capability/index.js";
import { setRoutePins, type RoutePins } from "../compiler/pins.js";
import type { CommandRegistry, CommandResult } from "./registry.js";
import { probeBackends, type CommandSurface } from "./surface.js";

const EXECUTOR_ROLES: readonly ModelRole[] = ["quick", "balanced", "strong", "specialist"];
const REVIEWER_ROLES: readonly ModelRole[] = ["review_quick", "review_strong"];

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

	// The session override and the platform's own resolution are separate facts:
	// one the user asked for, one PRD-001/PRD-024 picked.
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

/** Roles a configured model id fills, so `/model <name>` needs no second model list. */
function rolesOfModel(surface: CommandSurface, name: string): ModelRole[] {
	const matches: ModelRole[] = [];
	for (const role of MODEL_ROLES) {
		const entry = surface.config.models[role];
		if (!entry) continue;
		if (entry.model === name || `${entry.backend}/${entry.model}` === name) matches.push(role);
	}
	return matches;
}

/** `/model <role>` forces that role's lane, exactly as `/route executor|reviewer` does. */
function pinLane(sessionId: string, role: ModelRole): void {
	let pins: RoutePins | undefined;
	if (EXECUTOR_ROLES.includes(role)) pins = { executor_class: role as NonNullable<RoutePins["executor_class"]> };
	else if (REVIEWER_ROLES.includes(role)) pins = { reviewer_class: role as NonNullable<RoutePins["reviewer_class"]> };
	if (pins) setRoutePins(pins, sessionId);
}

export function renderBindings(surface: CommandSurface): string {
	const lines = MODEL_ROLES.map((role) => {
		const binding = surface.bindingFor(role);
		if (!binding.ref) return `${role}: unresolved`;
		return `${role}: ${binding.ref.backend}/${binding.ref.model} (${binding.source})`;
	});
	const reasoning = surface.host.agent()?.thinkingLevel ?? surface.contract?.reasoning.effort ?? "unknown";
	return [...lines, `reasoning: ${reasoning}`].join("\n");
}

export function registerModelCommands(registry: CommandRegistry, surface: CommandSurface): void {
	registry.register({
		name: "model",
		summary: "switch the session's model binding for a role, or show the current bindings and reasoning level",
		usage: "/model [role|model]",
		run: async (args): Promise<CommandResult> => {
			const name = args.trim();
			if (name.length === 0) return { ok: true, text: renderBindings(surface) };

			const sessionId = surface.host.current().getSessionId();
			const role: ModelRole | undefined = isModelRole(name)
				? name
				: rolesOfModel(surface, name).find((candidate) => EXECUTOR_ROLES.includes(candidate)) ?? rolesOfModel(surface, name)[0];
			if (!role) {
				return { ok: false, text: `unknown model or role "${name}" — configure it under \`models:\` or name one of ${MODEL_ROLES.join(", ")}` };
			}

			const binding = surface.bindingFor(role);
			if (!binding.ref) return { ok: false, text: `role "${role}" has no configured backend to bind` };
			surface.bindings.set(role, binding.ref);
			pinLane(sessionId, role);
			return {
				ok: true,
				text: `model: ${role} → ${binding.ref.backend}/${binding.ref.model} (session)\nreasoning: ${surface.host.agent()?.thinkingLevel ?? surface.contract?.reasoning.effort ?? "unknown"}`,
			};
		},
	});

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
