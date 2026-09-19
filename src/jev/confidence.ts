/**
 * The asymmetric confidence policy (PRD-002 Phase 5, ROADMAP §50).
 *
 * This file holds the only threshold table in LeanPi. Consequence classes come
 * from the decision-site registration, so raising the bar for a
 * high-consequence decision is a one-line registry change, not a code change in
 * the lane that consumes the answer.
 */
import type { Consequence, JevResult } from "./types.js";

export const CONFIDENCE_THRESHOLDS: Record<Consequence, number> = {
	low: 0.5,
	normal: 0.7,
	high: 0.85,
};

/** Below-threshold results are rejected and the caller takes its conservative branch. */
export function accept(result: JevResult, consequence: Consequence): boolean {
	return result.confidence >= CONFIDENCE_THRESHOLDS[consequence];
}
