/**
 * The native-loop outcome on a telemetry row (PRD-052 follow-up).
 *
 * On a native config Pi's own loop is the executor, so no proof gate ever runs
 * and `success` stays false for every turn. That is honest but leaves §3's
 * objective with no numerator. `result.loop` records what the loop actually
 * did, kept separate from the gated `success` so the two never blur.
 *
 * Red on `main`: neither the field nor the aggregate exists.
 */
import { describe, expect, it } from "vitest";
import { aggregateRuns } from "../../src/telemetry/aggregate.js";
import { renderCostReport } from "../../src/telemetry/cost.js";
import { runRecord } from "../routing/fixture.js";

describe("native-loop outcome", () => {
	it("counts a completed loop separately from a verified success", () => {
		const gated = runRecord({ backend: "metered", model: "m", success: true }, 0);
		const base = runRecord({ backend: "metered", model: "m", success: false }, 1);
		const native = { ...base, result: { ...base.result, loop: "completed" as const } };

		const aggregate = aggregateRuns([gated, native]);
		expect(aggregate.verifiedSuccesses).toBe(1);
		expect(aggregate.completedTurns).toBe(1);
		expect(aggregate.costPerCompletedTurn).not.toBeNull();

		const report = renderCostReport([gated, native], aggregate, "session");
		expect(report).toContain("completed turns: 1");
		expect(report).toContain("effective cost per completed turn:");
	});

	it("an interrupted loop is not a completed turn", () => {
		const base = runRecord({ backend: "metered", model: "m", success: false }, 0);
		const aborted = { ...base, result: { ...base.result, loop: "aborted" as const } };
		const aggregate = aggregateRuns([aborted]);
		expect(aggregate.completedTurns).toBe(0);
		expect(aggregate.costPerCompletedTurn).toBeNull();
	});
});
