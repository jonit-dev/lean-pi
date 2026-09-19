/**
 * Fixture runs for the telemetry suite (PRD-015 Phase 1).
 *
 * One fixture task drives the *real* turn entry point — `runTurn()` through
 * `runTurnWithTelemetry` — with the three inputs a live run would supply:
 * a compiled contract (PRD-004), a stub JEV endpoint for PRD-002's sites, and
 * the stub usage/report facts a backend (PRD-008), the tool layer and the retry
 * loop would report. Nothing here re-implements the record: it feeds the same
 * collector the production lanes feed.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearLanes, registerLane, type TurnContext } from "../../src/commands/session.js";
import { compileTask } from "../../src/compiler/index.js";
import { loadConfig } from "../../src/core/config.js";
import type { JevMode, LeanPiConfig } from "../../src/core/types.js";
import { createJevClient } from "../../src/jev/client.js";
import { readDecisions, type DecisionRow } from "../../src/jev/log.js";
import { ensureSite, type SiteFallback } from "../../src/jev/registry.js";
import type { ChoiceQuestion, Consequence, JevQuestion, NoulQuestion, QuestionKind, ScoreQuestion } from "../../src/jev/types.js";
import type { TaskPacket } from "../../src/scout/index.js";
import { createRunCollector, type RunCollector } from "../../src/telemetry/collect.js";
import { runTurnWithTelemetry } from "../../src/telemetry/emit.js";

/** The PRD path PRD-012's lane would report for the fixture request. */
export const FIXTURE_PRD = "docs/PRDs/v1/PRD-015-cost-telemetry.md";

export function fixtureCwd(): string {
	return mkdtempSync(join(tmpdir(), "leanpi-telemetry-"));
}

const PLAN_QUESTION: NoulQuestion = { id: "plan", kind: "Noul", text: "Does this task require a written plan?" };
const COMPLEXITY_QUESTION: ScoreQuestion = {
	id: "complexity",
	kind: "Score",
	text: "How complex is this task?",
	levels: ["LOW", "MEDIUM", "HIGH"],
};
const RISK_QUESTION: ChoiceQuestion = {
	id: "risk",
	kind: "Choice",
	text: "What review risk does this change carry?",
	options: { R0: null, R2: null },
};

interface FixtureSite {
	id: string;
	question: JevQuestion;
	consequence: Consequence;
	fallback: SiteFallback;
}

/**
 * Three sites, asked in this order. The first two are answered by the stub
 * endpoint; the third is refused (HTTP 500) so its deterministic fallback
 * decides — which is what makes the fallback-rate row real rather than staged.
 */
export const FIXTURE_SITES: readonly FixtureSite[] = [
	{
		id: "fixture.planning",
		question: PLAN_QUESTION,
		consequence: "normal",
		fallback: () => [{ kind: "Noul", questionId: "plan", value: 0, confidence: 1 }],
	},
	{
		id: "fixture.complexity",
		question: COMPLEXITY_QUESTION,
		consequence: "normal",
		fallback: () => [{ kind: "Score", questionId: "complexity", score: 1, legend: {}, confidence: 1 }],
	},
	{
		id: "fixture.review_risk",
		question: RISK_QUESTION,
		consequence: "normal",
		fallback: () => [{ kind: "Choice", questionId: "risk", choice: "R0", probabilities: {}, confidence: 1 }],
	},
];

export function registerFixtureSites(): void {
	for (const site of FIXTURE_SITES) {
		ensureSite({
			id: site.id,
			questions: [site.question],
			returnType: [site.question.kind as QuestionKind],
			consequence: site.consequence,
			fallback: site.fallback,
			telemetryTag: "fixture.telemetry",
		});
	}
}

export interface FixtureConfigOptions {
	jevUrl?: string;
	jevMode?: JevMode;
	/** `cost.quota_shadow_usd["scarce-premium"]`; 0 proves the field is a pass-through input. */
	shadowUsd?: number;
}

/**
 * A loaded config plus the two blocks PRD-015 declares. `cost:` is not parsed
 * by `src/core/config.ts` yet (PRD-001 owns that file), so the fixture injects
 * the block the module reads rather than re-declaring the rates elsewhere.
 */
export function fixtureConfig(cwd: string, options: FixtureConfigOptions = {}): LeanPiConfig {
	const base = loadConfig(cwd, {
		backends: {
			api: { type: "native", baseUrl: "http://127.0.0.1:9/v1", cost: { input: 3, output: 15, cacheRead: 0.3 } },
			codex: { type: "external_harness", vendor: "codex" },
		},
		models: {
			balanced: { backend: "api", model: "claude-sonnet-4" },
			review_quick: { backend: "codex", model: "gpt-5-codex" },
		},
	});
	return {
		...base,
		jev: { ...base.jev, mode: options.jevMode ?? "enabled", ...(options.jevUrl ? { endpoint: options.jevUrl } : {}), usd_per_mtok: 0.2 },
		cost: {
			local_usd_per_gpu_sec: 0.001,
			latency_usd_per_sec: 0,
			quota_shadow_usd: { "scarce-premium": options.shadowUsd ?? 0.05 },
		},
	} as unknown as LeanPiConfig;
}

const PACKET: TaskPacket = {
	repository: { languages: ["typescript"], project_type: "single", package_manager: "pnpm", dirty: false },
	task: { user_request: "Implement deterministic verification for the fixture task" },
	workspace: { changed_files: [], likely_modules: [], test_runners: ["vitest"], lsp_available: false, git_branch: "main" },
};

export interface FixtureRunOptions {
	cwd: string;
	taskId: string;
	sessionId: string;
	/** The verdict the proof gate reached (PRD-010); copied into the record verbatim. */
	success: boolean;
	config: LeanPiConfig;
}

export interface FixtureRun {
	collector: RunCollector;
	context: TurnContext;
	/** PRD-002's decision log for the run, as PRD-021 would read it. */
	decisions: DecisionRow[];
}

/**
 * Run one fixture task and emit its record. Usage, counters and decisions are
 * reported into a fresh `RunCollector`, then the turn's record is written by
 * `runTurnWithTelemetry` after the entry point returns.
 */
export async function runFixtureTask(options: FixtureRunOptions): Promise<FixtureRun> {
	const { cwd, config } = options;
	const collector = createRunCollector({ taskId: options.taskId, sessionId: options.sessionId });
	// The lane registry is process-scoped state, like a booted session's.
	clearLanes();
	const jev = createJevClient({
		config,
		cwd,
		credential: () => ({ key: "sk-fixture", source: "env" }),
	});

	registerLane({
		name: "fixture.executor",
		async run(turn, context) {
			const contract = await compileTask(turn.text, PACKET);
			// PRD-005's provider fills the disclosed slots during the compile; with no
			// provider registered the fixture stands in for it.
			context.contract = {
				...contract,
				capabilities: {
					...contract.capabilities,
					skills: [{ name: "ponytail", source: "user", body: "# Ponytail" }],
					mcps: [{ name: "mcp-fixture" }],
				},
			};

			// PRD-008's workers report their calls back (executor then reviewer).
			collector.add({
				backend: "api",
				model: "claude-sonnet-4",
				type: "native",
				role: "balanced",
				billing: "metered",
				quotaClass: "scarce-premium",
				usage: { inputTokens: 10_000, cachedInputTokens: 20_000, outputTokens: 2_000 },
			});
			collector.add({
				backend: "codex",
				model: "gpt-5-codex",
				type: "external_harness",
				role: "review_quick",
				quotaClass: "premium",
				usage: { subscriptionUsage: 1 },
			});
			collector.addLocalGpuSeconds(10);
			collector.addWallMs(1200);

			// The executor's tool layer, the retry loop and the context engine.
			collector.noteToolCall(4);
			collector.noteFileRead("src/a.ts");
			collector.noteFileRead("src/a.ts");
			collector.noteFileRead("src/b.ts");
			collector.noteRetry(1);
			collector.noteCompaction(1);
			collector.useSkill("ponytail");
			collector.useMcp("mcp-fixture");

			// PRD-002 reports each resolved decision; the collector projects the row.
			for (const site of FIXTURE_SITES) {
				await jev.ask(site.id, [site.question], { task: turn.text });
				const row = readDecisions(cwd).at(-1);
				if (row) collector.recordJevDecision(row);
			}
		},
	});

	const context = await runTurnWithTelemetry(
		{ text: "Implement deterministic verification for the fixture task" },
		{ config, cwd },
		{
			collector,
			prdUsed: FIXTURE_PRD,
			verdict: {
				verification: options.success ? "pass" : "fail",
				proof_gate: options.success ? "pass" : "fail",
				reviewer: options.success ? "pass" : "fail",
				success: options.success,
			},
		},
	);

	return { collector, context, decisions: readDecisions(cwd) };
}
