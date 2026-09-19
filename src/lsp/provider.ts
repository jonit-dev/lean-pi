/**
 * The LSP capability provider (PRD-018, PRD-004's `CapabilityProvider` contract).
 *
 * Registered with `kind: 'lsp'`, this is the single selection point for a turn's
 * mode: it derives the changed-language set and the available servers, asks the
 * deterministic table, and writes back
 * - `capabilities.lsp` — the boolean gate the turn's tool group hangs off;
 * - `verification.required` — FR-094's mandatory `typecheck` marker, added when
 *   a one-shot type check replaced a resident diagnostics stream;
 * - the per-turn LSP record (mode, tool group, servers, telemetry), readable from
 *   the frozen contract through `lspSelectionOf` / `lspTurnRecordOf`.
 *
 * With JEV absent, unreachable or unconfident the turn still gets a mode: the
 * table's cheapest tied candidate. Nothing here starts a language server — only a
 * tool call does.
 */
import type { LeanPiConfig } from "../core/types.js";
import type { CapabilityProvider, ExecutionContract, SiteTelemetryRow } from "../compiler/contract.js";
import { getCompilerContext } from "../compiler/index.js";
import type { JevClient } from "../jev/client.js";
import type { ChoiceAnswer, JevResult } from "../jev/types.js";
import type { TaskPacket } from "../scout/index.js";
import { lspConfigOf } from "./config.js";
import { detectServers, languageOfPath, type DetectedServer } from "./detect.js";
import { preferTargetedCheck, selectLspMode, type LspSelection, type LspUsefulnessAsker } from "./mode.js";
import { LSP_MODE_QUESTION_ID, LSP_SITE_ID, lspUsefulnessQuestions, registerLspSite } from "./site.js";
import { lspToolsForMode, type LspToolName } from "./tools.js";

/** Everything a turn's LSP decision produced, keyed by the compiled contract. */
export interface LspTurnRecord {
	selection: LspSelection;
	/** The tool group the turn exposes to the executor. */
	tools: LspToolName[];
	servers: DetectedServer[];
	telemetry: SiteTelemetryRow[];
}

const turns = new WeakMap<ExecutionContract, LspTurnRecord>();

export function lspTurnRecordOf(contract: ExecutionContract): LspTurnRecord | undefined {
	return turns.get(contract);
}

export function lspSelectionOf(contract: ExecutionContract): LspSelection | undefined {
	return turns.get(contract)?.selection;
}

export function lspTelemetryOf(contract: ExecutionContract): SiteTelemetryRow[] {
	return turns.get(contract)?.telemetry ?? [];
}

/** The tool names the executor can actually invoke for this turn. */
export function lspToolsForTurn(contract: ExecutionContract): LspToolName[] {
	return turns.get(contract)?.tools ?? [];
}

/** Languages in scope: the target paths first, the repository manifest when they say nothing. */
export function changedLanguagesOf(packet: TaskPacket): string[] {
	const languages = new Set<string>();
	for (const file of packet.workspace.changed_files) {
		const language = languageOfPath(file);
		if (language !== null) languages.add(language);
	}
	if (languages.size === 0) for (const language of packet.repository.languages) languages.add(language);
	return [...languages];
}

/** PRD-009's configured commands, read structurally so this compiles either way. */
function configuredTypecheck(config: LeanPiConfig | undefined): string | undefined {
	const verify = (config as (LeanPiConfig & { verify?: { commands?: Record<string, unknown> } }) | undefined)?.verify;
	const command = verify?.commands?.typecheck;
	return typeof command === "string" && command.length > 0 ? command : undefined;
}

/** The real `lsp.usefulness` caller: one Choice question through the session's client. */
export function createJevAsker(client: Pick<JevClient, "ask" | "fallbackCount"> & Partial<Pick<JevClient, "lastUsage">>): LspUsefulnessAsker {
	return {
		async choose(context) {
			registerLspSite();
			const before = client.fallbackCount();
			let results: JevResult[];
			try {
				results = await client.ask(LSP_SITE_ID, lspUsefulnessQuestions(context.candidates), {
					taskSummary: context.taskSummary,
					taskType: context.taskType,
					changedLanguages: context.changedLanguages,
					candidates: context.candidates,
				});
			} catch {
				return null;
			}
			// A registry fallback (JEV off, unreachable, or below threshold) already
			// answered with the cheapest candidate; that path is not a JEV answer.
			if (client.fallbackCount() > before) return null;
			const answer = results.find((result): result is ChoiceAnswer => result.kind === "Choice" && result.questionId === LSP_MODE_QUESTION_ID);
			if (!answer) return null;
			const mode = context.candidates.find((candidate) => candidate === answer.choice);
			if (!mode) return null;
			return { mode, confidence: answer.confidence, ...(client.lastUsage ? { tokens: client.lastUsage() } : {}) };
		},
	};
}

export interface LspProviderOptions {
	/** Defaults to the compiler context's cwd, then the process cwd. */
	root?: string;
	/** Defaults to the compiler context's config. */
	config?: LeanPiConfig;
	env?: NodeJS.ProcessEnv;
	/** Test seam: a fixed ambiguity answer instead of the session's JEV client. */
	asker?: LspUsefulnessAsker;
	/** PRD-009's resolved `typecheck` command when configuration declares one. */
	configuredTypecheck?: string;
}

/** The provider PRD-004's compiler calls for `kind: 'lsp'`. */
export function createLspProvider(options: LspProviderOptions = {}): CapabilityProvider {
	return {
		kind: "lsp",
		async supply(draft, packet) {
			const context = getCompilerContext();
			const config = options.config ?? context?.config;
			const root = options.root ?? context?.cwd ?? process.cwd();
			const resolved = lspConfigOf(config);
			const servers = detectServers(root, { ...(config ? { config } : {}), ...(options.env ? { env: options.env } : {}) });
			const targetedCheck = preferTargetedCheck(root, options.configuredTypecheck ?? configuredTypecheck(config));
			const asker = options.asker ?? (context ? createJevAsker(context.client) : undefined);
			const selection = await selectLspMode({
				configMode: resolved.mode,
				changedLanguages: changedLanguagesOf(packet),
				availableServers: servers.map((server) => server.language),
				taskType: draft.task.type,
				...(targetedCheck ? { targetedCheck } : {}),
				taskSummary: draft.task.user_request,
				...(asker ? { asker } : {}),
			});

			// FR-094: the contract marks the verifier kind; PRD-009 owns the command.
			if (selection.targetedCheck && !draft.verification.required.includes("typecheck")) {
				draft.verification.required.push("typecheck");
			}
			const telemetry: SiteTelemetryRow[] = selection.jevSiteUsed
				? [
						{
							site_id: LSP_SITE_ID,
							answer: selection.mode,
							confidence: selection.confidence,
							fallback_used: selection.fallbackUsed,
							tokens: selection.tokens,
						},
					]
				: [];
			turns.set(draft, { selection, tools: lspToolsForMode(selection.mode), servers, telemetry });
			return selection.mode !== "LSP_OFF";
		},
	};
}
