/**
 * PRD-011 Phase 1 verification (E1) — the reviewer lane through `/review`.
 *
 * The reviewer is a real PRD-008 backend worker in the AC-1 case (the vendor
 * stub CLI from the backend suite) and a scripted runner everywhere else, so the
 * suite stays offline and needs no model and no credential.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BackendRegistry } from "../../src/backends/index.js";
import { createCommandRegistry } from "../../src/commands/registry.js";
import { createTaskState } from "../../src/compiler/state.js";
import { registerReviewCommand, runReview } from "../../src/review/commands.js";
import { review } from "../../src/review/lane.js";
import { REVIEW_PACKET_KEYS, type ReviewLevel, type ReviewPacket } from "../../src/review/schema.js";
import { EvidenceStore } from "../../src/verify/evidence.js";
import { installStubCli, setStubScript } from "../backends/helpers.js";
import { fixtureRepo, nativeBackend } from "../helpers/fixtures.js";
import { contractOf, recordingExec } from "../verify/support.js";
import { configWith, reviewRepo, scriptedRunner, singleBackendConfig, TRANSCRIPT_MARKER, twoBackendConfig, verdictJson } from "./support.js";

const CONTEXT = { cwd: process.cwd() };

describe("reviewer lane", () => {
	it("AC-1 returns FIX_REQUIRED with a fully populated finding through a real backend worker", async () => {
		const repo = reviewRepo();
		const cli = installStubCli();
		const violation = verdictJson("FIX_REQUIRED", [
			{ criterion: "AC-1", file: "src/app.ts", location: "line 1", severity: "error", evidence: "value is 2, AC-1 states 1" },
		]);
		const restore = setStubScript(cli.recordPath, { mode: "ok", files: {}, summary: violation });
		try {
			const config = configWith(
				repo.cwd,
				{ claude: { type: "external_harness", vendor: "claude", command: cli.bin.claude } },
				{ review_quick: { backend: "claude", model: "review-m1" } },
			);
			const commands = createCommandRegistry();
			const registration = registerReviewCommand(commands, {
				cwd: repo.cwd,
				config,
				artifacts: repo.artifacts,
				contract: contractOf({ required: ["typecheck"], criteria: [{ id: "AC-1" }] }),
				verify: false,
				executor: { backend: "exec", model: "exec-ma" },
			});

			const result = await commands.dispatch("/review", { ...CONTEXT, cwd: repo.cwd });
			expect(result.ok).toBe(true);
			expect(result.text).toContain("FIX_REQUIRED");
			expect(cli.records()).toHaveLength(1);

			const outcome = registration.last();
			expect(outcome?.verdict.decision).toBe("FIX_REQUIRED");
			const finding = outcome!.verdict.findings[0]!;
			for (const field of ["criterion", "file", "location", "severity", "evidence"] as const) {
				expect(finding[field].length).toBeGreaterThan(0);
			}
			expect(finding.criterion).toBe("AC-1");
		} finally {
			restore();
		}
	});

	it("AC-1 maps a malformed reviewer answer to ESCALATE and never PASS", async () => {
		const repo = reviewRepo();
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { mode: "ok", files: {}, summary: "Looks good to me, ship it!" });
		try {
			const config = configWith(
				repo.cwd,
				{ claude: { type: "external_harness", vendor: "claude", command: cli.bin.claude } },
				{ review_quick: { backend: "claude", model: "review-m1" } },
			);
			const commands = createCommandRegistry();
			const registration = registerReviewCommand(commands, { cwd: repo.cwd, config, artifacts: repo.artifacts, verify: false });

			const result = await commands.dispatch("/review quick", { ...CONTEXT, cwd: repo.cwd });
			expect(result.text).toContain("ESCALATE");
			expect(result.text).not.toContain("PASS");
			expect(registration.last()!.verdict.decision).toBe("ESCALATE");
		} finally {
			restore();
		}
	});

	it("AC-2 sends exactly the seven §30 keys, no transcript substring, and a retrievable diff reference", async () => {
		const repo = reviewRepo();
		const scripted = scriptedRunner(verdictJson("PASS"));
		const outcome = await runReview(
			{
				cwd: repo.cwd,
				config: singleBackendConfig(repo.cwd),
				artifacts: repo.artifacts,
				contract: contractOf({ required: ["typecheck"], criteria: [{ id: "AC-1" }] }),
				verify: false,
				executorSummary: "set the value to 2",
				inlineDiffBytes: 60,
				runner: scripted.runner,
			},
			"quick",
		);

		expect(Object.keys(outcome.packet).sort()).toEqual([...REVIEW_PACKET_KEYS].sort());
		// The request the reviewer actually received carries the same seven keys and no more.
		const embedded = outcome.prompt.split("## evidence packet\n\n")[1]?.split("\n\n## output")[0];
		expect(embedded).toBeDefined();
		expect(Object.keys(JSON.parse(embedded!) as Record<string, unknown>).sort()).toEqual([...REVIEW_PACKET_KEYS].sort());
		expect(outcome.prompt).not.toContain(TRANSCRIPT_MARKER);
		expect(outcome.packet.final_diff.length).toBeGreaterThan(0);
		// The marker is real and reachable in the workspace, and still absent here.
		expect(readFileSync(repo.transcriptPath, "utf8")).toContain(TRANSCRIPT_MARKER);
		expect(JSON.stringify(outcome.packet)).not.toContain(TRANSCRIPT_MARKER);
		// Red control: the absence check is sensitive, not vacuous.
		expect(JSON.stringify({ ...outcome.packet, executor_summary: `saw ${TRANSCRIPT_MARKER}` })).toContain(TRANSCRIPT_MARKER);

		const ref = /artifact:\/\/diff\/[A-Za-z0-9._-]+/.exec(outcome.packet.final_diff)?.[0];
		expect(ref).toBeDefined();
		const full = repo.artifacts.expand(ref!).toString("utf8");
		expect(full).toBe(repo.diff());
		expect(full.length).toBeGreaterThan(outcome.packet.final_diff.length);
	});

	it("AC-4 records a differing reviewer model identity, and degraded independence with a reason", async () => {
		const repo = reviewRepo();
		const two = scriptedRunner(verdictJson("PASS"));
		const independent = await runReview(
			{ cwd: repo.cwd, config: twoBackendConfig(repo.cwd), executor: { backend: "a", model: "exec-ma" }, verify: false, runner: two.runner },
			"strong",
		);
		expect(independent.role).toBe("review_strong");
		expect(independent.independence).toBe("independent");
		expect(`${independent.backend}/${independent.model}`).not.toBe("a/exec-ma");
		expect(independent.backend).toBe("b");

		const quick = scriptedRunner(verdictJson("PASS"));
		const quickOutcome = await runReview(
			{ cwd: repo.cwd, config: twoBackendConfig(repo.cwd), executor: { backend: "a", model: "exec-ma" }, verify: false, runner: quick.runner },
			"quick",
		);
		expect(quickOutcome.backend).toBe("b");
		expect(quickOutcome.model).not.toBe("exec-ma");

		const only = scriptedRunner(verdictJson("PASS"));
		const degraded = await runReview(
			{ cwd: repo.cwd, config: singleBackendConfig(repo.cwd), executor: { backend: "a", model: "exec-ma" }, verify: false, runner: only.runner },
			"quick",
		);
		expect(degraded.verdict.decision).toBe("PASS");
		expect(degraded.independence).toBe("degraded");
		expect(degraded.reason ?? "").toContain("exec-ma");
	});

	it("AC-5 serves every mode after a NO_SEMANTIC_REVIEW decision, and runs no verifier for diff", async () => {
		const repo = reviewRepo();
		const config = twoBackendConfig(repo.cwd);
		const contract = contractOf({ required: ["typecheck", "affected_tests"] });
		const scripted = scriptedRunner(verdictJson("PASS"));
		const recordedLevel = (): ReviewLevel => "NO_SEMANTIC_REVIEW";

		const cases = [
			{ mode: "quick", level: "QUICK_REVIEW", role: "review_quick" },
			{ mode: "strong", level: "STRONG_REVIEW", role: "review_strong" },
			{ mode: "security", level: "STRONG_REVIEW", role: "review_strong" },
		] as const;

		for (const entry of cases) {
			const verification = recordingExec();
			const commands = createCommandRegistry();
			const registration = registerReviewCommand(commands, {
				cwd: repo.cwd,
				config,
				artifacts: repo.artifacts,
				contract,
				recordedLevel,
				exec: verification.exec,
				store: new EvidenceStore(),
				runner: scripted.runner,
			});
			const result = await commands.dispatch(`/review ${entry.mode}`, { ...CONTEXT, cwd: repo.cwd });
			const outcome = registration.last()!;
			expect(result.text).toContain("PASS");
			expect(outcome.verdict.decision).toBe("PASS");
			expect(outcome.level).toBe(entry.level);
			expect(outcome.role).toBe(entry.role);
			expect(outcome.packet.verification_results.length).toBeGreaterThan(0);
			expect(verification.commands.length).toBeGreaterThan(0);
		}

		// Bare `/review` reuses the gate's level without ever skipping the review.
		const bare = createCommandRegistry();
		const bareRegistration = registerReviewCommand(bare, { cwd: repo.cwd, config, artifacts: repo.artifacts, verify: false, runner: scripted.runner, recordedLevel });
		await bare.dispatch("/review", { ...CONTEXT, cwd: repo.cwd });
		expect(bareRegistration.last()!.level).toBe("QUICK_REVIEW");

		const verification = recordingExec();
		const diffCommands = createCommandRegistry();
		const diffRegistration = registerReviewCommand(diffCommands, {
			cwd: repo.cwd,
			config,
			artifacts: repo.artifacts,
			contract,
			exec: verification.exec,
			store: new EvidenceStore(),
			runner: scripted.runner,
		});
		await diffCommands.dispatch("/review diff", { ...CONTEXT, cwd: repo.cwd });
		const diffOutcome = diffRegistration.last()!;
		expect(diffOutcome.packet.final_diff).toContain("src/app.ts");
		expect(diffOutcome.packet.verification_results).toEqual([]);
		expect(verification.commands).toEqual([]);
	});

	it("feeds ReviewState only, leaving the execution record untouched", async () => {
		const repo = reviewRepo();
		const state = createTaskState();
		const finding = { criterion: "AC-1", file: "src/app.ts", location: "line 1", severity: "error", evidence: "value is 2" };
		await runReview(
			{
				cwd: repo.cwd,
				config: singleBackendConfig(repo.cwd),
				verify: false,
				state,
				runner: scriptedRunner(verdictJson("FIX_REQUIRED", [finding])).runner,
			},
			"quick",
		);
		expect(state.review()).toEqual(expect.objectContaining({ rounds: 1, verdicts: ["FIX_REQUIRED"] }));
		expect(state.execution().attempts).toBe(0);
		expect(state.planning().decision).toBeNull();
	});

	it("reports an unknown mode without invoking the reviewer", async () => {
		const repo = reviewRepo();
		const scripted = scriptedRunner(verdictJson("PASS"));
		const commands = createCommandRegistry();
		registerReviewCommand(commands, { cwd: repo.cwd, config: singleBackendConfig(repo.cwd), verify: false, runner: scripted.runner });

		const result = await commands.dispatch("/review thorough", { ...CONTEXT, cwd: repo.cwd });
		expect(result.ok).toBe(false);
		expect(scripted.calls).toHaveLength(0);
	});

	it("escalates to a stronger reviewer when a quick review cannot decide", async () => {
		const repo = reviewRepo();
		const scripted = scriptedRunner(verdictJson("ESCALATE", [{ criterion: "AC-1", file: "src/app.ts", location: "line 1", severity: "error", evidence: "cannot tell" }]));
		const outcome = await runReview(
			{ cwd: repo.cwd, config: twoBackendConfig(repo.cwd), verify: false, runner: scripted.runner, executor: { backend: "a", model: "exec-ma" } },
			"quick",
		);
		expect(outcome.escalation).toEqual(expect.objectContaining({ kind: "stronger_reviewer", role: "review_strong" }));
		// The escalation is returned, not acted on: the executor's state is untouched.
		const escalated = await runReview(
			{ cwd: repo.cwd, config: twoBackendConfig(repo.cwd), verify: false, runner: scripted.runner },
			"strong",
		);
		expect(escalated.escalation?.kind).toBe("executor");
	});

	it("reports a reviewer backend failure as ESCALATE rather than a thrown turn", async () => {
		const repo = reviewRepo();
		const outcome = await runReview(
			{
				cwd: repo.cwd,
				config: singleBackendConfig(repo.cwd),
				verify: false,
				runner: async () => ({ status: "failed", failure: "timeout", reason: "reviewer exceeded 1000ms" }),
			},
			"quick",
		);
		expect(outcome.verdict.decision).toBe("ESCALATE");
		expect(outcome.verdict.findings[0]!.evidence).toContain("timeout");
	});
});

/** A packet good enough to review; the lane only renders it into the prompt. */
const PACKET: ReviewPacket = {
	objective: "set the value to 2",
	acceptance_criteria: [{ id: "AC-1", text: "the value is 2" }],
	final_diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
	changed_files: ["src/app.ts"],
	verification_results: [],
	known_warnings: [],
	executor_summary: "set the value to 2",
};

describe("reviewer dispatch", () => {
	it("F5: runs the model the review role's fallback chain binds on the selected backend", async () => {
		const repo = reviewRepo();
		const cli = installStubCli();
		const restore = setStubScript(cli.recordPath, { mode: "ok", files: {}, summary: verdictJson("PASS") });
		try {
			// No `review_quick` entry and no entry-level `model:`: `quick` is the only
			// role that names this backend, and the §27 ladder says that is enough.
			const config = configWith(
				repo.cwd,
				{ opencode: { type: "external_harness", vendor: "opencode", command: cli.bin.opencode } },
				{ quick: { backend: "opencode", model: "cheap" }, balanced: { backend: "opencode", model: "mid" }, strong: { backend: "opencode", model: "big" } },
			);
			const outcome = await review(PACKET, "QUICK_REVIEW", "gate", { registry: new BackendRegistry(config), cwd: repo.cwd, config });
			expect(outcome.verdict.decision).toBe("PASS");
			expect(outcome.backend).toBe("opencode");
			expect(outcome.model).toBe("cheap");
			// The model the reviewer was actually launched with, not just the reported one.
			expect(cli.records()[0]?.argv).toContain("cheap");
		} finally {
			restore();
		}
	});

	it("F5: a review role the config binds keeps its own model", async () => {
		const repo = reviewRepo();
		const scripted = scriptedRunner(verdictJson("PASS"));
		const config = configWith(
			repo.cwd,
			{ a: nativeBackend("http://127.0.0.1:1/v1/a", { model: "entry-model" }) },
			{ review_quick: { backend: "a", model: "review-cheap" } },
		);
		const outcome = await review(PACKET, "QUICK_REVIEW", "gate", {
			registry: new BackendRegistry(config),
			cwd: repo.cwd,
			config,
			runner: scripted.runner,
		});
		expect(outcome.model).toBe("review-cheap");
		expect(scripted.calls[0]?.packet.model).toBe("review-cheap");
	});

	it("F5: leaves the model unresolved rather than fabricating one", async () => {
		const { cwd } = fixtureRepo();
		const config = configWith(cwd, { local: nativeBackend("http://127.0.0.1:1/v1/local") }, {});
		const outcome = await review(PACKET, "QUICK_REVIEW", "gate", { registry: new BackendRegistry(config), cwd, config });
		expect(outcome.verdict.decision).toBe("ESCALATE");
		expect(outcome.model).toBeNull();
		expect(outcome.reason ?? "").toContain('declares no model for role "review_quick"');
	});

	it("F4: prefers the second candidate when the executor's identity is the first candidate's", async () => {
		const repo = reviewRepo();
		const scripted = scriptedRunner(verdictJson("PASS"));
		const config = twoBackendConfig(repo.cwd);
		const outcome = await review(PACKET, "QUICK_REVIEW", "gate", {
			registry: new BackendRegistry(config),
			cwd: repo.cwd,
			config,
			executor: { backend: "a", model: "exec-ma" },
			runner: scripted.runner,
		});
		expect(outcome.backend).toBe("b");
		expect(outcome.independence).toBe("independent");
		expect(scripted.calls[0]?.backend.name).toBe("b");
	});
});
