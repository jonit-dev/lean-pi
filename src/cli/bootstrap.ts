/**
 * What `leanpi` does before it hands over to Pi.
 *
 * Two questions have to be answered before a session is worth starting, and
 * both have answers the machine already knows:
 *
 * 1. **Which models may this run use?** A user who has logged into Claude Code
 *    or Codex has already told the machine something LeanPi can act on, so a
 *    first run writes a config from what is installed and signed in rather than
 *    failing with "no model roles configured".
 * 2. **Is the control plane there?** LeanPi's whole thesis is that a cheap
 *    semantic layer decides what a task needs (ROADMAP §4). Without a JEV
 *    credential every site falls back to a heuristic, which is a different
 *    product — one this repository has measured and does not silently ship. So
 *    a missing key stops the run and says how to fix it, and `--no-jev` is the
 *    explicit way to ask for the degraded harness anyway.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { detectVendors, type SubscriptionState } from "../backends/subscriptions.js";
import { allocateRoles, candidateKey, detectModels, ladderAllocation, VENDOR_DEFAULT, type Allocation, type ModelCandidate } from "./allocate.js";
import { CONFIG_FILENAME, configPathFor } from "../core/config.js";
import { MODEL_ROLES, type LeanPiConfig, type ModelRole } from "../core/types.js";
import { createJevClient, type JevClient } from "../jev/client.js";
import { describeCredential, resolveCredential, writeStoredKey } from "../jev/credentials.js";

export interface BootstrapEnv {
	cwd: string;
	env: NodeJS.ProcessEnv;
	home: string;
}

function environment(options: Partial<BootstrapEnv> = {}): BootstrapEnv {
	const env = options.env ?? process.env;
	return { cwd: options.cwd ?? process.cwd(), env, home: options.home ?? env.HOME ?? homedir() };
}

/** How the role map was decided, for the config header and the startup line. */
function describeAllocation(allocation: Allocation): string {
	if (allocation.fallbackUsed) return "the cheapest-first fallback ladder (JEV had no confident answer)";
	const undecided = MODEL_ROLES.filter((role) => !allocation.decided.includes(role));
	const source = "JEV, from published capability and price data";
	return undecided.length === 0 ? source : `${source}, ${undecided.join(" and ")} by the cheapest-first fallback`;
}

/** The vendor's own quota reality, the one thing about it that is not detectable. */
const QUOTA_CLASS: Record<string, string> = { claude: "scarce-premium", codex: "premium", opencode: "low-cost" };

export interface AutoConfigResult {
	path: string;
	created: boolean;
	usable: SubscriptionState[];
	/** One line a human can read: what was detected, and what was written. */
	summary: string;
}

function renderConfig(usable: readonly SubscriptionState[], allocation: Allocation, candidates: readonly ModelCandidate[]): string {
	const lines = [
		"# Written by `leanpi` on first run, from what this machine has installed and",
		"# signed in. It is an ordinary config file: edit it, or delete it to have it",
		"# written again. Credentials are never stored here — the vendor CLIs carry",
		"# their own logins, and LeanPi's JEV key comes from the environment, the",
		"# project's .env, or its own credential store.",
		"",
		"backends:",
	];
	for (const state of usable) {
		lines.push(`  ${state.vendor}:`);
		lines.push(`    type: external_harness`);
		lines.push(`    vendor: ${state.vendor}`);
		lines.push(`    quota_class: ${QUOTA_CLASS[state.vendor] ?? "premium"}`);
	}
	lines.push(
		"",
		`# Roles allocated by ${describeAllocation(allocation)},`,
		`# over the models these CLIs report: ${candidates.map((candidate) => candidateKey(candidate)).join(", ")}.`,
		`# \`${VENDOR_DEFAULT}\` means LeanPi passes no model flag and the vendor CLI's own`,
		"# configured model runs.",
		"models:",
	);
	for (const [role, candidate] of Object.entries(allocation.roles)) {
		lines.push(`  ${role}:`);
		lines.push(`    backend: ${candidate.vendor}`);
		lines.push(`    model: ${candidate.model}`);
	}
	lines.push("", "jev:", "  mode: enabled", "");
	return lines.join("\n");
}

/**
 * Write a config from the machine's own subscriptions when there is none to
 * find. Never overwrites: a config that exists — project or user — is the
 * user's, and this returns it untouched.
 */
export async function autoConfigure(
	options: Partial<BootstrapEnv> & { client?: Parameters<typeof allocateRoles>[0] } = {},
): Promise<AutoConfigResult> {
	const { cwd, env, home } = environment(options);
	const path = configPathFor(cwd, env);
	if (existsSync(path)) {
		return { path, created: false, usable: [], summary: `configuration: ${path}` };
	}
	// `verify: true`: a first run may spend a second asking three CLIs whether
	// they are actually logged in, rather than writing a config against a vendor
	// that only *looks* signed in from its credential file.
	const usable = detectVendors({ env, home, verify: true }).filter((state) => state.onPath && state.signedIn);
	if (usable.length === 0) {
		return {
			path,
			created: false,
			usable,
			summary: [
				`no ${CONFIG_FILENAME} found, and no vendor CLI on this machine is both installed and signed in.`,
				`Write ${join(home, ".config", "leanpi", CONFIG_FILENAME)} with a backend and a model role, or log into one of: claude, codex, opencode.`,
			].join(" "),
		};
	}
	// The models come from the vendors, not from a table in this repository: a
	// hardcoded model id is stale the week after it is written, and on two of the
	// three vendors LeanPi does not even pass one.
	const candidates = usable.flatMap((state) => detectModels(state.vendor, { env, home }));
	const allocation =
		options.client === undefined
			? { roles: ladderAllocation(candidates), fallbackUsed: true, decided: [] }
			: await allocateRoles(options.client, candidates);
	const target = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "leanpi", CONFIG_FILENAME);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, renderConfig(usable, allocation, candidates), { mode: 0o600 });
	return {
		path: target,
		created: true,
		usable,
		// One line, and the banner prints the resulting map immediately after, so
		// this says where the file is and who decided — not the map twice.
		summary: `no ${CONFIG_FILENAME} found — wrote ${target}; detected ${usable.map((state) => state.vendor).join(", ")}; roles by ${describeAllocation(allocation)}`,
	};
}

export class MissingJevKeyError extends Error {
	constructor(readonly detail: string) {
		super(detail);
		this.name = "MissingJevKeyError";
	}
}

export interface JevCheck {
	/** How the key was found, for the startup line. */
	source: string;
	stored?: string;
}

/**
 * Refuse to start without the control plane, unless asked to.
 *
 * A LeanPi with no JEV key still runs — every site has a deterministic fallback
 * — but it is not the product the numbers describe: the classification, the
 * disclosure ranking and the proof sufficiency are all heuristics then. Starting
 * it silently is how a harness ends up measured for months with its control
 * plane switched off, which is exactly what happened in this repository.
 */
export function requireJev(options: Partial<BootstrapEnv> & { allowMissing?: boolean; setKey?: string } = {}): JevCheck {
	const { cwd, env, home } = environment(options);
	if (options.setKey !== undefined && options.setKey.length > 0) {
		const path = writeStoredKey(options.setKey, { ...env, HOME: home });
		return { source: "credential store", stored: path };
	}
	// `jev.apiKey` in config, the credential store, `$JEV_API_KEY`, the project's
	// `.env` — the same order the client resolves, so the check cannot disagree
	// with the session it is about to start.
	const credential = resolveCredential(bootstrapConfig(), { ...env, HOME: home }, cwd);
	if (credential.key !== null) return { source: describeCredential(credential) };
	if (options.allowMissing === true) return { source: "not configured (--no-jev)" };
	throw new MissingJevKeyError(
		[
			"LeanPi needs a JEV key: its task compiler, skill disclosure and proof gate are JEV decisions,",
			"and without one every site falls back to a heuristic — a different harness than the measured one.",
			"",
			"Configure it in any of these ways:",
			`  leanpi --jev-key <key>      store it for this machine (${join(home, ".config", "leanpi", "credentials.json")}, mode 0600)`,
			"  export JEV_API_KEY=<key>    for this shell",
			"  echo 'JEV_API_KEY=<key>' >> .env    for this project (read, never exported)",
			"",
			"Or run the degraded harness deliberately:",
			"  leanpi --no-jev",
		].join("\n"),
	);
}

/**
 * The config the bootstrap itself runs on, before a real one exists. Only the
 * `jev` block is read — by `resolveCredential` and by the client — so this is
 * the whole of it, not a stub standing in for a loaded file.
 */
function bootstrapConfig(): Parameters<typeof createJevClient>[0]["config"] {
	return { jev: { mode: "enabled", apiKey: null } } as Parameters<typeof createJevClient>[0]["config"];
}

/** A JEV client for the one decision made before a session exists: the role map. */
export function jevClientFor(options: Partial<BootstrapEnv> = {}): JevClient {
	const { cwd, env, home } = environment(options);
	return createJevClient({ config: bootstrapConfig(), cwd, env: { ...env, HOME: home } });
}

/**
 * What the user sees when the harness starts: the mantra, then the three facts
 * that decide what the next turn costs — who executes, who reviews, and whether
 * the control plane is live. One screen line each, on stderr, so a piped
 * `--print` run still yields clean stdout.
 */
export function startupBanner(config: LeanPiConfig, jev: JevCheck): string {
	const label = (role: ModelRole): string => {
		const entry = config.models[role];
		if (entry === undefined) return "—";
		return entry.model === VENDOR_DEFAULT ? entry.backend : `${entry.backend} ${entry.model}`;
	};
	const roles = [`quick ${label("quick")}`, `balanced ${label("balanced")}`, `strong ${label("strong")}`];
	return [
		"leanpi — tell me your goal, I figure out the rest.",
		`  models   ${roles.join("  ·  ")}`,
		`  review   ${label("review_quick")} → ${label("review_strong")}`,
		`  control  JEV ${jev.source}`,
	].join("\n");
}
