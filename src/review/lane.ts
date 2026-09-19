/**
 * The reviewer lane (PRD-011 Phase 1, ROADMAP §30/§31).
 *
 * `review()` is the whole lane: pick a backend for the reviewer, invoke it
 * through PRD-008's worker, parse its output into a §30 verdict. It is
 * intentionally independent of the executor lane — the reviewer is a different
 * role (`review_quick` / `review_strong`), it receives the packet built by
 * `buildPacket()` and never the executor's conversation, and it touches no
 * `TaskState`. Escalation is *returned* (`ReviewEscalation`); only the caller
 * records a verdict or hands findings back to the executor, so a review can
 * never rewrite the execution record it is judging.
 *
 * Independence is a fact the lane records, not a claim it makes: when the
 * configured pool cannot offer a model identity different from the executor's,
 * the review still happens and says `degraded` with the reason (§31 prefers an
 * imperfect independent review to no review at all).
 */
import {
	BackendRegistry,
	isWorkerFailure,
	modelFor,
	runHarness,
	runNative,
	type HarnessSpawn,
	type RegisteredBackend,
	type WorkerOutcome,
	type WorkerTaskPacket,
} from "../backends/index.js";
import { ROLE_FALLBACK_CHAINS } from "../core/roles.js";
import type { LeanPiConfig, ModelRole, SelectedSkill } from "../core/types.js";
import { renderReviewPrompt, type ReviewProfile } from "./packet.js";
import {
	escalateVerdict,
	parseVerdict,
	reviewerRoleOf,
	type ActiveReviewLevel,
	type ReviewerRole,
	type ReviewPacket,
	type ReviewVerdict,
} from "./schema.js";

/** `/review`'s modes plus the automatic `gate` call PRD-007 makes. */
export const REVIEW_MODES = ["gate", "quick", "strong", "security", "diff"] as const;

export type ReviewMode = (typeof REVIEW_MODES)[number];

export function isReviewMode(value: string): value is ReviewMode {
	return (REVIEW_MODES as readonly string[]).includes(value);
}

/** Modes map to `(ReviewLevel, prompt profile)` pairs; `gate` reuses the quick profile. */
export const REVIEW_MODE_LEVELS: Record<ReviewMode, ActiveReviewLevel> = {
	gate: "QUICK_REVIEW",
	quick: "QUICK_REVIEW",
	strong: "STRONG_REVIEW",
	security: "STRONG_REVIEW",
	diff: "QUICK_REVIEW",
};

export function reviewProfileOf(mode: ReviewMode): ReviewProfile {
	return mode === "gate" ? "quick" : mode;
}

/** The reviewer's verdict must differ from the executor's model identity when the pool allows it. */
export type Independence = "independent" | "degraded";

/** Where a verdict sends the turn next. The lane never acts on it — the consumer does. */
export type ReviewEscalation =
	| { kind: "executor"; reason: string }
	| { kind: "stronger_reviewer"; role: "review_strong"; reason: string }
	| null;

export interface ReviewDeps {
	/** PRD-008's pool, parsed from `LeanPiConfig.backends`. */
	registry: BackendRegistry;
	cwd: string;
	agentDir?: string;
	/**
	 * The parsed configuration, so the reviewer's model resolves through the same
	 * `models:` ladder `/models` uses. Without it the registry's role map is all
	 * the lane has, which is what a caller that already holds a pool passes.
	 */
	config?: LeanPiConfig;
	/** The executor's own binding, so the lane can compare identities (§31). */
	executor?: { backend: string; model: string | null };
	/** Test seam: replaces the PRD-008 invocation with a scripted worker outcome. */
	runner?: ReviewRunner;
	spawn?: HarnessSpawn;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	now?: () => number;
	/** A review skill matched for the mode (PRD-005); replaces the inline profile text. */
	skill?: SelectedSkill;
}

export type ReviewRunner = (packet: WorkerTaskPacket, backend: RegisteredBackend, deps: ReviewDeps) => Promise<WorkerOutcome>;

const defaultRunner: ReviewRunner = (packet, backend, deps) =>
	backend.type === "external_harness"
		? runHarness(backend, packet, {
				cwd: deps.cwd,
				...(deps.spawn ? { spawn: deps.spawn } : {}),
				...(deps.env ? { env: deps.env } : {}),
				...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
			})
		: runNative(backend, packet, { cwd: deps.cwd, ...(deps.agentDir ? { agentDir: deps.agentDir } : {}) });

export interface ReviewOutcome {
	/** The §30 verdict: `PASS`, `FIX_REQUIRED` or `ESCALATE`. A backend failure is `ESCALATE`, never `PASS`. */
	verdict: ReviewVerdict;
	level: ActiveReviewLevel;
	mode: ReviewMode;
	/** The contract's `reviewer_class` for this level — the role the worker ran under. */
	reviewerClass: ReviewerRole;
	role: ModelRole;
	backend: string | null;
	model: string | null;
	independence: Independence;
	/** Why independence is degraded, or why the reviewer could not answer. */
	reason?: string;
	escalation: ReviewEscalation;
	/** The exact request the reviewer received: the seven §30 keys, and nothing from the transcript. */
	packet: ReviewPacket;
	prompt: string;
}

/** What one backend's reviewer would be, plus whether it differs from the executor's. */
interface ReviewerChoice {
	backend: RegisteredBackend;
	model: string | null;
	independence: Independence;
	reason?: string;
}

/** The executor identity the reviewer is compared against, `${backend}/${model}`. */
function identityOf(backend: string, model: string | null): string {
	return `${backend}/${model ?? ""}`;
}

/**
 * The model the reviewer runs under on this backend. `/models` resolves a role
 * through the §27 ladder, so dispatch does too: the first role in
 * `ROLE_FALLBACK_CHAINS[role]` whose `models:` entry names this backend is the
 * one that binds it. Nothing else does — a role and backend nothing names stays
 * `null` and the worker reports its typed failure rather than a made-up id.
 */
function reviewerModel(backend: RegisteredBackend, role: ReviewerRole, config: LeanPiConfig | undefined): string | null {
	if (config) {
		for (const candidate of ROLE_FALLBACK_CHAINS[role]) {
			const entry = config.models[candidate];
			if (entry?.backend === backend.name) return entry.model;
		}
	}
	// No config, or nothing in the ladder binds this backend: the registry's own
	// role map is all that is left, exactly as dispatch resolved it before.
	return modelFor(backend, role);
}

function selectReviewer(registry: BackendRegistry, role: ReviewerRole, deps: ReviewDeps): ReviewerChoice | null {
	const candidates = registry.selectBackend(role);
	if (candidates.length === 0) return null;
	const modelOf = (backend: RegisteredBackend): string | null => reviewerModel(backend, role, deps.config);

	if (!deps.executor) {
		// No executor identity was recorded for this turn, so independence is not a
		// fact the lane can assert — it says so instead of guessing.
		const first = candidates[0]!;
		return {
			backend: first,
			model: modelOf(first),
			independence: "degraded",
			reason: "the executor's model identity was not recorded for this turn",
		};
	}

	const executorIdentity = identityOf(deps.executor.backend, deps.executor.model);
	for (const backend of candidates) {
		const model = modelOf(backend);
		if (identityOf(backend.name, model) !== executorIdentity) {
			return { backend, model, independence: "independent", reason: `reviewer ${backend.name}/${model ?? "?"} differs from executor ${executorIdentity}` };
		}
	}

	const first = candidates[0]!;
	return {
		backend: first,
		model: modelOf(first),
		independence: "degraded",
		reason: `every backend serving ${role} shares the executor's model identity ${executorIdentity}`,
	};
}

function escalationFor(verdict: ReviewVerdict, level: ActiveReviewLevel): ReviewEscalation {
	if (verdict.decision === "FIX_REQUIRED") {
		return { kind: "executor", reason: `${verdict.findings.length} finding(s) must be fixed before the change can pass` };
	}
	if (verdict.decision === "ESCALATE") {
		return level === "QUICK_REVIEW"
			? { kind: "stronger_reviewer", role: "review_strong", reason: "the quick review could not decide on this change" }
			: { kind: "executor", reason: "the strong review escalated; the executor lane decides the next attempt" };
	}
	return null;
}

/**
 * Review `packet` at `level`, in `mode`. Never throws for a backend or reviewer
 * failure: an unusable reviewer is reported as `ESCALATE` carrying the reason, so
 * the caller can escalate instead of mistaking silence for a pass.
 */
export async function review(
	packet: ReviewPacket,
	level: ActiveReviewLevel,
	mode: ReviewMode,
	deps: ReviewDeps,
): Promise<ReviewOutcome> {
	const role = reviewerRoleOf(level);
	const profile = reviewProfileOf(mode);
	const prompt = renderReviewPrompt(packet, level, profile, deps.skill);
	const base = { level, mode, reviewerClass: role, role, packet, prompt } as const;

	const choice = selectReviewer(deps.registry, role, deps);
	if (!choice) {
		const reason = `no enabled backend serves reviewer role "${role}"`;
		const verdict = escalateVerdict(reason);
		return {
			...base,
			verdict,
			backend: null,
			model: null,
			independence: "degraded",
			reason,
			escalation: escalationFor(verdict, level),
		};
	}

	const workerPacket: WorkerTaskPacket = {
		objective: `Review the change against its acceptance criteria at ${level}.`,
		role,
		prompt,
		// A review is bounded by the packet it received: no tools, one turn.
		allowedTools: [],
		budget: 1,
		...(choice.model ? { model: choice.model } : {}),
	};

	const now = deps.now ?? Date.now;
	const started = now();
	const outcome = await (deps.runner ?? defaultRunner)(workerPacket, choice.backend, deps);
	const raw = (outcome.status === "failed" ? undefined : outcome.raw) as { exitCode?: number; tokens?: number } | undefined;
	deps.registry.record({
		backend: choice.backend.name,
		billing: choice.backend.billing,
		...(choice.backend.quotaClass ? { quotaClass: choice.backend.quotaClass } : {}),
		...(choice.backend.catalogModelId ? { catalogModelId: choice.backend.catalogModelId } : {}),
		role,
		wallMs: now() - started,
		exitCode: isWorkerFailure(outcome) ? outcome.exitCode ?? null : raw?.exitCode ?? 0,
		...(isWorkerFailure(outcome) && outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
	});

	if (isWorkerFailure(outcome) || outcome.status === "blocked") {
		const reason = isWorkerFailure(outcome)
			? `reviewer backend ${choice.backend.name} failed (${outcome.failure}): ${outcome.reason}`
			: `reviewer backend ${choice.backend.name} blocked: ${outcome.summary}`;
		const verdict = escalateVerdict(reason);
		return {
			...base,
			verdict,
			backend: choice.backend.name,
			model: choice.model,
			independence: choice.independence,
			reason,
			escalation: escalationFor(verdict, level),
		};
	}

	const verdict = parseVerdict(outcome.summary);
	return {
		...base,
		verdict,
		backend: choice.backend.name,
		model: choice.model,
		independence: choice.independence,
		...(choice.reason ? { reason: choice.reason } : {}),
		escalation: escalationFor(verdict, level),
	};
}
