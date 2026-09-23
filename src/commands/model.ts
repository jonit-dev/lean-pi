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
 * The pick is session state, never a config write: it survives `/new` and
 * `/resume`, and only `/model auto` returns to Auto (docs/systems/model-modes.md). The picker lists the native
 * backends the config carries and the vendor CLIs the machine has, because on a
 * native config a CLI model is exactly the pick that used to be impossible.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MODEL_ROLES, type BackendRef, type LeanPiConfig } from "../core/types.js";
import { routePins, setRoutePins } from "../compiler/pins.js";
import { discoverInventory, modelFactsLine, type DiscoveredModel } from "../cli/allocate.js";
import { modelPicker } from "../cli/model-picker.js";
import { manualStatusLine } from "../cli/statusline.js";
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

/** `<home>/.leanpi/model.json` — where `remember_manual_model: true` saves the pin (PRD-048 Phase 2). */
function rememberedModelPath(env: NodeJS.ProcessEnv): string {
	return join(env.HOME ?? homedir(), ".leanpi", "model.json");
}

function writeRememberedModel(config: LeanPiConfig, env: NodeJS.ProcessEnv, pin: BackendRef): void {
	if (config.remember_manual_model !== true) return;
	const path = rememberedModelPath(env);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(pin));
}

function deleteRememberedModel(env: NodeJS.ProcessEnv): void {
	const path = rememberedModelPath(env);
	if (existsSync(path)) rmSync(path);
}

/**
 * Startup only (PRD-048 Phase 2): restores the pin a previous session saved
 * with `remember_manual_model: true`. A corrupt or unreadable file must not
 * stop the session from starting — it just leaves the session in Auto.
 */
export function restoreRememberedModel(config: LeanPiConfig, env: NodeJS.ProcessEnv): void {
	if (config.remember_manual_model !== true) return;
	const path = rememberedModelPath(env);
	if (!existsSync(path)) return;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Record<keyof BackendRef, unknown>>;
		// The file is on disk, not something this session wrote just now: a
		// corrupt or hand-edited one must not become a pin the compiler trusts.
		if (typeof parsed.backend !== "string" || parsed.backend.length === 0) return;
		if (typeof parsed.model !== "string" || parsed.model.length === 0) return;
		if (parsed.type !== "native" && parsed.type !== "external_harness") return;
		const pin: BackendRef = { backend: parsed.backend, model: parsed.model, type: parsed.type };
		// Same as a fresh `/model` pin: a discovered CLI backend may be absent
		// from the config, and the executor lane's registry needs the entry to
		// spawn it.
		if (pin.type === "external_harness") config.backends[pin.backend] ??= { type: "external_harness" };
		setRoutePins({ model: pin });
	} catch {
		// A corrupt remembered pin must not stop the session from starting.
	}
}

/** Pin one model for the session. Nothing is written to `leanpi.config.yaml`. */
async function pinModel(surface: CommandSurface, chosen: DiscoveredModel, context: CommandContext): Promise<CommandResult> {
	const backend = chosen.backend ?? chosen.vendor;
	// A discovered CLI backend may be absent from the config; the running session
	// needs the entry so the executor lane's registry can spawn it. The config is
	// in memory only — `/role` is the command that writes.
	surface.config.backends[backend] ??= { type: "external_harness" };
	// The model Pi was running before Manual started, captured once regardless
	// of what kind of pick started it — a CLI pin also ends Auto, and `/model
	// auto` has to restore whatever was running before it, not just before the
	// most recent pin.
	if (routePins().model === undefined) {
		const current = context.footer?.current();
		if (current) setRoutePins({ previousModel: current });
	}
	// Only a native pick is something Pi's own loop can run: switching now, not
	// on the next turn, is what makes the footer's (and Pi's own) model change
	// at pin time.
	if (chosen.facts.execution === "native") await context.footer?.setModel(backend, chosen.model);
	const pin: BackendRef = { backend, model: chosen.model, type: chosen.facts.execution };
	// A repin — even to the same model — starts a fresh conversation: the
	// vendor session a previous CLI pin remembered belonged to that pin.
	setRoutePins({ model: pin, manualSessionId: undefined }, surface.host.current().getSessionId());
	writeRememberedModel(surface.config, surface.env, pin);
	context.footer?.setStatus(manualStatusLine(pin, true));
	return {
		ok: true,
		text: `model pinned to ${backend}/${chosen.model} (Manual) — /model auto returns to Auto`,
	};
}

/** `/model auto` — clear the pin, and only the pin: the route overrides stand. */
async function clearPin(surface: CommandSurface, context: CommandContext): Promise<CommandResult> {
	const previous = routePins().previousModel;
	setRoutePins({ model: undefined, previousModel: undefined, manualSessionId: undefined }, surface.host.current().getSessionId());
	if (previous) await context.footer?.setModel(previous.backend, previous.model);
	deleteRememberedModel(surface.env);
	context.footer?.setStatus(undefined);
	return { ok: true, text: "model: Auto — the router decides the model again" };
}

/** `/model <backend>:<model>` — the picker's answer, typed. */
async function pinByKey(surface: CommandSurface, key: string, context: CommandContext): Promise<CommandResult> {
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
	return pinModel(surface, chosen, context);
}

/** The picker: providers left (native and CLI), models right, pin on enter. */
async function pickPin(surface: CommandSurface, context: CommandContext): Promise<CommandResult> {
	const inventory = pinInventory(surface);
	if (inventory.length === 0) return { ok: false, text: "no native backend or vendor CLI found — `/doctor` says what is missing" };
	const pick = await context.custom!(modelPicker(inventory, new Map(), { mode: "model" }));
	if (pick === undefined) return { ok: true, text: "no change" };
	if (pick.auto === true) return clearPin(surface, context);
	if (pick.model === undefined) return { ok: true, text: "no change" };
	return pinModel(surface, pick.model, context);
}

export function registerModelCommands(registry: CommandRegistry, surface: CommandSurface): void {
	registry.register({
		name: "model",
		summary: "pick the model this session runs on (Manual), or return to Auto; role binding is /role",
		usage: "/model [<backend>:<model>|auto]",
		run: async (args, context): Promise<CommandResult> => {
			const rest = args.trim();
			if (rest === "auto") return clearPin(surface, context);
			if (rest === "use" || rest.startsWith("use ")) {
				return { ok: false, text: "`/model use` was removed — bind a role with `/role <role> <backend>:<model>`" };
			}
			if (rest.length > 0) return pinByKey(surface, rest, context);
			if (context.custom) return pickPin(surface, context);
			return { ok: true, text: renderPinInventory(surface) };
		},
	});
}
