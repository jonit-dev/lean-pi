/**
 * PRD-011 Phase 2 verification (E2) — the review gate and its conservative fallback.
 *
 * The negative control is structural: the JEV stub answers `NO_SEMANTIC_REVIEW`
 * in the risky case, so a gate that merely forwarded the model's answer cannot
 * pass this file.
 */
import { describe, expect, it } from "vitest";
import { BackendRegistry, type BackendInvocation } from "../../src/backends/index.js";
import { getSite } from "../../src/jev/registry.js";
import { runReview } from "../../src/review/commands.js";
import { REVIEW_LEVEL_QUESTION_ID, REVIEW_LEVEL_SITE_ID, classifyReview } from "../../src/review/gate.js";
import { jevAnswering, reviewRepo, scriptedRunner, throwingJev, twoBackendConfig, verdictJson } from "./support.js";

describe("review gate", () => {
	it("registers the review.level decision site with a deterministic QUICK_REVIEW fallback", () => {
		const site = getSite(REVIEW_LEVEL_SITE_ID);
		expect(site.returnType).toEqual(["Choice"]);
		expect(site.questions[0]!.id).toBe(REVIEW_LEVEL_QUESTION_ID);
		expect(site.telemetryTag).toBe(REVIEW_LEVEL_SITE_ID);
		const [fallback] = site.fallback({ siteId: site.id, reason: "test", state: {}, questions: site.questions });
		expect(fallback).toMatchObject({ kind: "Choice", choice: "QUICK_REVIEW" });
	});

	it("AC-3 skips the reviewer for a small green change, and raises a security-sensitive failed change to strong", async () => {
		const repo = reviewRepo();
		const lowRisk = await jevAnswering("NO_SEMANTIC_REVIEW");
		try {
			const gate = await classifyReview({
				changedFiles: ["src/app.ts"],
				diffBytes: 120,
				executionComplexity: "LOW",
				reviewRisk: "R0",
				testCoverage: "full",
				proofStrength: "strong",
				client: lowRisk.client,
			});
			expect(gate.level).toBe("NO_SEMANTIC_REVIEW");

			// The executor lane's hook, verbatim: the level decides whether a reviewer runs.
			const invocations: BackendInvocation[] = [];
			const registry = new BackendRegistry(twoBackendConfig(repo.cwd), { onInvocation: (record) => invocations.push(record) });
			const scripted = scriptedRunner(verdictJson("PASS"));
			const outcome = gate.level === "NO_SEMANTIC_REVIEW"
				? undefined
				: await runReview({ cwd: repo.cwd, config: twoBackendConfig(repo.cwd), registry, verify: false, runner: scripted.runner, recordedLevel: () => gate.level }, "gate");
			expect(outcome).toBeUndefined();
			expect(scripted.calls).toHaveLength(0);
			expect(invocations).toHaveLength(0);
		} finally {
			await lowRisk.close();
		}

		const disagreement = await jevAnswering("NO_SEMANTIC_REVIEW");
		try {
			const gate = await classifyReview({
				changedFiles: ["src/auth/session.ts"],
				executionComplexity: "LOW",
				reviewRisk: "R2",
				reviewerClass: "review_quick",
				securitySensitivePaths: ["src/auth/session.ts"],
				failedAttempts: 1,
				testCoverage: "partial",
				client: disagreement.client,
			});
			expect(gate.level).toBe("STRONG_REVIEW");
			expect(gate.floor).toBe("STRONG_REVIEW");
			expect(gate.source).toBe("floor");

			const invocations: BackendInvocation[] = [];
			const registry = new BackendRegistry(twoBackendConfig(repo.cwd), { onInvocation: (record) => invocations.push(record) });
			const scripted = scriptedRunner(verdictJson("PASS"));
			const outcome = await runReview(
				{
					cwd: repo.cwd,
					config: twoBackendConfig(repo.cwd),
					registry,
					verify: false,
					runner: scripted.runner,
					executor: { backend: "a", model: "exec-ma" },
					recordedLevel: () => gate.level,
				},
				"gate",
			);
			expect(scripted.calls[0]!.packet.role).toBe("review_strong");
			expect(outcome.role).toBe("review_strong");
			expect(invocations).toEqual([expect.objectContaining({ role: "review_strong", backend: "b" })]);
		} finally {
			await disagreement.close();
		}
	});

	it("AC-6 falls back to QUICK_REVIEW when JEV fails every call, and the session still gets a verdict", async () => {
		const gate = await classifyReview({ changedFiles: ["src/app.ts"], client: throwingJev() });
		expect(gate.level).toBe("QUICK_REVIEW");
		expect(gate.source).toBe("unavailable");
		expect(gate.fallbackUsed).toBe(true);

		const repo = reviewRepo();
		const scripted = scriptedRunner(verdictJson("PASS"));
		const outcome = await runReview(
			{ cwd: repo.cwd, config: twoBackendConfig(repo.cwd), verify: false, runner: scripted.runner, recordedLevel: () => gate.level },
			"gate",
		);
		expect(outcome.level).toBe("QUICK_REVIEW");
		expect(outcome.verdict.decision).toBe("PASS");
	});

	it("short-circuits an empty change without asking JEV at all", async () => {
		let asked = 0;
		const gate = await classifyReview({
			changedFiles: [],
			client: {
				ask: async () => {
					asked += 1;
					return [];
				},
			},
		});
		expect(gate.level).toBe("NO_SEMANTIC_REVIEW");
		expect(gate.source).toBe("floor");
		expect(asked).toBe(0);
	});

	it("lets the model raise the level but never lower a deterministic floor", async () => {
		const raise = await jevAnswering("STRONG_REVIEW");
		try {
			const gate = await classifyReview({ changedFiles: ["src/app.ts"], client: raise.client });
			expect(gate.level).toBe("STRONG_REVIEW");
			expect(gate.source).toBe("site");
		} finally {
			await raise.close();
		}

		// The model answers QUICK_REVIEW in both of these, and in both the floor holds.
		const lower = await jevAnswering("QUICK_REVIEW");
		try {
			const security = await classifyReview({
				changedFiles: ["src/auth/token.ts"],
				securitySensitivePaths: ["src/auth/token.ts"],
				failedAttempts: 2,
				client: lower.client,
			});
			expect(security.floor).toBe("STRONG_REVIEW");
			expect(security.level).toBe("STRONG_REVIEW");
			expect(security.source).toBe("floor");

			const publicApi = await classifyReview({ changedFiles: ["src/api/routes.ts"], publicApiChange: true, client: lower.client });
			expect(publicApi.floor).toBe("QUICK_REVIEW");
			expect(publicApi.level).toBe("QUICK_REVIEW");
		} finally {
			await lower.close();
		}
	});
});

describe("A1 — an unknown change set is not an empty change set", () => {
	it("does not short-circuit to NO_SEMANTIC_REVIEW when the change set could not be derived", async () => {
		// The worker reports no paths because git is unavailable, not because the
		// turn changed nothing. The gate must fall to its conservative answer.
		const gate = await classifyReview({ changedFiles: [], changedFilesUnknown: true });
		expect(gate.level).not.toBe("NO_SEMANTIC_REVIEW");
		expect(gate.level).toBe("QUICK_REVIEW");
		expect(gate.source).toBe("unavailable");

		// The genuine empty set still skips: the short-circuit is not removed.
		const empty = await classifyReview({ changedFiles: [] });
		expect(empty.level).toBe("NO_SEMANTIC_REVIEW");
	});
});
