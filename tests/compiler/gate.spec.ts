/**
 * PRD-004 Phase 1 — AC-1, AC-2, AC-3: the planning gate.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compileRecordOf, compileTask, reviewRiskFromSignals, reviewRiskSignals } from "../../src/index.js";
import { answerScript, harness, packet, unavailableHarness, type CompilerHarness } from "./helpers.js";

let active: CompilerHarness | undefined;

afterEach(async () => {
	await active?.close();
	active = undefined;
});

const LOW_RISK_PACKET = packet({
	task: { user_request: "change the button text from Deploy to Publish" },
	workspace: { changed_files: ["src/button.ts"], likely_modules: ["src"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
});

describe("PRD-004 Phase 1 — planning gate", () => {
	it("AC-1: the §62 task runs direct and the §64 task requires a PRD", async () => {
		active = await harness([
			answerScript({ choices: { localized: "yes", architecture: "no", multi_behavior: "no", multi_stage: "no", ambiguous: "no" } }),
		]);
		const direct = await compileTask("change the button text from Deploy to Publish", LOW_RISK_PACKET);
		expect(direct.task.prd_required).toBe(false);
		expect(direct.task.planning_decision).toBe("DIRECT_EXECUTION");
		expect(compileRecordOf(direct)!.next_stage).toBe("executor_lane");
		await active.close();
		active = undefined;

		active = await harness([answerScript({ choices: { architecture: "yes", localized: "no" } })]);
		const prd = await compileTask("replace the networking implementation while maintaining compatibility", packet({
			task: { user_request: "replace the networking implementation while maintaining compatibility" },
			workspace: { changed_files: ["src/net/a.ts", "src/net/b.ts", "src/net/c.ts"], likely_modules: ["src/net", "src/api"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
		}));
		expect(prd.task.prd_required).toBe(true);
		expect(prd.task.planning_decision).toBe("PRD_REQUIRED");
		expect(compileRecordOf(prd)!.next_stage).toBe("prd_lane");
	});

	it("AC-2: below-threshold answers resolve asymmetrically by risk", async () => {
		// Answers that clear the client's high-consequence acceptance bar (0.85) but
		// sit below the configured gate threshold are the low-confidence case §10
		// describes: the calibration knob is configuration, not a literal.
		const calibrated = { thresholds: { gate_prd_required: 0.9, complexity: 0.5, review_risk: 0.5 } };
		// The scripted risk answers mirror what the deterministic signals say about
		// this packet, so the only difference between the two results is the §10
		// elevation.
		active = await harness(
			[
				answerScript({
					choices: { localized: "yes", deterministic_sufficient: "yes", alters_visible: "no", wide_blast: "no" },
					confidence: 0.86,
				}),
			],
			calibrated,
		);
		const bounded = await compileTask("change the button text from Deploy to Publish", LOW_RISK_PACKET);
		const deterministic = reviewRiskFromSignals(reviewRiskSignals(bounded.task.user_request, LOW_RISK_PACKET), false);
		expect(bounded.task.prd_required).toBe(false);
		expect(Number(bounded.task.review_risk.slice(1))).toBe(Number(deterministic.slice(1)) + 1);
		await active.close();
		active = undefined;

		// Architectural task: PRD creation.
		const architecturePacket = packet({
			task: { user_request: "replace the networking implementation while maintaining compatibility" },
			workspace: { changed_files: ["src/net/a.ts", "src/net/b.ts"], likely_modules: ["src/net", "src/api"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
		});
		active = await harness([answerScript({ choices: { architecture: "yes" }, confidence: 0.86 })], calibrated);
		const architectural = await compileTask("replace the networking implementation while maintaining compatibility", architecturePacket);
		expect(architectural.task.prd_required).toBe(true);
	});

	it("AC-3: an unreachable JEV still yields a complete contract with fallback_used on every site", async () => {
		active = await unavailableHarness();
		const contract = await compileTask("implement a small helper for the loader", packet({
			task: { user_request: "implement a small helper for the loader" },
			workspace: { changed_files: ["src/loader.ts"], likely_modules: ["src"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" },
		}));

		expect(contract.task.execution_complexity).toBe("MEDIUM");
		expect(contract.routing.executor_class).toBe("balanced");
		expect(contract.routing.executor_backend).toBe("unresolved");
		expect(contract.limits.execution_attempts).toBeGreaterThan(0);

		const record = compileRecordOf(contract)!;
		expect(record.telemetry.map((row) => row.site_id).sort()).toEqual([
			"classify.execution_complexity",
			"classify.required_capability",
			"classify.review_risk_input",
			"gate.prd_required",
		]);
		expect(record.telemetry.every((row) => row.fallback_used)).toBe(true);
	});
});
