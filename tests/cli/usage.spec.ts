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
import { fetchOpenCodeGoUsage, renderUsage, usageAdapter, usageInventory, type UsageRow } from "../../src/cli/usage.js";
import { quotaLines } from "../../src/cli/usage-picker.js";
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
		expect(rows.find((row) => row.name === "opencode-go")).toMatchObject({ state: "reachable", detail: "reachable at opencode.ai:443", vendor: "opencode" });
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

	it("opens the two-pane picker in the TUI instead of printing text", async () => {
		const registered = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const pi = { registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => registered.set(name, command) };
		const rows: UsageRow[] = [{ name: "claude", kind: "configured", state: "authenticated", detail: "signed in", vendor: "claude" }];
		const custom = vi.fn(async () => {});
		const notify = vi.fn();

		usageAdapter(() => {}, { inventory: async () => rows, quota: async () => null })(pi as never);
		await registered.get("usage")?.handler("", { cwd: "/w", mode: "tui", hasUI: true, ui: { notify, custom } });

		expect(custom).toHaveBeenCalledTimes(1);
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("the /usage quota pane", () => {
	const theme = { fg: (_colour: string, text: string) => text } as never;
	const row: UsageRow = { name: "claude", kind: "configured", state: "authenticated", detail: "signed in", vendor: "claude" };

	it("draws a bar per quota window with its percentage and reset", () => {
		const lines = quotaLines(theme, row, { session: 10, weekly: 73, sessionResetsIn: "3h 25m", weeklyResetsIn: "2d 4h" });
		expect(lines).toContainEqual(expect.stringMatching(/^5h\s+█+░+\s+10%  resets in 3h 25m$/));
		expect(lines).toContainEqual(expect.stringMatching(/^Weekly\s+█+░+\s+73%  resets in 2d 4h$/));
	});

	it("says fetching, no source, or the error instead of an empty pane", () => {
		expect(quotaLines(theme, row, undefined)).toContain("fetching quota…");
		expect(quotaLines(theme, row, null)).toContain("no quota API for this provider");
		expect(quotaLines(theme, row, { session: 0, weekly: 0, error: "HTTP 401" })).toContain("quota unavailable: HTTP 401");
	});

	it("reads OpenCode Go's rolling, weekly and monthly windows", async () => {
		const hour = 3_600_000;
		const body = {
			usage: {
				rolling: { status: "ok", percent: 4, resetsAt: new Date(Date.now() + 3 * hour + 90_000).toISOString() },
				weekly: { status: "ok", percent: 11, resetsAt: new Date(Date.now() + 50 * hour + 60_000).toISOString() },
				monthly: { status: "ok", percent: 55, resetsAt: new Date(Date.now() + 10 * 24 * hour + 60_000).toISOString() },
			},
		};
		const fetcher = vi.fn(async () => new Response(JSON.stringify(body)));
		const quota = await fetchOpenCodeGoUsage("k", fetcher as never);

		expect(fetcher).toHaveBeenCalledWith("https://opencode.ai/zen/go/v1/usage", expect.objectContaining({ headers: { Authorization: "Bearer k" } }));
		expect(quota).toMatchObject({ session: 4, weekly: 11, monthly: 55, sessionResetsIn: "3h 1m", weeklyResetsIn: "2d 2h", monthlyResetsIn: "10d 0h" });
		expect(quotaLines(theme, row, quota)).toContainEqual(expect.stringMatching(/^Monthly\s+█+░+\s+55%  resets in 10d 0h$/));
	});

	it("reports the HTTP status when OpenCode Go refuses", async () => {
		const quota = await fetchOpenCodeGoUsage("k", (async () => new Response("", { status: 401 })) as never);
		expect(quota.error).toBe("HTTP 401");
	});
});
