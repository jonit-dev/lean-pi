/**
 * `/review` — the manual reviewer lane (PRD-011 Phase 1, ROADMAP §46).
 *
 * Modes map to `(ReviewLevel, prompt profile)` pairs. Manual invocation bypasses
 * the gate on purpose: a `NO_SEMANTIC_REVIEW` classification never blocks a user
 * who asked for a review, so `/review` with no mode reuses the level the gate
 * recorded for the turn when there is one and falls back to `QUICK_REVIEW`
 * otherwise. `/review diff` reviews the diff alone and runs no verification.
 *
 * `runReview()` is the programmatic entry (`session.review()`); the command is a
 * thin rendering of the same call, so the terminal and the API cannot disagree.
 * The only state either writes is `ReviewState`, through the injected `TaskState`.
 */
import { BackendRegistry, type HarnessSpawn } from "../backends/index.js";
import type { CommandContext, CommandHandler, CommandRegistry, CommandResult } from "../commands/registry.js";
import type { ExecutionContract } from "../compiler/contract.js";
import type { TaskState } from "../compiler/state.js";
import type { ArtifactStore } from "../context/artifacts.js";
import type { LeanPiConfig, SelectedSkill } from "../core/types.js";
import type { EvidenceRecord, EvidenceStore } from "../verify/evidence.js";
import { verifyTask } from "../verify/index.js";
import type { ShellExec } from "../verify/run.js";
import { REVIEW_MODE_LEVELS, REVIEW_MODES, isReviewMode, review, type ReviewMode, type ReviewOutcome, type ReviewRunner } from "./lane.js";
import { acceptanceCriteriaOf, buildPacket } from "./packet.js";
import type { ActiveReviewLevel, ReviewLevel } from "./schema.js";

export interface ReviewCommandDeps {
	cwd: string;
	config: LeanPiConfig;
	/** Reused across calls when supplied; built from `config` otherwise. */
	registry?: BackendRegistry;
	artifacts?: ArtifactStore;
	/** The compiled §8 contract: objective, acceptance criteria and the verifier set. */
	contract?: ExecutionContract;
	evidence?: readonly EvidenceRecord[];
	warnings?: readonly string[];
	executorSummary?: string;
	/** The executor's binding, so the lane can establish reviewer independence (§31). */
	executor?: { backend: string; model: string };
	/** The level `classifyReview()` recorded for this turn, if any. */
	recordedLevel?: () => ReviewLevel | undefined;
	/** `false` keeps `/review` read-only; otherwise a contract means verification runs for non-`diff` modes. */
	verify?: boolean;
	exec?: ShellExec;
	store?: EvidenceStore;
	/** The turn's task state. Only its `review` container is written. */
	state?: TaskState;
	runner?: ReviewRunner;
	spawn?: HarnessSpawn;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	now?: () => number;
	/** A review skill matched for the mode (PRD-005); replaces the inline profile text. */
	skill?: SelectedSkill;
	inlineDiffBytes?: number;
}

/** The active level for a mode; `gate` reuses the recorded level, which manual invocation never skips. */
function levelFor(deps: ReviewCommandDeps, mode: ReviewMode): ActiveReviewLevel {
	if (mode !== "gate") return REVIEW_MODE_LEVELS[mode];
	const recorded = deps.recordedLevel?.();
	return recorded === "STRONG_REVIEW" || recorded === "QUICK_REVIEW" ? recorded : REVIEW_MODE_LEVELS.gate;
}

/**
 * Verification evidence for the packet. `/review diff` runs nothing (by
 * definition it reviews the diff alone); every other mode runs the contract's
 * verifier set through PRD-009 unless the caller opted out, and the run's own
 * records are what the reviewer sees.
 */
async function collectEvidence(deps: ReviewCommandDeps): Promise<readonly EvidenceRecord[]> {
	if (deps.verify === false || !deps.contract) return deps.evidence ?? [];
	const result = await verifyTask(deps.contract, deps.cwd, {
		...(deps.store ? { store: deps.store } : {}),
		...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
		...(deps.exec ? { exec: deps.exec } : {}),
	});
	return result.records;
}

/** The programmatic review: build the §30 packet, run the lane, record the verdict. */
export async function runReview(deps: ReviewCommandDeps, mode: ReviewMode = "gate"): Promise<ReviewOutcome> {
	const level = levelFor(deps, mode);
	const evidence = mode === "diff" ? [] : await collectEvidence(deps);
	const contract = deps.contract;
	const { packet } = buildPacket({
		objective: contract?.task.user_request ?? "review the current change",
		acceptanceCriteria: contract ? acceptanceCriteriaOf(contract) : [],
		cwd: deps.cwd,
		evidence,
		warnings: deps.warnings ?? [],
		executorSummary: deps.executorSummary ?? "",
		...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
		...(deps.inlineDiffBytes === undefined ? {} : { inlineDiffBytes: deps.inlineDiffBytes }),
	});

	const outcome = await review(packet, level, mode, {
		registry: deps.registry ?? new BackendRegistry(deps.config),
		cwd: deps.cwd,
		...(deps.executor ? { executor: deps.executor } : {}),
		...(deps.runner ? { runner: deps.runner } : {}),
		...(deps.spawn ? { spawn: deps.spawn } : {}),
		...(deps.env ? { env: deps.env } : {}),
		...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
		...(deps.now ? { now: deps.now } : {}),
		...(deps.skill ? { skill: deps.skill } : {}),
	});

	// `ReviewState` only: the executor's attempt counter and the planning record
	// are not the reviewer's to rewrite.
	deps.state?.recordReview(outcome.verdict.decision);
	return outcome;
}

/** The verdict as the session prints it; the first line is the one a test or a user reads. */
export function renderReview(outcome: ReviewOutcome): string {
	const binding = outcome.backend ? `, ${outcome.backend}/${outcome.model ?? "?"}` : "";
	const lines = [
		`/review ${outcome.mode}: ${outcome.verdict.decision} (${outcome.level}, ${outcome.reviewerClass}, ${outcome.independence}${binding})`,
	];
	if (outcome.reason) lines.push(`reason: ${outcome.reason}`);
	for (const finding of outcome.verdict.findings) {
		lines.push(`- [${finding.severity}] ${finding.criterion} ${finding.file}:${finding.location} — ${finding.evidence}`);
	}
	if (outcome.escalation) {
		const target = outcome.escalation.kind === "stronger_reviewer" ? `stronger_reviewer ${outcome.escalation.role}` : "executor";
		lines.push(`escalate to ${target}: ${outcome.escalation.reason}`);
	}
	return lines.join("\n");
}

/** What the registered command produced, so a caller can read the typed verdict behind the text. */
export interface ReviewCommandRegistration {
	/** Every verdict this registration produced, in order — the record AC-2 asserts on. */
	reviews: ReviewOutcome[];
	last(): ReviewOutcome | undefined;
}

/** Register `/review` in the session's command registry (PRD-002's registry, extended here). */
export function registerReviewCommand(commands: CommandRegistry, deps: ReviewCommandDeps): ReviewCommandRegistration {
	const reviews: ReviewOutcome[] = [];
	const handler: CommandHandler = async (args: string, _context: CommandContext): Promise<CommandResult> => {
		const requested = args.trim().split(/\s+/)[0] ?? "";
		const mode = requested.length === 0 ? "gate" : requested;
		if (!isReviewMode(mode)) {
			return { ok: false, text: `unknown /review mode "${mode}" — use ${REVIEW_MODES.filter((entry) => entry !== "gate").join(" | ")} or no argument` };
		}
		try {
			const outcome = await runReview(deps, mode);
			reviews.push(outcome);
			return { ok: true, text: renderReview(outcome) };
		} catch (error) {
			// A user-invoked command reports its own failure; it never unwinds a session.
			return { ok: false, text: `review failed: ${error instanceof Error ? error.message : String(error)}` };
		}
	};
	commands.register("review", handler);
	return { reviews, last: () => reviews[reviews.length - 1] };
}
