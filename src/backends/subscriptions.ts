/**
 * Subscription detection (PRD-008 §25, PRD-004 §14's `subscription_availability`).
 *
 * A subscription backend is a vendor CLI the *user* is logged into: LeanPi spawns
 * it and never handles its credential (FR-054), which is why it can spend a plan
 * the harness never pays for. The cost of that arrangement is that LeanPi cannot
 * tell whether the plan is there — and a route to a vendor that is missing or
 * signed out is a failed turn discovered the expensive way, after the executor
 * has already spent an attempt on it.
 *
 * This is the cheap half of the answer: does the CLI exist on PATH, and has the
 * vendor left a credential artifact where it documents one. Both are file
 * questions, so the check costs microseconds and runs on the turn that routes.
 * It is deliberately *not* a login probe: spawning three CLIs per turn to ask
 * would cost more than the routing decision saves.
 *
 * What it cannot see is how much of the plan is left. Nothing in a vendor CLI
 * reports remaining quota offline, so quota is still learned the way PRD-008
 * learns it: a limit signal on an attempt cools that backend down
 * (`BackendRegistry.markLimited`).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeviationInput, ExecutorClass } from "../compiler/contract.js";
import type { LeanPiConfig, ModelRole } from "../core/types.js";
import { HARNESS_DESCRIPTORS, HARNESS_VENDORS, isHarnessVendor, type HarnessVendor } from "./harness.js";

/** Where each vendor documents the credential its login writes. */
const CREDENTIAL_PATHS: Record<HarnessVendor, (home: string) => readonly string[]> = {
	claude: (home) => [join(home, ".claude", ".credentials.json"), join(home, ".claude.json")],
	codex: (home) => [join(home, ".codex", "auth.json")],
	opencode: (home) => [join(home, ".local", "share", "opencode", "auth.json"), join(home, ".config", "opencode", "auth.json")],
};

/** The environment variable that stands in for a login, when the vendor reads one. */
const CREDENTIAL_ENV: Record<HarnessVendor, readonly string[]> = {
	claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
	codex: ["OPENAI_API_KEY"],
	opencode: ["OPENCODE_API_KEY"],
};

export interface SubscriptionState {
	/** The `backends:` entry this describes. */
	backend: string;
	vendor: HarnessVendor;
	/** The command the config names (or the vendor's default), found on PATH. */
	command: string;
	onPath: boolean;
	/** A credential artifact or environment variable the vendor documents. */
	signedIn: boolean;
	/** What was checked, for `/status` and for the deviation's reason. */
	evidence: string;
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
	if (command.includes("/")) return existsSync(command);
	const path = env.PATH ?? "";
	return path.split(":").some((dir) => dir.length > 0 && existsSync(join(dir, command)));
}

/** One vendor, as this machine has it: installed, and logged into. */
/**
 * The vendor's own answer to "am I logged in", when it has one.
 *
 * A credential file on disk is a guess: it can be stale, it can belong to an
 * account that was logged out elsewhere, and on Claude it exists even when the
 * CLI reports `Not logged in`. Every vendor here ships a status command that
 * costs no tokens, so the first run asks instead of assuming.
 */
const STATUS_COMMAND: Record<HarnessVendor, readonly string[]> = {
	claude: ["auth", "status"],
	codex: ["login", "status"],
	opencode: ["auth", "list"],
};

/** `true`/`false` from the vendor, or `null` when it could not be asked. */
function askVendor(command: string, vendor: HarnessVendor, env: NodeJS.ProcessEnv, run: StatusRunner): boolean | null {
	try {
		const output = run(command, STATUS_COMMAND[vendor], env);
		if (vendor === "claude") return /"loggedIn"\s*:\s*true/.test(output);
		if (vendor === "codex") return /logged in/i.test(output);
		// `opencode auth list` prints the credential store's entries; an empty
		// store still exits 0, so the count is the answer.
		return /\d+ credential/i.test(output) && !/\b0 credentials\b/i.test(output);
	} catch {
		return null;
	}
}

export type StatusRunner = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => string;

const runStatus: StatusRunner = (command, args, env) => {
	// Both streams: `codex login status` prints "Logged in using ChatGPT" on
	// stderr, so a stdout-only capture reads a signed-in machine as signed out.
	// `NO_COLOR` is dropped rather than added — Node warns on stderr when it and
	// `FORCE_COLOR` disagree, and that warning is the user's first impression.
	const { NO_COLOR: _dropped, ...rest } = env;
	const result = spawnSync(command, [...args], { encoding: "utf8", timeout: 15_000, env: { ...rest, FORCE_COLOR: "0" } });
	if (result.error) throw result.error;
	return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
};

export function probeVendor(
	vendor: HarnessVendor,
	options: { backend?: string; command?: string; env?: NodeJS.ProcessEnv; home?: string; verify?: boolean; run?: StatusRunner } = {},
): SubscriptionState {
	const env = options.env ?? process.env;
	const home = options.home ?? env.HOME ?? homedir();
	const command = options.command ?? HARNESS_DESCRIPTORS[vendor].defaultCommand;
	const found = onPath(command, env);
	const credential = CREDENTIAL_PATHS[vendor](home).find((path) => existsSync(path));
	const variable = CREDENTIAL_ENV[vendor].find((key) => (env[key] ?? "").length > 0);
	const asked = found && options.verify === true ? askVendor(command, vendor, env, options.run ?? runStatus) : null;
	return {
		backend: options.backend ?? vendor,
		vendor,
		command,
		onPath: found,
		// The vendor's own answer wins; the file check is what is left when there
		// is no answer to be had.
		signedIn: asked ?? (credential !== undefined || variable !== undefined),
		evidence: !found
			? `${command} is not on PATH`
			: asked !== null
				? `${command} ${STATUS_COMMAND[vendor].join(" ")}: ${asked ? "signed in" : "not signed in"}`
				: (credential ?? (variable ? `$${variable}` : `no credential for ${vendor} (looked in ${CREDENTIAL_PATHS[vendor](home).join(", ")})`)),
	};
}

/**
 * Every vendor this machine could run, config or no config. This is what the
 * first run reads: a user who has already logged into Claude Code or Codex has
 * told the machine something LeanPi can act on without asking them again.
 */
export function detectVendors(options: { env?: NodeJS.ProcessEnv; home?: string; verify?: boolean; run?: StatusRunner } = {}): SubscriptionState[] {
	return HARNESS_VENDORS.map((vendor) => probeVendor(vendor, options));
}

/** Every configured subscription backend, with what the machine says about it. */
export function detectSubscriptions(
	config: LeanPiConfig,
	options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): SubscriptionState[] {
	const states: SubscriptionState[] = [];
	for (const [name, raw] of Object.entries(config.backends)) {
		const entry = raw as { type?: string; vendor?: string; command?: string; enabled?: boolean };
		if (entry.type !== "external_harness" || entry.enabled === false) continue;
		const declared = entry.vendor ?? name;
		if (!isHarnessVendor(declared)) continue;
		states.push(probeVendor(declared, { backend: name, ...(entry.command ? { command: entry.command } : {}), ...options }));
	}
	return states;
}

const EXECUTOR_CLASSES: readonly ExecutorClass[] = ["quick", "balanced", "strong", "specialist"];

/**
 * §14's `subscription_availability` inputs: one per executor class whose backend
 * is a subscription this machine cannot use. `applyDeviations` moves the class
 * away from them, so a task is routed to a model that can actually run rather
 * than discovering the missing login after an attempt is spent.
 */
export function subscriptionDeviations(config: LeanPiConfig, states: readonly SubscriptionState[]): DeviationInput[] {
	const unusable = new Map(states.filter((state) => !state.onPath || !state.signedIn).map((state) => [state.backend, state]));
	if (unusable.size === 0) return [];
	const inputs: DeviationInput[] = [];
	for (const executorClass of EXECUTOR_CLASSES) {
		const binding = config.models[executorClass as ModelRole];
		const state = binding ? unusable.get(binding.backend) : undefined;
		if (!state) continue;
		inputs.push({
			kind: "subscription_availability",
			executor_class: executorClass,
			available: false,
			reason: `${executorClass} runs on ${state.backend} (${state.vendor}) and this machine cannot use it: ${state.evidence}`,
		});
	}
	return inputs;
}
