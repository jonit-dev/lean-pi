/**
 * `/context` and `/compact` — the context surface over PRD-014 (PRD-016 Phase 4, FR-148).
 *
 * `/context` groups the prompt into §22's layers with a token count per layer.
 * Those counts are LeanPi's own bytes/4 estimate over the session *it* can
 * read, which is not the session Pi bills: the measured figure only exists when
 * Pi's TUI handed us `context.session`, so the report prints the two separately
 * and never adds them into one authoritative-looking total. `/compact` runs
 * PRD-014's deterministic compactor (reference substitution, never
 * summarization) and writes the result through Pi's own compaction entry, so
 * the session store stays Pi's and the discarded bytes stay addressable at
 * their `artifact://` refs. It refuses rather than reporting a no-op when
 * nothing is reducible.
 */
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens, getLatestCompactionEntry } from "@earendil-works/pi-coding-agent";
import { createArtifactStore, sha256 } from "../context/artifacts.js";
import { compact, type ContextItem } from "../context/compaction.js";
import { buildWorkingState, stubSources, WORKING_STATE_MAX_BYTES } from "../context/working-state.js";
import { buildStaticPrefix } from "../core/instructions/prefix.js";
import type { CommandContext, CommandRegistry, CommandResult } from "./registry.js";
import { estimateTextTokens, type CommandSurface } from "./surface.js";

export interface ContextSection {
	name: string;
	tokens: number;
}

export interface ContextReport {
	sections: ContextSection[];
	/** The sections summed: LeanPi's own estimate, never a measurement. */
	estimate: number;
	/** Pi's measured usage, or `null` when the caller was not a Pi command invocation. */
	actual: { tokens: number | null; window: number } | null;
	/** `artifact://` refs cited in the resolved context. */
	refs: string[];
	/** Share of the estimate that is a reference rather than bytes. */
	artifactShare: number;
}

/** Every text part of one message: the same bytes the model sees, nothing else. */
export function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const value = part as { type?: string; text?: string; thinking?: string; name?: string };
			if (typeof value.text === "string") return value.text;
			if (typeof value.thinking === "string") return value.thinking;
			if (value.type === "toolCall" && typeof value.name === "string") return `tool call: ${value.name}`;
			return "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

/** Read-only accounting: no section here recomputes a value another module owns. */
export function contextReport(surface: CommandSurface, session?: CommandContext["session"]): ContextReport {
	const messages = surface.host.current().buildSessionContext().messages;
	const toolTokens = messages.reduce((sum, message) => (message.role === "toolResult" ? sum + estimateTokens(message) : sum), 0);
	const contextTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	const contextText = messages.map(messageText).join("\n");
	const refs = [...new Set(contextText.match(/artifact:\/\/[^\s)\]]+/g) ?? [])];
	const refTokens = estimateTextTokens(refs.join("\n"));

	// No working-state row: the only working state reachable from here is built
	// from `stubSources()`, so its size measures a placeholder rather than
	// anything a model was ever sent.
	const sections: ContextSection[] = [
		{ name: "static prefix", tokens: estimateTextTokens(buildStaticPrefix(surface.config)) },
		{ name: "artifact references", tokens: refTokens },
		{ name: "live tool output", tokens: toolTokens },
		// The remainder is history by construction, so the sections always sum to the estimate.
		{ name: "message history", tokens: Math.max(0, contextTokens - toolTokens - refTokens) },
	];
	const estimate = sections.reduce((sum, section) => sum + section.tokens, 0);
	return {
		sections,
		estimate,
		actual: session ? { tokens: session.contextTokens, window: session.contextWindow } : null,
		refs,
		artifactShare: estimate === 0 ? 0 : refTokens / estimate,
	};
}

/** Pi's figure and LeanPi's stay on separate lines: only one of them is measured. */
function measuredLine(actual: ContextReport["actual"]): string {
	if (actual === null) return "pi context usage: unavailable (this call did not come from a Pi session)";
	if (actual.tokens === null) return `pi context usage: not yet reported (window ${actual.window} tokens)`;
	return `pi context usage: ${actual.tokens} of ${actual.window} tokens`;
}

export function renderContextReport(report: ContextReport): string {
	return [
		"leanpi estimate (bytes/4), by layer:",
		...report.sections.map((section) => `  ${section.name.padEnd(20)} ${section.tokens} tokens`),
		`  ${"estimated total".padEnd(20)} ${report.estimate} tokens`,
		measuredLine(report.actual),
		`artifact-backed share of the estimate: ${(report.artifactShare * 100).toFixed(1)}% (${report.refs.length} ref${report.refs.length === 1 ? "" : "s"})`,
	].join("\n");
}

/** One context item per resolved message; tool output is the reducible class. */
function contextItems(messages: readonly AgentMessage[]): ContextItem[] {
	return messages.map((message, index) => {
		const role = (message as { role?: string }).role ?? "unknown";
		const text = messageText(message);
		const callId = (message as { toolCallId?: string }).toolCallId;
		const summary = text.length > 0 ? text.slice(0, 160) : `${role} message`;
		return {
			id: callId ?? `m${index}`,
			kind: role === "toolResult" ? ("tool_result" as const) : ("requirement" as const),
			summary,
			body: text,
			bytes: Buffer.byteLength(text, "utf8"),
			...(callId ? { sourceRef: callId } : {}),
			contentHash: text.length > 0 ? sha256(text) : undefined,
		};
	});
}

export function registerContextCommands(registry: CommandRegistry, surface: CommandSurface): void {
	registry.register({
		name: "context",
		summary: "break the context into layers and show Pi's measured usage against LeanPi's estimate",
		usage: "/context",
		run: (_args, context): CommandResult => ({ ok: true, text: renderContextReport(contextReport(surface, context.session)) }),
	});

	registry.register({
		// Not `compact`: Pi ships that name for model-driven compaction and resolves
		// an extension's command first, so taking it would delete Pi's.
		name: "compact-refs",
		summary: "compact the context deterministically — repeated blocks become artifact:// refs, no model is called",
		usage: "/compact-refs",
		run: async (_args, context): Promise<CommandResult> => {
			const manager = surface.host.current();
			// Pi's compaction entry summarizes everything before `firstKeptEntryId` and
			// keeps that entry (and its descendants) verbatim. The item set is therefore
			// the live path *before* the entry that will be kept — never the tail the
			// summary would duplicate, and never messages a previous compaction already
			// replaced (its summary is carried forward as a preserved item instead).
			const branch = manager.getBranch();
			const previous = getLatestCompactionEntry(branch);
			const keptFrom = previous === null ? 0 : branch.findIndex((entry) => entry.id === previous.firstKeptEntryId);
			const live = branch.slice(keptFrom === -1 ? branch.length - 1 : keptFrom).filter((entry) => entry.type === "message");
			const keptEntry = live[live.length - 1];
			if (keptEntry === undefined) {
				return { ok: false, text: "nothing to compact: the session has no entries to reduce" };
			}
			const carried: ContextItem[] =
				previous === null
					? []
					: [
							{
								id: previous.id,
								kind: "requirement",
								summary: previous.summary.slice(0, 160),
								body: previous.summary,
								bytes: Buffer.byteLength(previous.summary, "utf8"),
							},
						];
			const items = [...carried, ...contextItems(live.slice(0, -1).map((entry) => (entry as { message: AgentMessage }).message))];
			if (items.length === 0) {
				return { ok: false, text: "nothing to compact: the session has no earlier entries to reduce" };
			}

			const before = contextReport(surface, context.session);
			const artifacts = createArtifactStore({
				sessionDir: join(surface.cwd, ".leanpi", "artifacts", manager.getSessionId()),
				thresholdBytes: surface.config.context.artifact_threshold_bytes,
			});
			const result = await compact(items, {
				artifacts,
				// No item here carries an evidence workspace hash, so no hash is consulted.
				currentWorkspaceHash: "",
				workingState: buildWorkingState(stubSources(), { filesTouched: [] }, WORKING_STATE_MAX_BYTES),
				...(surface.jev ? { client: surface.jev, jevEnabled: surface.jev.getMode() !== "disabled" } : {}),
				budgetBytes: surface.config.context.compaction_threshold_bytes,
			});

			const reduced = result.reduced.length + result.dropped.length;
			if (reduced === 0) {
				return {
					ok: false,
					text: `nothing to compact: ${items.length} items, none reducible to an artifact reference (~${before.estimate} tokens)`,
				};
			}

			const summary = [
				"Compacted context (deterministic reduction; every removed block is addressable at its artifact:// ref).",
				// Kept items stay whole: the entry replaces the cut messages, so a
				// truncated summary here would lose the requirement it preserved.
				...result.kept.map((item) => `- [${item.kind}] ${item.body ?? item.summary}`),
				...result.reduced.map((item) => `- [${item.kind} reduced] ${item.summary}`),
				...result.dropped.map((item) => `- [${item.kind} dropped] ${item.summary}`),
			].join("\n");
			manager.appendCompaction(summary, keptEntry.id, before.estimate, {
				artifactRefs: result.reduced.map((item) => item.artifact).filter((ref): ref is string => ref !== undefined),
				decisions: result.decisions.length,
			});

			const after = contextReport(surface, context.session);
			return {
				ok: true,
				text: [
					// Both figures are LeanPi's own estimate: the reduction is local, so
					// comparing it against Pi's last measured usage would compare two
					// different things.
					`before: ~${before.estimate} tokens (${items.length} items, estimated)`,
					`after:  ~${after.estimate} tokens (estimated)`,
					`reduced: ${result.reduced.length} to artifact refs, dropped: ${result.dropped.length}, kept: ${result.kept.length}`,
					renderContextReport(after),
				].join("\n"),
			};
		},
	});
}
