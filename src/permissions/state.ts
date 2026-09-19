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
import type { PermissionEnv, ProjectTrustStatus, ResolvedPermissions, TrustedProjectSubset } from "./trust.js";

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
		if (state) {
			state.config = config;
			state.permissions = config.permissions;
			state.trust = trust;
			state.project = trust.subset;
			return state;
		}
		state = {
			cwd,
			env,
			config,
			permissions: config.permissions,
			trust,
			project: trust.subset,
			refresh,
		};
		return state;
	};
	return refresh();
}
