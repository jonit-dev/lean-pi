/**
 * E3 (PRD-016 Phase 3): `/route` shows the routing decision and accepts overrides.
 *
 * Covers AC-6 (all ten §45 lines match the contract), AC-7 and AC-8 (an override
 * changes the *next compiled contract*, not just the display) and AC-9 (per-site
 * JEV lines, and the JEV-off path). The JEV-off rendering is asserted with the
 * sites registered but unreachable, which is the case §58 requires to keep
 * working.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRoutePins } from "../../src/compiler/pins.js";
import { clearSites, compileRecordOf, compileTask } from "../../src/index.js";
import { answerScript, harness, packet, unavailableHarness } from "../compiler/helpers.js";
import { surfaceFixture } from "./helpers.js";

const DIRECT_TASK = "fix the cache key so repeated reads hit the cache";
const PRD_TASK = "rewrite the storage layer across two stages";

/** The §45 lines, in the order §45 fixes them. */
const LINE_LABELS = ["PRD", "complexity", "review risk", "executor", "review", "skills", "MCP", "LSP", "reasoning", "budget"];

function labelOrder(text: string): string[] {
	return text
		.split("\n")
		.map((line) => LINE_LABELS.find((label) => line.startsWith(`${label}:`)))
		.filter((label): label is string => label !== undefined);
}

/** The fixture's surface shares the compiler harness's config, role map and JEV client. */
async function routedFixture(answers: Parameters<typeof answerScript>[0] = {}) {
	const h = await harness([answerScript(answers)]);
	const fixture = surfaceFixture({
		cwd: h.cwd,
		writeConfigFile: false,
		config: {},
		configOverrides: h.config,
		jev: () => h.client,
	});
	return { h, fixture };
}

describe("/route (PRD-016 Phase 3)", () => {
	beforeEach(() => clearSites());
	afterEach(() => {
		clearSites();
		clearRoutePins();
	});

	it("prints the ten §45 lines with the contract's values and the JEV sites that fired (AC-6, AC-9)", async () => {
		const { h, fixture } = await routedFixture({ choices: { localized: "yes" } });
		try {
			const contract = await compileTask(DIRECT_TASK, packet());
			fixture.surface.recordContract(contract);

			const route = await fixture.dispatch("/route");
			expect(route.ok).toBe(true);
			expect(labelOrder(route.text)).toEqual(LINE_LABELS);

			expect(route.text).toContain(`PRD: ${contract.task.prd_required ? "yes" : "no"} (planning ${contract.task.planning_decision})`);
			expect(route.text).toContain(`complexity: ${contract.task.execution_complexity}`);
			expect(route.text).toContain(`review risk: ${contract.task.review_risk}`);
			expect(route.text).toContain(`executor: ${contract.routing.executor_class} `);
			expect(route.text).toMatch(new RegExp(`^review: ${contract.routing.reviewer_class}`, "m"));
			expect(route.text).toContain("skills: none selected");
			expect(route.text).toContain("MCP: 0 selected");
			expect(route.text).toContain("LSP: available");
			expect(route.text).toContain(`reasoning: ${contract.reasoning.effort}`);
			expect(route.text).toContain(`budget: ${contract.context.budget_tokens} tokens (${contract.context.strategy})`);

			// Every site that answered is reported as fired, with its answer and confidence.
			expect(route.text).toMatch(/jev: gate\.prd_required fired \(choice \w+, conf 0\.95\)/);
			expect(route.text).toContain("classify.execution_complexity fired");
			expect(route.text).not.toContain("gate.prd_required fallback");
		} finally {
			await h.close();
		}
	});

	it("pins the executor and reviewer lanes into the next compiled contract, and reset clears them (AC-7)", async () => {
		const { h, fixture } = await routedFixture({ choices: { localized: "yes" } });
		try {
			const before = await compileTask(DIRECT_TASK, packet());
			expect(before.routing.executor_class).not.toBe("strong");

			const pinnedExecutor = await fixture.dispatch("/route executor strong");
			expect(pinnedExecutor.ok).toBe(true);
			expect(pinnedExecutor.text).toContain("executor: strong");
			expect(pinnedExecutor.text).toContain("(forced)");

			const pinnedReviewer = await fixture.dispatch("/route reviewer strong");
			expect(pinnedReviewer.ok).toBe(true);
			expect(pinnedReviewer.text).toContain("(forced)");

			fixture.surface.recordContract(before);
			const shown = await fixture.dispatch("/route");
			expect(shown.text).toMatch(/^executor: strong \S+ \(forced\)$/m);
			expect(shown.text).toMatch(/^review: review_strong \S* \(forced\)$/m);

			const next = await compileTask(DIRECT_TASK, packet());
			expect(next.routing.executor_class).toBe("strong");
			expect(next.routing.reviewer_class).toBe("review_strong");

			const reset = await fixture.dispatch("/route reset");
			expect(reset.ok).toBe(true);
			const restored = await compileTask(DIRECT_TASK, packet());
			expect(restored.routing.executor_class).toBe(before.routing.executor_class);
			expect(restored.routing.reviewer_class).toBe(before.routing.reviewer_class);
		} finally {
			await h.close();
		}
	});

	it("forces and skips the PRD gate in both directions, changing the lane the run enters (AC-8)", async () => {
		const noPrd = await routedFixture({ choices: { localized: "yes" } });
		try {
			const classified = await compileTask(DIRECT_TASK, packet());
			expect(classified.task.prd_required).toBe(false);

			const forced = await noPrd.fixture.dispatch("/route prd force");
			expect(forced.ok).toBe(true);
			expect(forced.text).toContain("PRD: yes (forced)");

			const next = await compileTask(DIRECT_TASK, packet());
			expect(next.task.prd_required).toBe(true);
			expect(next.task.planning_decision).toBe("PRD_REQUIRED");
			expect(compileRecordOf(next)?.next_stage).toBe("prd_lane");
			// A pinned gate was not decided by JEV, and the record says so.
			expect(compileRecordOf(next)?.telemetry.find((row) => row.site_id === "gate.prd_required")?.fallback_used).toBe(true);

			const reset = await noPrd.fixture.dispatch("/route reset");
			expect(reset.ok).toBe(true);
			const restored = await compileTask(DIRECT_TASK, packet());
			expect(restored.task.prd_required).toBe(false);
			expect(compileRecordOf(restored)?.next_stage).toBe("executor_lane");
		} finally {
			clearRoutePins();
			await noPrd.h.close();
		}

		const prd = await routedFixture({ choices: { architecture: "yes" } });
		try {
			const classified = await compileTask(PRD_TASK, packet());
			expect(classified.task.prd_required).toBe(true);

			const skipped = await prd.fixture.dispatch("/route prd skip");
			expect(skipped.ok).toBe(true);
			expect(skipped.text).toContain("PRD: no (forced)");

			const next = await compileTask(PRD_TASK, packet());
			expect(next.task.prd_required).toBe(false);
			expect(compileRecordOf(next)?.next_stage).toBe("executor_lane");
		} finally {
			await prd.h.close();
		}
	});

	it("renders all ten lines with every site on fallback when JEV is unavailable (AC-9)", async () => {
		const h = await unavailableHarness();
		try {
			const contract = await compileTask(DIRECT_TASK, packet());
			const fixture = surfaceFixture({
				cwd: h.cwd,
				writeConfigFile: false,
				config: {},
				configOverrides: h.config,
			});
			fixture.surface.recordContract(contract);

			const route = await fixture.dispatch("/route");
			expect(labelOrder(route.text)).toEqual(LINE_LABELS);
			expect(route.text).toMatch(/^jev: /m);
			expect(route.text).toContain("fallback (jev disabled)");
			expect(route.text).not.toContain(" fired ");
		} finally {
			await h.close();
		}
	});

	it("rejects an unknown override value instead of pinning nothing", async () => {
		const { h, fixture } = await routedFixture({ choices: { localized: "yes" } });
		try {
			const bad = await fixture.dispatch("/route executor enormous");
			expect(bad.ok).toBe(false);
			expect(bad.text).toContain("usage: /route executor");
			const badPrd = await fixture.dispatch("/route prd maybe");
			expect(badPrd.ok).toBe(false);
			expect(badPrd.text).toContain("usage: /route prd");
		} finally {
			await h.close();
		}
	});
});
