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
	/**
	 * The native model Pi was running just before a `/model` pin took over
	 * (PRD-048 Phase 2), so `/model auto` can put Pi back on it instead of
	 * leaving the session on whatever the pin last set.
	 */
	previousModel?: BackendRef;
	/**
	 * The vendor's own session id from the last Manual turn on a CLI pin
	 * (PRD-048 Phase 2), so the next turn continues that conversation instead of
	 * starting over. Reset whenever the pin changes or clears.
	 */
	manualSessionId?: string;
	/**
	 * PRD-053: the highest class an Auto turn of this session has routed to. The
	 * first message decides; a later turn may escalate past it but never drops
	 * below it, so a short follow-up stays on the model that did the work. A
	 * session switch or `/route reset` clears it with the other pins.
	 */
	executor_floor?: ExecutorClass;
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

/** Executor classes by capability; `specialist` is a peer of `strong`, not above it. */
const EXECUTOR_RANK: Record<ExecutorClass, number> = { quick: 0, balanced: 1, strong: 2, specialist: 2 };

/** The higher of two classes; a tie keeps `routed`. */
export function higherClass(routed: ExecutorClass, floor: ExecutorClass | undefined): ExecutorClass {
	return floor !== undefined && EXECUTOR_RANK[floor] > EXECUTOR_RANK[routed] ? floor : routed;
}

/** The session floor raises the matrix default before deviations route around an unavailable class. */
export function applyExecutorFloor(defaults: RoutingDefault, current: RoutePins = pins): RoutingDefault {
	return { ...defaults, executor_class: higherClass(defaults.executor_class, current.executor_floor) };
}

/** Record an Auto turn's class; the floor only rises. A `/route executor` pin is the operator's, not a decision. */
export function recordExecutorFloor(routed: ExecutorClass): void {
	if (pins.executor_class !== undefined) return;
	pins = { ...pins, executor_floor: higherClass(routed, pins.executor_floor) };
}

/** A pinned class replaces the matrix default; the deviation record is untouched. */
export function applyRoutePins(defaults: RoutingDefault, current: RoutePins = pins): RoutingDefault {
	return {
		executor_class: current.executor_class ?? defaults.executor_class,
		reviewer_class: current.reviewer_class ?? defaults.reviewer_class,
	};
}
