/**
 * The two-pane `/model` picker (FR-141).
 *
 * Rendered against a stub TUI and a plain-text theme, so the assertion is the
 * layout and the flow — providers left, that provider's models right, a chosen
 * model bound to a role — and not a screenful of escape sequences.
 */
import { describe, expect, it } from "vitest";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { modelPicker, type ModelPick } from "../../src/cli/model-picker.js";
import type { DiscoveredModel } from "../../src/cli/allocate.js";

const ENTER = "\r";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";

function model(vendor: DiscoveredModel["vendor"], id: string, source: string, availability: DiscoveredModel["facts"]["availability"] = "ready"): DiscoveredModel {
	return {
		vendor,
		model: id,
		source,
		facts: { execution: "external_harness", availability, evidence: `${vendor} evidence`, coding_score: null, price_blended_per_mtok: null },
	};
}

const INVENTORY = [
	model("claude", "opus[1m]", "claude settings"),
	model("claude", "sonnet", "claude alias"),
	model("codex", "gpt-6-astra", "codex config.toml"),
	model("codex", "gpt-5.6-luna", "codex model catalog"),
	model("opencode", "opencode-go/deepseek-v4.1-flash", "opencode models", "signed-out"),
];

/** A theme that paints nothing, so the test reads the text it laid out. */
const theme = { fg: (_colour: string, text: string) => text } as unknown as Theme;

function picker(bound: Map<string, string[]> = new Map()): { component: Component; picks: (ModelPick | undefined)[] } {
	const picks: (ModelPick | undefined)[] = [];
	const tui = { requestRender: () => {} } as unknown as TUI;
	const component = modelPicker(INVENTORY, bound as Map<string, never>)(tui, theme, undefined, (pick) => picks.push(pick));
	return { component, picks };
}

describe("the /model picker", () => {
	it("puts the providers in the left column and the selected provider's models in the right", () => {
		const { component } = picker(new Map([["claude:sonnet", ["strong"]]]));

		const screen = component.render(80).join("\n");

		// Every vendor, with how many models it exposes.
		expect(screen).toContain("claude");
		expect(screen).toContain("codex");
		expect(screen).toContain("opencode");
		// The first provider's models, not every model on the machine.
		expect(screen).toContain("opus[1m]");
		expect(screen).toContain("sonnet");
		expect(screen).not.toContain("gpt-6-astra");
		// A role already bound to a model is read off the row, not off memory.
		expect(screen).toContain("strong");
		// Two columns: the provider name and a model share a line.
		expect(screen.split("\n").some((line) => line.includes("claude") && line.includes("opus[1m]"))).toBe(true);
	});

	it("lines the column headers up with the columns they name", () => {
		const { component } = picker();

		const lines = component.render(90).map((line) => line.replace(/\x1b\][^\x07]*\x07/g, ""));
		const [header, first] = lines as [string, string];

		// A "providers │ models" line puts its second label at column 13 while the
		// column it names starts at 24. Both labels sit over their own names.
		expect(header.indexOf("providers")).toBe(first.indexOf("claude") - "● ".length);
		expect(header.indexOf("models")).toBe(first.indexOf("opus[1m]"));
	});

	it("moves to the second provider's models and binds the chosen one to a role", () => {
		const { component, picks } = picker();

		component.handleInput?.(DOWN); // providers: claude → codex
		component.handleInput?.(RIGHT); // focus the model pane
		expect(component.render(80).join("\n")).toContain("gpt-6-astra");

		component.handleInput?.(DOWN); // gpt-6-astra → gpt-5.6-luna
		component.handleInput?.(ENTER); // choose the model, ask for the role
		const roles = component.render(80).join("\n");
		expect(roles).toContain("bind codex/gpt-5.6-luna");
		expect(roles).toContain("quick");
		expect(roles).toContain("review_strong");

		component.handleInput?.(DOWN); // quick → balanced
		component.handleInput?.(ENTER);
		expect(picks).toEqual([{ role: "balanced", model: INVENTORY[3] }]);
	});

	it("refuses a model whose vendor this machine cannot run, and says why", () => {
		const { component, picks } = picker();

		component.handleInput?.(DOWN);
		component.handleInput?.(DOWN); // providers: → opencode
		component.handleInput?.(RIGHT);
		component.handleInput?.(ENTER);

		expect(picks).toEqual([]);
		expect(component.render(80).join("\n")).toContain("opencode evidence");
	});
});
