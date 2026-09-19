/**
 * The §14 routing matrix (PRD-004 Phase 3).
 *
 * Held as data, not branches. ROADMAP §14 offers alternatives in three cells;
 * this module resolves each to one value so the table is comparable against an
 * assertion, and the one risk-dependent cell (`false`/`LOW`) consults the fixed
 * `R0 → none`, `R1`/`R2 → review_quick`, `R3 → review_strong` band mapping.
 */
import type { DeviationInput, ExecutorClass, ExecutionComplexity, ReviewerClass, ReviewRisk, RouteDeviation } from "./contract.js";

export interface MatrixCell {
	executor_class: ExecutorClass;
	reviewer_class: ReviewerClass | "by_review_risk";
}

export const ROUTING_MATRIX: Record<string, MatrixCell> = {
	"false|LOW": { executor_class: "quick", reviewer_class: "by_review_risk" },
	"false|MEDIUM": { executor_class: "balanced", reviewer_class: "review_quick" },
	"false|HIGH": { executor_class: "strong", reviewer_class: "review_strong" },
	"true|LOW": { executor_class: "quick", reviewer_class: "review_quick" },
	"true|MEDIUM": { executor_class: "balanced", reviewer_class: "review_strong" },
	"true|HIGH": { executor_class: "strong", reviewer_class: "review_strong" },
};

export const REVIEWER_BY_RISK: Record<ReviewRisk, ReviewerClass> = {
	R0: "none",
	R1: "review_quick",
	R2: "review_quick",
	R3: "review_strong",
};

export interface RoutingDefault {
	executor_class: ExecutorClass;
	reviewer_class: ReviewerClass;
}

export function matrixDefault(prdRequired: boolean, complexity: ExecutionComplexity, reviewRisk: ReviewRisk): RoutingDefault {
	const cell = ROUTING_MATRIX[`${prdRequired}|${complexity}`];
	if (!cell) throw new Error(`No §14 routing row for prd_required=${prdRequired}, complexity=${complexity}`);
	return {
		executor_class: cell.executor_class,
		reviewer_class: cell.reviewer_class === "by_review_risk" ? REVIEWER_BY_RISK[reviewRisk] : cell.reviewer_class,
	};
}

const FALLBACK_ORDER: ExecutorClass[] = ["quick", "balanced", "strong", "specialist"];

/**
 * Consume the §14 deviation inputs. With an empty input set the defaults come
 * back unmodified and no deviation is recorded; an unknown input is ignored
 * rather than failing — routing must always produce a contract.
 */
export function applyDeviations(
	defaults: RoutingDefault,
	inputs: DeviationInput[] = [],
): { routing: RoutingDefault; deviation?: RouteDeviation } {
	let routing = { ...defaults };
	const applied: string[] = [];

	for (const input of inputs) {
		const unavailable = input.available === false;
		const targetsClass = input.executor_class === undefined || input.executor_class === routing.executor_class;
		if (!unavailable || !targetsClass) continue;
		const from = routing.executor_class;
		const replacement = FALLBACK_ORDER.find(
			(candidate) => candidate !== from && !inputs.some((other) => other.available === false && other.executor_class === candidate),
		);
		if (!replacement) continue;
		routing = { ...routing, executor_class: replacement };
		applied.push(input.reason);
	}

	if (applied.length === 0) return { routing };
	return {
		routing,
		deviation: { from: defaults.executor_class, to: routing.executor_class, reason: applied.join("; ") },
	};
}
