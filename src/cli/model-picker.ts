/**
 * `/model` as two panes: the providers this machine has, and the models each
 * one exposes (FR-141).
 *
 * The listing `/model` printed was one flat column of `backend:model` lines,
 * which on a machine with three subscriptions is thirteen rows of nearly
 * identical text and no way to act on any of them. Providers and models are two
 * different questions — *which account*, then *which model on it* — so they get
 * two panes, and binding happens where the model is read instead of in a second
 * command typed from memory.
 *
 * Built from Pi's own `ctx.ui.custom` and pi-tui's `SelectList`, so the colours
 * are the active theme's and the scrolling, filtering and mouse handling are the
 * ones every other Pi selector already has. LeanPi renders no frame of its own,
 * and takes the editor's place rather than floating over the viewport.
 */
import { HStack, SelectList, Text, VStack, matchesKey, type Component, type SelectItem, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { MODEL_ROLES, type ModelRole } from "../core/types.js";
import type { DiscoveredModel } from "./allocate.js";

/** The provider row that returns the session to Auto (PRD-048). */
export const AUTO_PROVIDER = "auto";

/**
 * What the picker returns: the model to bind. `/role` adds the role to bind it
 * to; `/model` (PRD-048) pins the model itself and sets `auto` to clear a pin.
 */
export interface ModelPick {
	model?: DiscoveredModel;
	role?: ModelRole;
	/** True when the operator chose the `auto` row: hand routing back to the router. */
	auto?: boolean;
}

/** `model` pins and closes on the model; `role` adds the role pane (PRD-030/048). */
export type PickerMode = "model" | "role";

/** Rows the panes are tall; Pi's own selectors sit in the same range. */
const VISIBLE = 12;
/** The provider pane is a column of short names — the models need the rest. */
const PROVIDER_WIDTH = 22;
/** Between the two panes, and between the two header labels above them. */
const PANE_GAP = 2;
/** `SelectList` prefixes every row with `→ ` or two spaces; the headers match it. */
const GUTTER = 2;
/**
 * `shrink: 0`, or a pane of long model ids takes its width out of the provider
 * column and the counts disappear off the ends of the names. Shared by the
 * header and the panes so the labels cannot drift off the columns they name.
 */
const LEFT_COLUMN = { basis: PROVIDER_WIDTH, shrink: 0 } as const;
/**
 * `SelectList` defaults its name column to 32 and truncates past it, which cuts
 * `opencode-go/deepseek-v4.1-flash` mid-id while the description column keeps
 * room it does not need. The id is the thing being chosen, so it gets the space
 * first; short lists still close up to the minimum.
 */
const MODEL_COLUMN = { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 44 };

const READY_MARK: Record<DiscoveredModel["facts"]["availability"], string> = {
	ready: "●",
	"signed-out": "○",
	"not-installed": "×",
};

/**
 * A list's style, in accent while it holds focus and muted while it does not.
 * `SelectList` marks its selected row whether or not anyone is typing at it, so
 * two panes side by side both draw an arrow and neither says which one the keys
 * reach. The predicate is read at render time, so the panes swap on focus
 * without either list being rebuilt.
 */
function listTheme(theme: Theme, focused: () => boolean): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg(focused() ? "accent" : "dim", text),
		selectedText: (text) => theme.fg(focused() ? "accent" : "muted", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("dim", text),
	};
}

/** Vendors in discovery order, each with how many models it exposes and whether it can run. */
function providerItems(inventory: readonly DiscoveredModel[], theme: Theme, withAuto: boolean): SelectItem[] {
	const vendors = [...new Set(inventory.map((model) => model.vendor))];
	const items = vendors.map((vendor) => {
		const models = inventory.filter((model) => model.vendor === vendor);
		const availability = models[0]?.facts.availability ?? "not-installed";
		const colour = availability === "ready" ? "success" : availability === "signed-out" ? "warning" : "error";
		// The count rides in the label: the description column is the models
		// pane's, and a 22-column provider pane has no room for a second one.
		return { value: vendor, label: `${theme.fg(colour, READY_MARK[availability])} ${vendor.padEnd(10)}${theme.fg("dim", String(models.length).padStart(3))}` };
	});
	// `auto` rides in the provider pane so the picker can undo a pin without
	// leaving it: the row is not a provider, it is the absence of one.
	return withAuto ? [{ value: AUTO_PROVIDER, label: theme.fg("muted", "↺ auto     ") }, ...items] : items;
}

function modelItems(models: readonly DiscoveredModel[], bound: ReadonlyMap<string, ModelRole[]>, theme: Theme): SelectItem[] {
	return models.map((model) => {
		const roles = bound.get(`${model.vendor}:${model.model}`);
		// The roles a model already serves are the one fact that changes what the
		// user does next, so they take the description column when there are any;
		// otherwise it says why the model is on the list at all. Past two roles the
		// list is longer than the column and the count is the readable form.
		const served = roles === undefined ? undefined : roles.length > 2 ? `${roles.length} roles` : roles.join(", ");
		return { value: model.model, label: model.model, description: served === undefined ? model.source : theme.fg("accent", served) };
	});
}

/**
 * The picker: providers left, that provider's models right, and — once a model
 * is chosen — the six roles in the right pane's place, because a nested dialog
 * would have to take focus back off this one.
 */
class ModelPicker implements Component {
	private readonly providers: SelectList;
	private readonly roles: SelectList;
	// The header is laid out by the same rule as the panes rather than written as
	// one string: a "providers │ models" line puts its second label at column 13
	// while the column it names starts at 24.
	// Indented by the lists' own selection gutter, so a label sits over the names
	// in its column rather than over the arrows.
	private readonly headerLeft = new Text("", GUTTER, 0);
	private readonly headerRight = new Text("", GUTTER, 0);
	private readonly header = new HStack([], { gap: PANE_GAP });
	private readonly hint = new Text("", GUTTER, 0);
	private readonly panes = new HStack([], { gap: PANE_GAP });
	private readonly root: VStack;
	private readonly modelStyle: SelectListTheme;
	/** `SelectList` takes its items once, so the right pane is a new list per provider. */
	private models: SelectList;
	private focus: "providers" | "models" | "roles" = "providers";
	private chosen: DiscoveredModel | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly inventory: readonly DiscoveredModel[],
		private readonly bound: ReadonlyMap<string, ModelRole[]>,
		private readonly done: (pick: ModelPick | undefined) => void,
		private readonly mode: PickerMode = "role",
	) {
		this.modelStyle = listTheme(theme, () => this.focus === "models");
		// The provider pane is exactly as wide as its column: without a bound of its
		// own the list claims the default 32, and the stack takes the difference out
		// of the pane, truncating the counts off the ends of the names.
		this.providers = new SelectList(providerItems(inventory, theme, mode === "model"), VISIBLE, listTheme(theme, () => this.focus === "providers"), {
			minPrimaryColumnWidth: PROVIDER_WIDTH,
			maxPrimaryColumnWidth: PROVIDER_WIDTH,
		});
		this.roles = new SelectList(
			MODEL_ROLES.map((role) => ({ value: role, label: role })),
			VISIBLE,
			listTheme(theme, () => this.focus === "roles"),
		);
		this.models = new SelectList([], VISIBLE, this.modelStyle, MODEL_COLUMN);
		this.header.addChild(this.headerLeft, LEFT_COLUMN);
		this.header.addChild(this.headerRight, { grow: 1 });
		this.root = new VStack([this.header, this.panes, this.hint]);

		this.providers.onSelectionChange = () => this.showModels();
		this.providers.onSelect = () => {
			// The `auto` row is an answer, not a drill-down: there are no models under it.
			if (mode === "model" && this.vendor === AUTO_PROVIDER) return this.done({ auto: true });
			this.setFocus("models");
		};
		this.providers.onCancel = () => this.done(undefined);
		this.roles.onSelect = (item) => this.done(this.chosen ? { role: item.value as ModelRole, model: this.chosen } : undefined);
		this.roles.onCancel = () => this.setFocus("models");
		this.showModels();
	}

	private get vendor(): string {
		return this.providers.getSelectedItem()?.value ?? "";
	}

	/** The right pane, rebuilt for the provider now under the cursor. */
	private showModels(): void {
		const auto = this.vendor === AUTO_PROVIDER;
		const models = auto ? [] : this.inventory.filter((entry) => entry.vendor === this.vendor);
		// Under `auto` there is no model to pick, only what Auto means — not the
		// list's own "No matching commands", which read as a broken search.
		const items = auto ? [{ value: AUTO_PROVIDER, label: this.theme.fg("muted", "the router picks the model per turn") }] : modelItems(models, this.bound, this.theme);
		this.models = new SelectList(items, VISIBLE, this.modelStyle, MODEL_COLUMN);
		this.models.onSelect = (item) => (auto ? this.done({ auto: true }) : this.chooseModel(models.find((entry) => entry.model === item.value)));
		this.models.onCancel = () => this.setFocus("providers");
		this.rebuild();
	}

	private chooseModel(model: DiscoveredModel | undefined): void {
		if (model === undefined) return;
		if (model.facts.availability !== "ready") {
			// A model on a vendor this machine cannot run stays listed — that is the
			// point of keeping exclusions visible — but binding it would write a
			// config that fails on the first turn.
			this.chosen = undefined;
			this.hint.setText(this.theme.fg("error", ` ${model.facts.evidence}`));
			this.tui.requestRender();
			return;
		}
		this.chosen = model;
		// `/model` pins the model itself: there is no role step to ask for (PRD-048).
		if (this.mode === "model") return this.done({ model });
		this.setFocus("roles");
	}

	private setFocus(next: "providers" | "models" | "roles"): void {
		this.focus = next;
		this.rebuild();
	}

	private rebuild(): void {
		this.panes.clear();
		this.panes.addChild(this.providers, LEFT_COLUMN);
		this.panes.addChild(this.focus === "roles" ? this.roles : this.models, { grow: 1 });
		this.headerLeft.setText(this.theme.fg(this.focus === "providers" ? "accent" : "muted", "providers"));
		this.headerRight.setText(
			this.focus === "roles" && this.chosen
				? `${this.theme.fg("accent", "bind")} ${this.chosen.vendor}/${this.chosen.model} ${this.theme.fg("muted", "to which role?")}`
				: this.theme.fg(this.focus === "models" ? "accent" : "muted", "models"),
		);
		this.hint.setText(
			this.theme.fg("dim", this.focus === "roles" ? "↑/↓ role · enter bind · esc back" : "↑/↓ move · ←/→ pane · enter select · esc close"),
		);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.root.render(width);
	}

	invalidate(): void {
		this.root.invalidate();
	}

	handleInput(data: string): void {
		if (this.focus !== "roles") {
			if (matchesKey(data, "right") || matchesKey(data, "tab")) return this.setFocus("models");
			if (matchesKey(data, "left")) return this.setFocus("providers");
		}
		const active = this.focus === "providers" ? this.providers : this.focus === "models" ? this.models : this.roles;
		active.handleInput(data);
		this.tui.requestRender();
	}
}

/** The factory `ctx.ui.custom` takes; `done` carries the pick, or nothing on escape. */
export function modelPicker(
	inventory: readonly DiscoveredModel[],
	bound: ReadonlyMap<string, ModelRole[]>,
	options: { mode?: PickerMode } = {},
): (tui: TUI, theme: Theme, keybindings: unknown, done: (pick: ModelPick | undefined) => void) => Component {
	return (tui, theme, _keybindings, done) => new ModelPicker(tui, theme, inventory, bound, done, options.mode ?? "role");
}
