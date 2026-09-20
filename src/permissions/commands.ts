/**
 * `/permissions` — inspect and control the rule list (PRD-017, FR-147).
 *
 * Bare `/permissions` prints every scope with its effective decision and the
 * config source it came from, plus the project's trust state and any project
 * self-grant that was ignored. `/permissions set` writes to user scope, because
 * project scope may only tighten. `/permissions trust project` grants the
 * project trust for the current surface hash.
 *
 * Registration goes through `src/commands/registry.ts`, so the surface is
 * reachable without waiting on PRD-016.
 */
import { resolve as resolvePath } from "node:path";
import type { CommandHandler, CommandRegistry, CommandResult } from "../commands/registry.js";
import { SCOPES, isPermissionDecision, isSafetyLevel, isScope, parseCapability, type DecisionSource } from "./rules.js";
import { loadPermissionState, type PermissionState } from "./state.js";
import { grantTrust, writeUserDefault, writeUserRule, type PermissionEnv } from "./trust.js";

const SOURCE_LABEL: Record<DecisionSource, string> = {
	builtin: "builtin default",
	user: "user scope",
	project: "project scope",
	safety: "--safety",
};

export interface PermissionsCommandDeps {
	cwd: string;
	env?: PermissionEnv;
	/** Live state shared with the guard; a fresh one is loaded from `cwd` when absent. */
	state?: PermissionState;
	/** Called after a mutation so a host can re-render its own view. */
	onChange?: () => void;
}

/** Every scope with its effective decision and origin, the trust state and ignored grants. */
export function renderPermissions(state: PermissionState): string {
	const lines: string[] = [];
	const { trust } = state;
	lines.push(`LeanPi permissions — project ${trust.root}: ${trust.status} (${trust.reason})`);
	if (trust.changedFile) lines.push(`changed file: ${trust.changedFile}`);
	lines.push(`config: ${state.config.configPath ?? "(built-in defaults, no leanpi.config.yaml)"}`);
	// The level replaced every other source, so the view has to say which one, or
	// the reader is left to explain nine `--safety` rows from a config that says
	// something else.
	const level = state.env.LEANPI_SAFETY;
	if (level !== undefined && isSafetyLevel(level)) lines.push(`safety: ${level} (--safety) — user and project permissions are ignored this session`);
	for (const scope of SCOPES) {
		const decision = state.permissions.defaults[scope];
		const source = SOURCE_LABEL[state.permissions.defaultSources[scope]];
		lines.push(`  ${scope.padEnd(16)}${decision.padEnd(7)}(${source})`);
	}
	if (state.permissions.rules.length > 0) {
		lines.push("rules:");
		for (const rule of state.permissions.rules) lines.push(`  ${rule.capability} -> ${rule.decision} (${SOURCE_LABEL[rule.source]})`);
	}
	if (state.permissions.ignoredProjectGrants.length > 0) {
		lines.push("ignored project grants:");
		for (const ignored of state.permissions.ignoredProjectGrants) {
			lines.push(`  ${ignored.capability} -> ${ignored.decision} (${ignored.reason})`);
		}
	}
	return lines.join("\n");
}

function setDecision(state: PermissionState, capability: string, decision: string): CommandResult {
	if (!isPermissionDecision(decision)) return { ok: false, text: `usage: /permissions set <capability> <allow|ask|deny>` };
	const env = state.env;
	// A level in force outranks the file this writes, so the write still happens
	// — it is user scope, for every session without the flag — and the answer
	// says it changes nothing here rather than implying the guard just moved.
	const level = env.LEANPI_SAFETY;
	const inert = level !== undefined && isSafetyLevel(level) ? ` — inert while \`--safety ${level}\` is active; applies to sessions started without the flag` : "";
	if (isScope(capability)) {
		writeUserDefault(capability, decision, env);
		return { ok: true, text: `${capability}: ${decision} (user scope default)${inert}` };
	}
	if (!parseCapability(capability)) {
		return { ok: false, text: `unknown scope "${capability}" — expected a scope name or "<scope>:<target>"` };
	}
	writeUserRule(capability, decision, env);
	return { ok: true, text: `${capability}: ${decision} (user scope rule)${inert}` };
}

export function registerPermissionsCommand(registry: CommandRegistry, deps: PermissionsCommandDeps): void {
	const state = deps.state ?? loadPermissionState(deps.cwd, deps.env);

	const handler: CommandHandler = async (args): Promise<CommandResult> => {
		const [subcommand, ...rest] = args.split(/\s+/).filter(Boolean);

		switch (subcommand) {
			case undefined:
				return { ok: true, text: renderPermissions(state) };

			case "set": {
				// `<capability> <decision>`: the decision is the last token, so a capability
				// carrying spaces (`shell:git push --force`) needs no quoting.
				const decision = rest.at(-1);
				const capability = rest.slice(0, -1).join(" ");
				if (!capability || !decision) return { ok: false, text: "usage: /permissions set <capability> <allow|ask|deny>" };
				const result = setDecision(state, capability, decision);
				state.refresh();
				deps.onChange?.();
				return result;
			}

			case "trust": {
				// `/permissions trust`, `/permissions trust project`, `/permissions trust <path>`.
				const requested = rest[0];
				if (rest.length > 1) return { ok: false, text: "usage: /permissions trust [project|<path>]" };
				const target = requested === undefined || requested === "project" ? state.cwd : resolvePath(state.cwd, requested);
				const granted =
					target === state.cwd
						? grantTrust(state.cwd, state.env, { skillRoots: state.trust.surface.skillRoots, mcpConfigPaths: state.trust.surface.mcpConfigPaths })
						: grantTrust(target, state.env);
				state.refresh();
				deps.onChange?.();
				return {
					ok: true,
					text: `project ${granted.root}: ${granted.status} (${granted.reason}) — surface ${granted.surfaceHash.slice(0, 12)}`,
				};
			}

			default:
				return { ok: false, text: `unknown /permissions subcommand: ${subcommand}` };
		}
	};

	// A session created later in the same process supersedes the earlier handler
	// while `register()` still rejects a genuinely accidental duplicate name.
	if (registry.has("permissions")) registry.unregister("permissions");
	registry.register("permissions", handler);
}
