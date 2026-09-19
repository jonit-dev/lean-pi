/**
 * Role → backend resolution (PRD-001, FR-041–FR-045).
 *
 * Routing code calls `resolveRole` and never names a vendor, so a local
 * self-hosted endpoint and a metered API provider are usable in the same
 * session with no reconfiguration.
 */
import type { BackendRef, LeanPiConfig, ModelRole } from "./types.js";
import { resolveRoleViaRanking } from "../capability/index.js";

export class UnresolvedRoleError extends Error {
	constructor(role: ModelRole) {
		super(`No backend configured for role "${role}" and no role is available to fall back to.`);
		this.name = "UnresolvedRoleError";
	}
}

/**
 * The explicit ladder (§27). A role with no configured entry resolves down its
 * own chain, which never crosses the executor/review families except at the
 * shared `quick` floor.
 */
export const ROLE_FALLBACK_CHAINS: Record<ModelRole, ModelRole[]> = {
	quick: ["quick", "balanced", "strong", "specialist"],
	balanced: ["balanced", "quick", "strong", "specialist"],
	strong: ["strong", "balanced", "quick", "specialist"],
	specialist: ["specialist", "balanced", "quick", "strong"],
	review_quick: ["review_quick", "quick"],
	review_strong: ["review_strong", "review_quick", "quick"],
};

/**
 * The nearest configured role in the ladder wins when no ranking is available;
 * with one (PRD-024), the capability index picks the cheapest bound model that
 * clears the role's floor and price ceiling, and an unreadable or invalid
 * ranking falls back to the static `models:` map with the reason reported once.
 */
export function resolveRole(config: LeanPiConfig, role: ModelRole): BackendRef {
	const ranked = resolveRoleViaRanking(config, role);
	if (ranked) return ranked;
	for (const candidate of ROLE_FALLBACK_CHAINS[role]) {
		const entry = config.models[candidate];
		if (!entry) continue;
		const backend = config.backends[entry.backend];
		if (!backend || backend.enabled === false) continue;
		return { backend: entry.backend, model: entry.model, type: backend.type };
	}
	throw new UnresolvedRoleError(role);
}
