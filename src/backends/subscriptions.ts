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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeviationInput, ExecutorClass } from "../compiler/contract.js";
import type { LeanPiConfig, ModelRole } from "../core/types.js";
import { HARNESS_DESCRIPTORS, isHarnessVendor, type HarnessVendor } from "./harness.js";

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

/** Every configured subscription backend, with what the machine says about it. */
export function detectSubscriptions(
	config: LeanPiConfig,
	options: { env?: NodeJS.ProcessEnv; home?: string } = {},
): SubscriptionState[] {
	const env = options.env ?? process.env;
	const home = options.home ?? env.HOME ?? homedir();
	const states: SubscriptionState[] = [];
	for (const [name, raw] of Object.entries(config.backends)) {
		const entry = raw as { type?: string; vendor?: string; command?: string; enabled?: boolean };
		if (entry.type !== "external_harness" || entry.enabled === false) continue;
		const declared = entry.vendor ?? name;
		if (!isHarnessVendor(declared)) continue;
		const command = entry.command ?? HARNESS_DESCRIPTORS[declared].defaultCommand;
		const found = onPath(command, env);
		const credential = CREDENTIAL_PATHS[declared](home).find((path) => existsSync(path));
		const variable = CREDENTIAL_ENV[declared].find((key) => (env[key] ?? "").length > 0);
		states.push({
			backend: name,
			vendor: declared,
			command,
			onPath: found,
			signedIn: credential !== undefined || variable !== undefined,
			evidence: found
				? (credential ?? (variable ? `$${variable}` : `no credential for ${declared} (looked in ${CREDENTIAL_PATHS[declared](home).join(", ")})`))
				: `${command} is not on PATH`,
		});
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
