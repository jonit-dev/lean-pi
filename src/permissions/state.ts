/**
 * The live permission state handed to the guard and to `/permissions`
 * (PRD-017).
 *
 * `loadConfig` already ran `assertTrusted` and the asymmetric merge, so this
 * module holds no policy of its own: it keeps one mutable state object so a
 * `/permissions set` mid-session is visible to the guard on the next tool call
 * without re-hashing the project surface on every dispatch.
 */
import { loadConfig } from "../core/config.js";
import type { LeanPiConfig } from "../core/types.js";
import { SAFETY_PROFILES, SCOPES, isSafetyLevel, type DecisionSource, type Scope } from "./rules.js";
import type { PermissionEnv, ProjectTrustStatus, ResolvedPermissions, TrustedProjectSubset } from "./trust.js";

/**
 * `LEANPI_SAFETY`, set by the launcher's `--safety <level>`.
 *
 * Unset — the default — changes nothing: the resolved configuration decides, as
 * it always did. Set, it replaces the whole resolved policy, rules included, so
 * the level is what the guard enforces and what `/permissions` reports.
 */
function applySafetyLevel(permissions: ResolvedPermissions, env: PermissionEnv): ResolvedPermissions {
	const level = env.LEANPI_SAFETY;
	if (level === undefined || !isSafetyLevel(level)) return permissions;
	return {
		...permissions,
		defaults: { ...SAFETY_PROFILES[level] },
		defaultSources: Object.fromEntries(SCOPES.map((scope) => [scope, "safety" as DecisionSource])) as Record<Scope, DecisionSource>,
		rules: [],
	};
}

export interface PermissionState {
	cwd: string;
	env: PermissionEnv;
	config: LeanPiConfig;
	permissions: ResolvedPermissions;
	trust: ProjectTrustStatus;
	/** The trusted subset of project configuration; empty until the project is trusted. */
	project: TrustedProjectSubset;
	/** Re-read config, trust and permissions in place; the same object is mutated. */
	refresh(): PermissionState;
}

export function loadPermissionState(cwd: string, env: PermissionEnv = process.env, overrides: Partial<LeanPiConfig> = {}): PermissionState {
	let state: PermissionState;
	const refresh = (): PermissionState => {
		const config = loadConfig(cwd, overrides, env);
		const trust = config.permissions.trust;
		const permissions = applySafetyLevel(config.permissions, env);
		if (state) {
			state.config = config;
			state.permissions = permissions;
			state.trust = trust;
			state.project = trust.subset;
			return state;
		}
		state = {
			cwd,
			env,
			config,
			permissions,
			trust,
			project: trust.subset,
			refresh,
		};
		return state;
	};
	return refresh();
}
