/**
 * Deterministic compaction with preservation invariants (PRD-014 Phase 4,
 * FR-107).
 *
 * Reduction is reference substitution, never summarization: every removed block
 * leaves an `artifact://` ref that still expands to the original bytes. The
 * preservation set — original user requirement, every acceptance criterion,
 * every active error — is copied into the retained context before any reduction
 * runs, so preservation is structural and cannot be forgotten by a rule added
 * later.
 */
import type { JevClient } from "../jev/client.js";
import { accept } from "../jev/confidence.js";
import { ensureSite } from "../jev/registry.js";
import type { JevQuestion, JevResult } from "../jev/types.js";
import type { ArtifactStore } from "./artifacts.js";
import type { WorkingState } from "./working-state.js";

export const RETENTION_SITE_ID = "context.retention_relevance";

export type ItemKind = "requirement" | "criterion" | "error" | "tool_result" | "evidence";

export interface ContextItem {
	id: string;
	kind: ItemKind;
	summary: string;
	/** The full text, when this item is still inline. */
	body?: string;
	bytes?: number;
	/** `artifact://` ref of this item's bytes, when it has one. */
	artifact?: string;
	/** sha256 of the body, for duplicate-read collapsing. */
	contentHash?: string;
	/** Identifies the producing call, for superseded-result reduction. */
	sourceRef?: string;
	/** Workspace state the item was produced against (evidence only). */
	workspaceHash?: string;
	/** True when a newer item from the same sourceRef supersedes this one. */
	superseded?: boolean;
	/** True when the current `WorkingState` still cites this item. */
	referenced?: boolean;
	/** Errors only: still open. */
	active?: boolean;
}

export type Verdict = "keep" | "drop";

export interface Decision {
	id: string;
	verdict: Verdict;
	source: "preservation" | "rule" | "jev" | "fallback";
	reason: string;
}

export interface CompactResult {
	kept: ContextItem[];
	/** Items replaced by a pointer; their bytes are in the store. */
	reduced: ContextItem[];
	dropped: ContextItem[];
	/** Candidates the deterministic rules refuse to settle. */
	undecided: ContextItem[];
	decisions: Decision[];
	/** `ask()` calls actually issued. */
	askCount: number;
}

export interface CompactOptions {
	artifacts: ArtifactStore;
	/** Hash of the workspace right now; evidence records carry the hash they were made against. */
	currentWorkspaceHash: string;
	workingState?: WorkingState;
	client?: Pick<JevClient, "ask" | "fallbackCount"> & Partial<Pick<JevClient, "getMode">>;
	/** Explicit switch: compaction is never blocked on JEV, and never asks when it is off. */
	jevEnabled?: boolean;
	budgetBytes?: number;
}

export const RETENTION_QUESTIONS: JevQuestion[] = [
	{
		id: "retain",
		kind: "Choice",
		text: "Should this item be retained in the active context?",
		options: { keep: "still relevant to the active task", drop: "superseded and no longer needed" },
	},
];

/** Registered once per process; the fallback keeps, which is the safe direction. */
export function registerRetentionSite(): void {
	ensureSite({
		id: RETENTION_SITE_ID,
		questions: RETENTION_QUESTIONS,
		returnType: ["Choice"],
		consequence: "normal",
		telemetryTag: RETENTION_SITE_ID,
		fallback: ({ questions }): JevResult[] =>
			questions.map((question): JevResult => ({ kind: "Choice", questionId: question.id, choice: "keep", probabilities: {}, confidence: 1 })),
	});
}

function isPreserved(item: ContextItem): boolean {
	if (item.kind === "requirement" || item.kind === "criterion") return true;
	return item.kind === "error" && item.active !== false;
}

/**
 * Three classes settle by rule and stop; the fourth — stale evidence the current
 * working state still references — is the deliberate JEV input.
 */
export function classifyCandidates(
	items: ContextItem[],
	currentWorkspaceHash: string,
): {
	preserved: ContextItem[];
	/** Items no rule touches: they stay inline, which is the default. */
	settled: ContextItem[];
	superseeded: ContextItem[];
	duplicates: ContextItem[];
	stale: ContextItem[];
	undecided: ContextItem[];
} {
	const preserved: ContextItem[] = [];
	const settled: ContextItem[] = [];
	const superseeded: ContextItem[] = [];
	const duplicates: ContextItem[] = [];
	const stale: ContextItem[] = [];
	const undecided: ContextItem[] = [];

	const seenHashes = new Set<string>();
	const newestBySource = new Map<string, string>();
	for (const item of items) {
		if (item.sourceRef && !item.superseded) newestBySource.set(item.sourceRef, item.id);
	}

	for (const item of items) {
		if (isPreserved(item)) {
			preserved.push(item);
			continue;
		}
		const supersededByNewer =
			item.superseded === true ||
			(item.sourceRef !== undefined && item.kind === "tool_result" && newestBySource.get(item.sourceRef) !== item.id);
		if (supersededByNewer) {
			superseeded.push(item);
			continue;
		}
		if (item.contentHash) {
			if (seenHashes.has(item.contentHash)) {
				duplicates.push(item);
				continue;
			}
			seenHashes.add(item.contentHash);
		}
		if (item.kind === "evidence" && item.workspaceHash && item.workspaceHash !== currentWorkspaceHash) {
			if (item.referenced) undecided.push(item);
			else stale.push(item);
			continue;
		}
		settled.push(item);
	}

	return { preserved, settled, superseeded, duplicates, stale, undecided };
}

/** Replace an item with a pointer to its bytes; the bytes are stored first. */
function reduceToRef(item: ContextItem, artifacts: ArtifactStore): ContextItem {
	const bytes = item.body ?? item.summary;
	const ref = item.artifact ?? artifacts.store(bytes, "context", item.sourceRef ?? item.id);
	const summary = item.summary;
	return { ...item, artifact: ref, body: undefined, bytes: Buffer.byteLength(`${summary}\n[full output: ${ref}]`, "utf8"), summary: `${summary}\n[full output: ${ref}]` };
}

export async function compact(items: ContextItem[], options: CompactOptions): Promise<CompactResult> {
	registerRetentionSite();
	const groups = classifyCandidates(items, options.currentWorkspaceHash);
	const decisions: Decision[] = [];
	const kept: ContextItem[] = [];
	const reduced: ContextItem[] = [];
	const dropped: ContextItem[] = [];

	for (const item of groups.preserved) {
		kept.push(item);
		decisions.push({ id: item.id, verdict: "keep", source: "preservation", reason: `${item.kind} is in the preservation set` });
	}
	for (const item of groups.settled) {
		kept.push(item);
		decisions.push({ id: item.id, verdict: "keep", source: "rule", reason: "no reduction rule applies" });
	}
	for (const item of groups.stale) {
		dropped.push(item);
		decisions.push({ id: item.id, verdict: "drop", source: "rule", reason: "stale workspaceHash and unreferenced" });
	}
	for (const item of [...groups.superseeded, ...groups.duplicates]) {
		reduced.push(reduceToRef(item, options.artifacts));
		decisions.push({ id: item.id, verdict: "drop", source: "rule", reason: "reduced to its artifact reference" });
	}

	const client = options.client;
	const jevEnabled = options.jevEnabled ?? (client?.getMode !== undefined && client.getMode() !== "disabled");
	let askCount = 0;
	let verdicts = new Map<string, Verdict>();
	if (groups.undecided.length > 0) {
		if (client && jevEnabled) {
			askCount = 1;
			const before = client.fallbackCount();
			let results: JevResult[] | undefined;
			try {
				results = await client.ask(
					RETENTION_SITE_ID,
					groups.undecided.map((item) => ({ ...RETENTION_QUESTIONS[0]!, id: item.id })),
					{ items: groups.undecided.map((item) => item.summary), workingState: options.workingState ?? null },
				);
			} catch {
				results = undefined;
			}
			const answered = results;
			const fellBack = !answered || client.fallbackCount() > before || !answered.every((result) => accept(result, "normal"));
			verdicts = fellBack
				? new Map(groups.undecided.map((item) => [item.id, "keep" as Verdict]))
				: new Map((answered as JevResult[]).map((result) => [result.questionId, result.kind === "Choice" && result.choice === "drop" ? ("drop" as Verdict) : ("keep" as Verdict)]));
		} else {
			verdicts = new Map(groups.undecided.map((item) => [item.id, "keep" as Verdict]));
		}
	}

	for (const item of groups.undecided) {
		const verdict = verdicts.get(item.id) ?? "keep";
		const source: Decision["source"] = askCount > 0 ? "jev" : "fallback";
		if (verdict === "keep") {
			kept.push(item);
			decisions.push({ id: item.id, verdict, source, reason: "retention verdict" });
		} else {
			dropped.push(reduceToRef(item, options.artifacts));
			decisions.push({ id: item.id, verdict, source, reason: "retention verdict" });
		}
	}

	return { kept, reduced, dropped, undecided: groups.undecided, decisions, askCount };
}
