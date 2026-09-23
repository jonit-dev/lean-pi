/**
 * Session-scoped route pins (PRD-016 Phase 3, ROADMAP §45).
 *
 * `/route executor <class>`, `/route reviewer <class>`, `/route prd force|skip`
 * and `/model <backend>:<model>` write here; the compiler reads here when it
 * builds the next contract. A pin is the *decided* value from that point on, and
 * telemetry row it replaces is marked `fallback_used` so `/route` and the
 * record agree that JEV did not make the call.
 *
 * Pins are session state, never config writes, so a forced route cannot
 * silently outlive the session that asked for it: `/new`, `/resume` and
 * `/route reset` clear them.
 */
import type { ExecutorClass, PlanningDecision, ReviewerClass } from "./contract.js";
import type { RoutingDefault } from "./route.js";
import type { BackendRef } from "../core/types.js";

export interface RoutePins {
	executor_class?: ExecutorClass;
	reviewer_class?: ReviewerClass;
	/** The gate outcome, not the classifier's confidence. */
	prd_required?: boolean;
	/**
	 * `/model`'s manual pick (PRD-048): the exact backend/model the operator
	 * chose, in place of the router's per-turn pick. Present means Manual and the
	 * turn is dispatched on it; absent means Auto and the router decides.
	 */
	model?: BackendRef;
}

let pins: RoutePins = {};
let owner: string | undefined;

/** Merge a pin into the session's set; `sessionId` records which session asked. */
export function setRoutePins(next: RoutePins, sessionId?: string): RoutePins {
	if (sessionId !== undefined && owner !== undefined && owner !== sessionId) {
		// A new session never inherits the previous one's forced route.
		pins = {};
	}
	if (sessionId !== undefined) owner = sessionId;
	pins = { ...pins, ...next };
	return pins;
}

/** The pins the compiler reads for the next contract. */
export function routePins(): RoutePins {
	return pins;
}

export function pinOwner(): string | undefined {
	return owner;
}

export function clearRoutePins(): void {
	pins = {};
	owner = undefined;
}

/** `prd force`/`prd skip` pin the gate outcome; without one the classifier decides. */
export function pinnedDecision(decision: PlanningDecision, current: RoutePins = pins): PlanningDecision {
	if (current.prd_required === undefined) return decision;
	return current.prd_required ? "PRD_REQUIRED" : "DIRECT_EXECUTION";
}

/** A pinned class replaces the matrix default; the deviation record is untouched. */
export function applyRoutePins(defaults: RoutingDefault, current: RoutePins = pins): RoutingDefault {
	return {
		executor_class: current.executor_class ?? defaults.executor_class,
		reviewer_class: current.reviewer_class ?? defaults.reviewer_class,
	};
}
