/**
 * `/usage` on a LeanPi machine.
 *
 * The bundled `@hk_net/pi-usage-bars` command resolves providers through Pi's
 * own model registry against a fixed vendor list. LeanPi's Codex/Claude are
 * external harnesses it spawns itself and OpenCode is registered under the
 * operator's own name, so the selector opens on "No matching configured
 * providers" — the command renders nothing. These tests pin the replacement:
 * one `usage` registration that answers from LeanPi's inventory, with the
 * bundled factory's polling/flag still attached.
 */
import { describe, expect, it, vi } from "vitest";
import { renderUsage, usageAdapter, usageInventory, type UsageRow } from "../../src/cli/usage.js";
import type { SubscriptionState } from "../../src/backends/subscriptions.js";
import type { HarnessVendor } from "../../src/backends/harness.js";

/** A config with a native backend and a signed-out external harness. */
const config = {
	backends: {
		"opencode-go": { type: "native", baseUrl: "https://opencode.ai/zen/go/v1", api: "openai-completions" },
		codex: { type: "external_harness", vendor: "codex", command: "codex" },
	},
	models: { balanced: { backend: "opencode-go", model: "deepseek-v4.1-flash" } },
} as never;

function vendorState(vendor: HarnessVendor, overrides: Partial<SubscriptionState> = {}): SubscriptionState {
	return { backend: vendor, vendor, command: vendor, onPath: true, signedIn: true, evidence: `${vendor} signed in`, ...overrides };
}

const noVendor = (vendor: HarnessVendor, options: { backend?: string } = {}) =>
	vendorState(vendor, { backend: options.backend ?? vendor, onPath: false, signedIn: false, evidence: `${vendor} is not on PATH` });

describe("the /usage inventory", () => {
	it("names every configured backend instead of an empty selector", async () => {
		const rows = await usageInventory(config, {
			env: { PATH: "/bin" },
			probe: async () => ({ status: "ok", reason: "reachable at opencode.ai:443" }),
			vendor: (vendor, options) =>
				options.backend === "codex"
					? vendorState(vendor, { command: "codex", signedIn: false, evidence: "codex login status: not signed in" })
					: noVendor(vendor),
		});

		// The native backend and the configured harness are both present; the
		// signed-out harness says what to run rather than vanishing.
		expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining(["opencode-go", "codex"]));
		expect(rows.find((row) => row.name === "opencode-go")).toMatchObject({ state: "reachable", detail: "reachable at opencode.ai:443" });
		expect(rows.find((row) => row.name === "codex")).toMatchObject({ state: "reauth-required" });
		expect(rows.find((row) => row.name === "codex")?.detail).toContain("codex login");
	});

	it("keeps a detected-but-unconfigured vendor visible and folds a configured one into its row", async () => {
		const rows = await usageInventory(config, {
			env: { PATH: "/bin" },
			probe: async () => ({ status: "ok", reason: "reachable at opencode.ai:443" }),
			vendor: (vendor) => vendorState(vendor),
		});

		// `codex` is configured, so the detected aggregate folds into its row; the
		// unconfigured `claude` login is still reported.
		expect(rows.filter((row) => row.name === "codex")).toHaveLength(1);
		expect(rows.find((row) => row.name === "claude")).toMatchObject({ state: "detected (not configured)" });
	});

	it("renders an actionable empty state only when nothing is configured or detected", async () => {
		const rows = await usageInventory({ backends: {}, models: {} } as never, {
			env: { PATH: "/bin" },
			vendor: (vendor) => noVendor(vendor),
		});

		expect(rows).toEqual([]);
		expect(renderUsage(rows)).toContain("no backends configured");
		// The bundled extension's empty state is never the answer.
		expect(renderUsage(rows)).not.toContain("No matching configured providers");
	});

	it("renders one line per row and advertises the bundled details selector", async () => {
		const rows: UsageRow[] = [
			{ name: "opencode-go", kind: "configured", state: "reachable", detail: "reachable at opencode.ai:443" },
			{ name: "codex", kind: "configured", state: "reauth-required", detail: "run `codex login`" },
		];
		const text = renderUsage(rows);

		expect(text).toContain("opencode-go");
		expect(text).toContain("codex");
		expect(text).toContain("/usage details");
		expect(text).not.toContain("No matching configured providers");
	});
});

describe("the /usage adapter", () => {
	it("drops the bundled usage registration and owns exactly one", async () => {
		const registered = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
		const bundled = vi.fn((pi: { registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => void }) => {
			pi.registerCommand("usage", { handler: async () => {} });
		});
		const notify = vi.fn();
		const inventory = vi.fn(async () => [{ name: "opencode-go", kind: "configured", state: "reachable", detail: "reachable at opencode.ai:443" }]);
		const pi = {
			registerCommand: (name: string, command: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => registered.set(name, command),
		};

		usageAdapter(bundled, { inventory })(pi as never);
		expect(bundled).toHaveBeenCalledTimes(1);
		// The bundled factory registered `usage`; the proxy swallowed it, so the
		// adapter's is the only one — never two names Pi would rename to usage:1/2.
		expect([...registered.keys()]).toEqual(["usage"]);

		await registered.get("usage")?.handler("", { cwd: "/w", hasUI: true, ui: { notify } });
		expect(inventory).toHaveBeenCalledWith("/w");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("opencode-go"), "info");
	});

	it("forwards every other registration and delegates /usage details to the captured handler", async () => {
		const registered = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const bundledUsage = vi.fn(async () => {});
		const bundled = (pi: { registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => void; registerFlag: (name: string, flag: unknown) => void }) => {
			pi.registerFlag("usage", { type: "boolean" });
			pi.registerCommand("usage", { handler: bundledUsage });
		};
		const flags = new Map<string, unknown>();
		const pi = {
			registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => registered.set(name, command),
			registerFlag: (name: string, flag: unknown) => flags.set(name, flag),
		};

		usageAdapter(bundled, { inventory: async () => [] })(pi as never);

		// The flag the extension polls is still registered; only `usage` is owned.
		expect(flags.has("usage")).toBe(true);
		await registered.get("usage")?.handler("details", { cwd: "/w", hasUI: true, ui: { notify: vi.fn() } });
		expect(bundledUsage).toHaveBeenCalledTimes(1);
	});
});
