/**
 * `/context` and `/compact` — the context surface over PRD-014 (PRD-016 Phase 4, FR-148).
 *
 * `/context` groups the prompt into §22's layers with a token count per section
 * and a total, and flags the artifact-backed share. `/compact` runs PRD-014's
 * deterministic compactor (reference substitution, never summarization) and
 * writes the result through Pi's own compaction entry, so the session store
 * stays Pi's and the discarded bytes stay addressable at their `artifact://`
 * refs. It refuses rather than reporting a no-op when nothing is reducible.
 */
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens, getLatestCompactionEntry } from "@mariozechner/pi-coding-agent";
import { createArtifactStore, sha256 } from "../context/artifacts.js";
import { compact, type ContextItem } from "../context/compaction.js";
import { buildWorkingState, serializeWorkingState, stubSources, WORKING_STATE_MAX_BYTES } from "../context/working-state.js";
import { buildStaticPrefix } from "../core/instructions/prefix.js";
import type { CommandRegistry, CommandResult } from "./registry.js";
import { estimateTextTokens, type CommandSurface } from "./surface.js";

export interface ContextSection {
	name: string;
	tokens: number;
}

export interface ContextReport {
	sections: ContextSection[];
	total: number;
	/** `artifact://` refs cited in the resolved context. */
	refs: string[];
	/** Share of the total that is a reference rather than bytes. */
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

function workingStateText(surface: CommandSurface): string {
	return serializeWorkingState(buildWorkingState(stubSources(), { filesTouched: [] }, WORKING_STATE_MAX_BYTES));
}

/** Read-only accounting: no section here recomputes a value another module owns. */
export function contextReport(surface: CommandSurface): ContextReport {
	const messages = surface.host.current().buildSessionContext().messages;
	const toolTokens = messages.reduce((sum, message) => ((message as { role?: string }).role === "toolResult" ? sum + estimateTokens(message) : sum), 0);
	const contextTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	const contextText = messages.map(messageText).join("\n");
	const refs = [...new Set(contextText.match(/artifact:\/\/[^\s)\]]+/g) ?? [])];
	const refTokens = estimateTextTokens(refs.join("\n"));

	const sections: ContextSection[] = [
		{ name: "static prefix", tokens: estimateTextTokens(buildStaticPrefix(surface.config)) },
		{ name: "working state", tokens: estimateTextTokens(workingStateText(surface)) },
		{ name: "artifact references", tokens: refTokens },
		{ name: "live tool output", tokens: toolTokens },
		// The remainder is history by construction, so the sections always sum to the total.
		{ name: "message history", tokens: Math.max(0, contextTokens - toolTokens - refTokens) },
	];
	const total = sections.reduce((sum, section) => sum + section.tokens, 0);
	return { sections, total, refs, artifactShare: total === 0 ? 0 : refTokens / total };
}

export function renderContextReport(report: ContextReport): string {
	return [
		...report.sections.map((section) => `${section.name.padEnd(20)} ${section.tokens} tokens`),
		`total: ${report.total} tokens`,
		`artifact-backed share: ${(report.artifactShare * 100).toFixed(1)}% (${report.refs.length} ref${report.refs.length === 1 ? "" : "s"})`,
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
		summary: "show the context breakdown — static prefix, working state, artifact refs, tool output, history",
		usage: "/context",
		run: (): CommandResult => ({ ok: true, text: renderContextReport(contextReport(surface)) }),
	});

	registry.register({
		name: "compact",
		summary: "reduce the context with PRD-014's compactor and report the before/after totals",
		usage: "/compact",
		run: async (): Promise<CommandResult> => {
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

			const before = contextReport(surface);
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
					text: `nothing to compact: ${items.length} items, none reducible to an artifact reference (${before.total} tokens)`,
				};
			}

			const summary = [
				"Compacted context (PRD-014 deterministic reduction; every removed block is addressable at its artifact:// ref).",
				// Kept items stay whole: the entry replaces the cut messages, so a
				// truncated summary here would lose the requirement it preserved.
				...result.kept.map((item) => `- [${item.kind}] ${item.body ?? item.summary}`),
				...result.reduced.map((item) => `- [${item.kind} reduced] ${item.summary}`),
				...result.dropped.map((item) => `- [${item.kind} dropped] ${item.summary}`),
			].join("\n");
			manager.appendCompaction(summary, keptEntry.id, before.total, {
				artifactRefs: result.reduced.map((item) => item.artifact).filter((ref): ref is string => ref !== undefined),
				decisions: result.decisions.length,
			});

			const after = contextReport(surface);
			return {
				ok: true,
				text: [
					`before: ${before.total} tokens (${items.length} items)`,
					`after:  ${after.total} tokens`,
					`reduced: ${result.reduced.length} to artifact refs, dropped: ${result.dropped.length}, kept: ${result.kept.length}`,
					renderContextReport(after),
				].join("\n"),
			};
		},
	});
}
