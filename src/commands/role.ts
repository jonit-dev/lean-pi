/**
 * `/role` — the model inventory by role (PRD-016 Phase 2, FR-141; moved here by
 * PRD-048).
 *
 * This is the behaviour `/model` used to have: `/role` annotates the configured
 * role bindings from PRD-024's bundled ranking, picks a model and binds it to a
 * role, and persists the binding. Picking a model *for the session* is `/model`'s
 * job now (PRD-048); binding a role is a config write and lives under its own
 * name so the two cannot be confused.
 *
 * It shadows nothing: Pi has no `/role`. The listing ships the ranking with the
 * harness, so there is no refresh and no cache to invalidate — freshness moves
 * by a maintainer PR, and a model the ranking does not list renders
 * `coding_score: unavailable` rather than being dropped.
 */
import { MODEL_ROLES, isModelRole, type BackendRef, type ModelRole } from "../core/types.js";
import { writeRoleBinding } from "../core/config.js";
import { candidateKey, discoverInventory, modelFactsLine, type DiscoveredModel } from "../cli/allocate.js";
import { modelPicker } from "../cli/model-picker.js";
import { capabilityRows, loadRanking, roleResolutionsOf, type CapabilityGap, type CapabilityRow } from "../capability/index.js";
import { matchModel } from "../capability/match.js";
import type { CommandContext, CommandRegistry, CommandResult } from "./registry.js";
import { probeBackends, type CommandSurface } from "./surface.js";

function rowFor(rows: readonly CapabilityRow[], ref: BackendRef): CapabilityRow | undefined {
	return (
		rows.find((row) => row.backend_binding !== null && row.backend_binding.backend === ref.backend && row.backend_binding.model === ref.model) ??
		matchModel(rows, ref.model)
	);
}

function renderModelRow(surface: CommandSurface, role: ModelRole, rows: readonly CapabilityRow[], gap?: CapabilityGap): string {
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
	// The role floor is not met by the resolved model: named here rather than
	// swallowed, so an unmeasured CLI model is visibly unmeasured.
	const gapLine = gap ? `  capability_gap: ${gap.reason}` : "";
	return `${role.padEnd(14)} ${`${shown.backend}/${shown.model}`.padEnd(28)} ${score}  ${price}  ${fills}  ${evidence}  ${availability}${session}${differs}${gapLine}`;
}

export async function renderModels(surface: CommandSurface): Promise<string> {
	const ranking = loadRanking(surface.config);
	const resolutions = roleResolutionsOf(ranking, surface.config);
	const rows = capabilityRows(ranking, resolutions);
	const gaps = new Map(resolutions.map((selection) => [selection.role, selection.model_id === null ? undefined : selection.capability_gap]));
	if (surface.probes.size === 0) await probeBackends(surface);

	const lines = [
		`ranking revision ${ranking.revision} — oldest record ${ranking.oldest_updated_at} (${ranking.age_days} days old${ranking.stale ? ", stale" : ""})`,
		...MODEL_ROLES.filter((role) => surface.config.models[role] !== undefined || surface.bindings.has(role)).map((role) =>
			renderModelRow(surface, role, rows, gaps.get(role)),
		),
	];
	// The role rows above are what is bound; the inventory is what the machine
	// could bind. Without it a user with three subscriptions sees only the one
	// model their config happens to name and concludes nothing was detected.
	const inventory = discoverInventory({ env: surface.env });
	lines.push("", "discovered on this machine (`/role <role> <backend>:<model>`):");
	lines.push(...inventory.map((model) => `  ${candidateKey(model).padEnd(42)} ${modelFactsLine(model.facts)}  (${model.source})`));
	return lines.join("\n");
}

/** Persist one role binding and make it effective now: the writer `surface.bindings` never had. */
function applyBinding(surface: CommandSurface, role: ModelRole, chosen: DiscoveredModel): CommandResult {
	// Discovery names backends after the vendor, which is exactly how the registry
	// infers the vendor when the entry does not spell one out.
	const backend = chosen.vendor;
	writeRoleBinding(surface.cwd, role, backend, chosen.model);
	// The running session holds its own copy of the config, so the write has to
	// land in both or the binding only takes effect on the next start.
	surface.config.backends[backend] ??= { type: "external_harness" };
	surface.config.models[role] = { backend, model: chosen.model };
	// The pin too, or the capability index keeps re-picking this role for the rest
	// of the session and the operator's choice only holds after a restart.
	surface.config.capability.roles ??= {};
	surface.config.capability.roles[role] = { ...surface.config.capability.roles[role], pin: chosen.model };
	surface.bindings.set(role, { backend, model: chosen.model, type: chosen.facts.execution });
	return { ok: true, text: `${role} → ${backend}/${chosen.model} (written to the config; ${modelFactsLine(chosen.facts)})` };
}

/** The two panes plus the role pane, when Pi has a UI to draw them in. */
async function pickRole(surface: CommandSurface, custom: NonNullable<CommandContext["custom"]>): Promise<CommandResult> {
	const inventory = discoverInventory({ env: surface.env });
	if (inventory.length === 0) return { ok: false, text: "no vendor CLI found on this machine — `/doctor` says what is missing" };
	// The roles a model already serves, so the listing shows what is bound
	// without the reader holding the role rows in their head.
	const bound = new Map<string, ModelRole[]>();
	for (const role of MODEL_ROLES) {
		const binding = surface.config.models[role];
		if (binding === undefined) continue;
		const key = `${binding.backend}:${binding.model}`;
		bound.set(key, [...(bound.get(key) ?? []), role]);
	}
	// Not an overlay: a floating overlay is centred in the viewport, so on a fresh
	// session the panes sat in a field of blank rows well below the prompt. Pi's
	// own selectors render in the editor's place instead, and so does this one.
	const pick = await custom(modelPicker(inventory, bound));
	if (pick?.role === undefined || pick.model === undefined) return { ok: true, text: "no change" };
	return applyBinding(surface, pick.role, pick.model);
}

/** `/role <role> <backend>:<model>` — the same binding, typed rather than picked. */
function bindRole(surface: CommandSurface, args: string): CommandResult {
	const [role, key] = args.split(/\s+/);
	if (role === undefined || key === undefined || !isModelRole(role)) {
		return { ok: false, text: `usage: /role <${MODEL_ROLES.join("|")}> <backend>:<model>` };
	}
	const inventory = discoverInventory({ env: surface.env });
	const chosen = inventory.find((model) => candidateKey(model) === key);
	if (chosen === undefined) {
		return { ok: false, text: `no discovered model \`${key}\` — run /role for the inventory` };
	}
	if (chosen.facts.availability !== "ready") {
		return { ok: false, text: `${key} is ${chosen.facts.availability}: ${chosen.facts.evidence}` };
	}
	return applyBinding(surface, role, chosen);
}

export function registerRoleCommands(registry: CommandRegistry, surface: CommandSurface): void {
	registry.register({
		name: "role",
		summary: "list configured models by role, or bind a role to a discovered model",
		usage: "/role [<role> <backend>:<model>]",
		run: async (args, context): Promise<CommandResult> => {
			const rest = args.trim();
			if (rest.length === 0 && context.custom) return pickRole(surface, context.custom);
			if (rest.length > 0) return bindRole(surface, rest);
			return { ok: true, text: await renderModels(surface) };
		},
	});
}
