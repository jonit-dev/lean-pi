/**
 * `/model` — the session's manual model pick (PRD-048).
 *
 * `/model` used to bind a pick to a *role*: it wrote the config and the router
 * still chose the executor class per turn, so the pick only landed on turns
 * routed to that role — and on a native config `ownsExecutionLoop` is false, so
 * Pi's own loop ran every turn and no pick could ever take effect. The operator
 * meant "the model being used now", so that is what this command does: it pins
 * the exact backend/model on the session (the footer says `Manual`), and role
 * binding moved to `/role`.
 *
 * The pick is session state, never a config write: `/model auto`, `/new`,
 * `/resume` and `/route reset` return to Auto. The picker lists the native
 * backends the config carries and the vendor CLIs the machine has, because on a
 * native config a CLI model is exactly the pick that used to be impossible.
 */
import { MODEL_ROLES } from "../core/types.js";
import { routePins, setRoutePins } from "../compiler/pins.js";
import { discoverInventory, modelFactsLine, type DiscoveredModel } from "../cli/allocate.js";
import { modelPicker } from "../cli/model-picker.js";
import type { HarnessVendor } from "../backends/harness.js";
import type { CommandContext, CommandRegistry, CommandResult } from "./registry.js";
import type { CommandSurface } from "./surface.js";

/** `backend:model`, the key the typed form and the listing both use. */
function pinKey(model: DiscoveredModel): string {
	return `${model.backend ?? model.vendor}:${model.model}`;
}

/**
 * The native models the config already carries. A native backend has no `models`
 * command to enumerate, so the ids come from what the role map binds to it plus
 * any `model` on the entry itself — the same set the compiler can route to.
 */
function nativeModels(surface: CommandSurface): DiscoveredModel[] {
	const models: DiscoveredModel[] = [];
	const seen = new Set<string>();
	for (const [name, backend] of Object.entries(surface.config.backends)) {
		if (backend.type !== "native" || backend.enabled === false) continue;
		const ids = new Set<string>();
		for (const role of MODEL_ROLES) {
			const binding = surface.config.models[role];
			if (binding?.backend === name) ids.add(binding.model);
		}
		const declared = (backend as { model?: unknown }).model;
		if (typeof declared === "string" && declared.length > 0) ids.add(declared);
		for (const model of ids) {
			const key = `${name}:${model}`;
			if (seen.has(key)) continue;
			seen.add(key);
			models.push({
				// The backend's own name is the provider key; discovery does the same
				// for a CLI vendor, so the picker's provider pane groups both.
				vendor: name as HarnessVendor,
				backend: name,
				model,
				source: `native backend ${name}`,
				facts: { execution: "native", availability: "ready", evidence: "configured native backend", coding_score: null, price_blended_per_mtok: null },
			});
		}
	}
	return models;
}

/** The providers the picker offers: native backends first, then the vendor CLIs. */
function pinInventory(surface: CommandSurface): DiscoveredModel[] {
	return [...nativeModels(surface), ...discoverInventory({ env: surface.env })];
}

/** The printed fallback (no UI): the current mode, then the inventory. */
function renderPinInventory(surface: CommandSurface): string {
	const pin = routePins().model;
	const lines = [pin ? `model: ${pin.backend}/${pin.model} (Manual)` : "model: Auto (the router decides)"];
	const inventory = pinInventory(surface);
	lines.push("", "discovered on this machine (`/model <backend>:<model>`, or `/model auto`):");
	lines.push(...inventory.map((model) => `  ${pinKey(model).padEnd(42)} ${modelFactsLine(model.facts)}  (${model.source})`));
	return lines.join("\n");
}

/** Pin one model for the session. Nothing is written to `leanpi.config.yaml`. */
function pinModel(surface: CommandSurface, chosen: DiscoveredModel): CommandResult {
	const backend = chosen.backend ?? chosen.vendor;
	// A discovered CLI backend may be absent from the config; the running session
	// needs the entry so the executor lane's registry can spawn it. The config is
	// in memory only — `/role` is the command that writes.
	surface.config.backends[backend] ??= { type: "external_harness" };
	setRoutePins({ model: { backend, model: chosen.model, type: chosen.facts.execution } }, surface.host.current().getSessionId());
	return {
		ok: true,
		text: `model pinned to ${backend}/${chosen.model} (Manual) for this session — /model auto, /new or /resume returns to Auto`,
	};
}

/** `/model auto` — clear the pin, and only the pin: the route overrides stand. */
function clearPin(surface: CommandSurface): CommandResult {
	setRoutePins({ model: undefined }, surface.host.current().getSessionId());
	return { ok: true, text: "model: Auto — the router decides the model again" };
}

/** `/model <backend>:<model>` — the picker's answer, typed. */
function pinByKey(surface: CommandSurface, key: string): CommandResult {
	const index = key.indexOf(":");
	if (index <= 0 || index === key.length - 1) {
		return { ok: false, text: `usage: /model <backend>:<model> (or /model auto) — run /model for the inventory` };
	}
	const backend = key.slice(0, index);
	const model = key.slice(index + 1);
	const inventory = pinInventory(surface);
	const chosen = inventory.find((entry) => entry.model === model && (entry.backend ?? entry.vendor) === backend);
	if (chosen === undefined) {
		return { ok: false, text: `no model \`${key}\` on this machine — run /model for the inventory` };
	}
	if (chosen.facts.availability !== "ready") {
		return { ok: false, text: `${key} is ${chosen.facts.availability}: ${chosen.facts.evidence}` };
	}
	return pinModel(surface, chosen);
}

/** The picker: providers left (native and CLI), models right, pin on enter. */
async function pickPin(surface: CommandSurface, custom: NonNullable<CommandContext["custom"]>): Promise<CommandResult> {
	const inventory = pinInventory(surface);
	if (inventory.length === 0) return { ok: false, text: "no native backend or vendor CLI found — `/doctor` says what is missing" };
	const pick = await custom(modelPicker(inventory, new Map(), { mode: "model" }));
	if (pick === undefined) return { ok: true, text: "no change" };
	if (pick.auto === true) return clearPin(surface);
	if (pick.model === undefined) return { ok: true, text: "no change" };
	return pinModel(surface, pick.model);
}

export function registerModelCommands(registry: CommandRegistry, surface: CommandSurface): void {
	registry.register({
		name: "model",
		summary: "pick the model this session runs on (Manual), or return to Auto; role binding is /role",
		usage: "/model [<backend>:<model>|auto]",
		run: async (args, context): Promise<CommandResult> => {
			const rest = args.trim();
			if (rest === "auto") return clearPin(surface);
			if (rest === "use" || rest.startsWith("use ")) {
				return { ok: false, text: "`/model use` was removed — bind a role with `/role <role> <backend>:<model>`" };
			}
			if (rest.length > 0) return pinByKey(surface, rest);
			if (context.custom) return pickPin(surface, context.custom);
			return { ok: true, text: renderPinInventory(surface) };
		},
	});
}
