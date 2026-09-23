/**
 * `/usage` on the machine LeanPi actually runs on.
 *
 * The bundled `@hk_net/pi-usage-bars` command resolves providers through Pi's
 * own model registry against a fixed vendor list. LeanPi writes Codex and Claude
 * as external harnesses it spawns itself, and registers OpenCode under the
 * operator's own provider name, so none of them match that list and the selector
 * opens on "No matching configured providers" — a command that renders nothing.
 *
 * This module backs a launcher-attached adapter (`extensions/usage/index.ts`)
 * that runs the same factory for its polling, flag and status bar, but owns the
 * single `usage` registration so `/usage` answers from LeanPi's inventory: one
 * row per configured backend and per vendor this machine has a login for.
 * `/usage details` delegates to the bundled selector for the full quota view.
 *
 * What it deliberately does not do: fetch quota itself (the bundled extension's
 * polls and `:update` events stay the one source), or print a credential value.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_VENDORS, type HarnessVendor } from "../backends/harness.js";
import { BackendRegistry, type RegisteredBackend } from "../backends/registry.js";
import { probeVendor, type SubscriptionState } from "../backends/subscriptions.js";
import { LOGIN_ARGS, probeBackend, type ProbeResult } from "../commands/surface.js";
import type { LeanPiConfig } from "../core/types.js";
import { usagePicker } from "./usage-picker.js";

export interface UsageRow {
	/** Backend name, or the vendor name for a detected-but-unconfigured login. */
	name: string;
	/** `configured` for a `backends:` entry, `detected` for a machine login. */
	kind: "configured" | "detected";
	/** A one-word verdict; never `ok`, which reads as a quota claim it cannot make. */
	state: string;
	/** What was checked, for the reader who has to act on it. */
	detail: string;
	/** The subscription behind the row, when there is one to ask for quota. */
	vendor?: HarnessVendor;
}

/** The quota fields `/usage` draws, a subset of the bundled extension's `UsageData`. */
export interface Quota {
	session: number;
	weekly: number;
	sessionHidden?: boolean;
	weeklyHidden?: boolean;
	sessionLabel?: string;
	weeklyLabel?: string;
	sessionResetsIn?: string;
	weeklyResetsIn?: string;
	/** OpenCode Go's third window; the bundled providers have none. */
	monthly?: number;
	monthlyResetsIn?: string;
	warning?: string;
	error?: string;
}

/**
 * The OAuth access token a harness CLI keeps for itself, or `undefined`.
 * Read only to ask the vendor's own usage endpoint; never printed.
 */
export function harnessToken(vendor: HarnessVendor, home: string | undefined): string | undefined {
	if (home === undefined) return undefined;
	try {
		if (vendor === "claude") return JSON.parse(readFileSync(join(home, ".claude", ".credentials.json"), "utf8"))?.claudeAiOauth?.accessToken;
		if (vendor === "codex") return JSON.parse(readFileSync(join(home, ".codex", "auth.json"), "utf8"))?.tokens?.access_token;
		if (vendor === "opencode") return JSON.parse(readFileSync(join(home, ".local", "share", "opencode", "auth.json"), "utf8"))?.["opencode-go"]?.key;
	} catch {
		// No file or no login: the row says so; the quota pane has nothing to add.
	}
	return undefined;
}

export interface UsageInventoryOptions {
	env?: NodeJS.ProcessEnv;
	home?: string;
	/** Ask each vendor's own status command; off makes the inventory cheap. */
	verify?: boolean;
	/** Native reachability probe; injected in tests. */
	probe?: (backend: RegisteredBackend) => Promise<ProbeResult>;
	/** Vendor login probe; injected in tests. */
	vendor?: (vendor: HarnessVendor, options: { backend?: string; command?: string; env: NodeJS.ProcessEnv; home?: string; verify?: boolean }) => SubscriptionState;
}

/** A configured harness, said the way its own probe said it. */
function subscriptionRow(name: string, state: SubscriptionState): UsageRow {
	const vendor = state.vendor;
	if (!state.onPath) return { name, kind: "configured", state: "unavailable", detail: state.evidence, vendor };
	if (state.signedIn) return { name, kind: "configured", state: "authenticated", detail: state.evidence, vendor };
	// A missing login is the one state with a fix the user can type.
	return { name, kind: "configured", state: "reauth-required", detail: `${state.evidence} — run \`${state.command} ${LOGIN_ARGS[state.vendor]}\``, vendor };
}

/**
 * One row per configured backend plus one per detected login that no configured
 * backend already names. `no providers` is only true when both sets are empty.
 */
export async function usageInventory(config: LeanPiConfig, options: UsageInventoryOptions = {}): Promise<UsageRow[]> {
	const env = options.env ?? process.env;
	const home = options.home ?? env.HOME;
	const verify = options.verify ?? true;
	const vendor = options.vendor ?? probeVendor;
	const probe = options.probe ?? ((backend: RegisteredBackend) => probeBackend(backend, { env }));

	const rows: UsageRow[] = [];
	const configuredVendors = new Set<HarnessVendor>();
	for (const backend of new BackendRegistry(config).backends) {
		if (backend.type === "external_harness" && backend.vendor) {
			configuredVendors.add(backend.vendor);
			rows.push(subscriptionRow(backend.name, vendor(backend.vendor, { backend: backend.name, command: backend.command, env, ...(home === undefined ? {} : { home }), verify })));
			continue;
		}
		const result = await probe(backend);
		rows.push({
			name: backend.name,
			kind: "configured",
			// TCP reachability is not authentication, and `ok` would claim it is.
			state: result.status === "ok" ? "reachable" : result.status === "degraded" ? "degraded" : "unreachable",
			detail: result.reason,
			// Only OpenCode Go's endpoint reports quota; Zen and other hosts do not.
			...(backend.baseUrl?.includes("opencode.ai/zen/go") ? { vendor: "opencode" as const } : {}),
		});
	}

	// A vendor the machine is logged into but the config does not name is the
	// fact a first run acts on; one the config already names is its row above.
	for (const name of HARNESS_VENDORS) {
		if (configuredVendors.has(name)) continue;
		const state = vendor(name, { env, ...(home === undefined ? {} : { home }), verify });
		if (!state.onPath && !state.signedIn) continue;
		rows.push({ name, kind: "detected", state: "detected (not configured)", detail: state.evidence, vendor: name });
	}
	return rows;
}

/** OpenCode Go's `/usage`: rolling 5-hour, weekly and monthly windows, each a percent. */
export async function fetchOpenCodeGoUsage(token: string, fetcher: typeof fetch = fetch): Promise<Quota> {
	try {
		const response = await fetcher("https://opencode.ai/zen/go/v1/usage", { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12_000) });
		if (!response.ok) return { session: 0, weekly: 0, error: `HTTP ${response.status}` };
		const usage = ((await response.json()) as { usage?: Record<string, { percent?: number; resetsAt?: string } | undefined> }).usage ?? {};
		const resets = (at: string | undefined) => {
			const ms = at === undefined ? Number.NaN : Date.parse(at) - Date.now();
			if (!(ms > 0)) return undefined;
			const hours = Math.floor(ms / 3_600_000);
			return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
		};
		return {
			session: usage.rolling?.percent ?? 0,
			weekly: usage.weekly?.percent ?? 0,
			...(usage.rolling ? {} : { sessionHidden: true }),
			...(usage.weekly ? {} : { weeklyHidden: true }),
			sessionResetsIn: resets(usage.rolling?.resetsAt),
			weeklyResetsIn: resets(usage.weekly?.resetsAt),
			...(usage.monthly ? { monthly: usage.monthly.percent ?? 0, monthlyResetsIn: resets(usage.monthly.resetsAt) } : {}),
		};
	} catch (error) {
		return { session: 0, weekly: 0, error: error instanceof Error ? error.message : String(error) };
	}
}

export function renderUsage(rows: readonly UsageRow[]): string {
	if (rows.length === 0) {
		return "usage: no backends configured and no vendor login detected — add a backend to leanpi.config.yaml, or sign in to a supported CLI";
	}
	const width = Math.max(...rows.map((row) => row.name.length));
	return [
		"usage:",
		...rows.map((row) => `${row.name.padEnd(width)}  ${row.kind.padEnd(10)} ${row.state.padEnd(18)} ${row.detail}`),
		"details: /usage details opens the full quota and balance selector",
	].join("\n");
}

/** Pi's extension API, only the members this adapter touches. */
interface UsagePi {
	registerCommand(name: string, command: { description?: string; handler: (args: string, ctx: UsageContext) => Promise<void> | void }): void;
	[key: string]: unknown;
}

interface UsageContext {
	cwd: string;
	mode?: string;
	hasUI?: boolean;
	ui: { notify: (message: string, level: "info") => void; custom?: (factory: ReturnType<typeof usagePicker>) => Promise<void> };
}

export interface UsageAdapterOptions {
	/** LeanPi's inventory for a working directory; the extension supplies the real one. */
	inventory: (cwd: string) => Promise<UsageRow[]>;
	/** One row's quota, or `null` when it has no quota source; the extension supplies the fetchers. */
	quota?: (row: UsageRow) => Promise<Quota | null>;
}

/**
 * The single-owner wrapper around the bundled factory.
 *
 * Pi has no `unregisterCommand`, and two extensions registering `usage` are both
 * renamed to `usage:1`/`usage:2`, so `/usage` resolves to neither. The only
 * supported seam is to run the bundled factory against a `Proxy` that captures
 * its `registerCommand("usage")` and drops it, then register LeanPi's own. Every
 * other call — the `usage` flag, `session_start` polling, `:update` events —
 * forwards untouched.
 */
export function usageAdapter(bundled: (pi: UsagePi) => void, options: UsageAdapterOptions): (pi: UsagePi) => void {
	return (pi: UsagePi) => {
		let details: ((args: string, ctx: UsageContext) => Promise<void> | void) | undefined;
		const proxy = new Proxy(pi, {
			get(target, property) {
				if (property === "registerCommand") {
					return (name: string, command: { handler: (args: string, ctx: UsageContext) => Promise<void> | void }) => {
						if (name === "usage") {
							details = command.handler;
							return;
						}
						target.registerCommand(name, command);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		bundled(proxy);
		pi.registerCommand("usage", {
			description: "Show LeanPi's configured backends and detected subscriptions",
			handler: async (args: string, ctx: UsageContext) => {
				// The only argument is `details`; anything else renders the inventory
				// rather than an error, because a bare `/usage` is the common case.
				if (args.trim().split(/\s+/)[0] === "details" && details) {
					await details("", ctx);
					return;
				}
				const rows = await options.inventory(ctx.cwd);
				if (ctx.mode === "tui" && ctx.ui.custom && rows.length > 0) {
					await ctx.ui.custom(usagePicker(rows, options.quota ?? (async () => null)));
					return;
				}
				const text = renderUsage(rows);
				if (ctx.hasUI === false) {
					console.log(text);
					return;
				}
				ctx.ui.notify(text, "info");
			},
		});
	};
}
