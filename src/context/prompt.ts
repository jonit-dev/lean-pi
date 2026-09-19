/**
 * Layered prompt assembly and dedup (PRD-014 Phase 3, ROADMAP §22).
 *
 * The single place a provider request is built: STATIC first (byte-identical
 * every turn, which is what the provider cache keys on), then SEMI-STABLE, then
 * VOLATILE — dynamic content strictly last so the cacheable prefix is maximal.
 * This module never re-authors the Ponytail text; it places PRD-001's bytes.
 */
import { createHash } from "node:crypto";
import { BASELINE_TOOL_NAMES } from "../core/tools.js";
import { buildStaticPrefix } from "../core/instructions/prefix.js";
import type { LeanPiConfig, SelectedSkill } from "../core/types.js";
import type { ExecutionContract } from "../compiler/contract.js";
import type { ArtifactStore } from "./artifacts.js";
import { serializeWorkingState, type WorkingState } from "./working-state.js";

export interface AssembleParts {
	config: Pick<LeanPiConfig, "instructions">;
	/** Selected project instructions (AGENTS.md-style), already excerpts. */
	projectInstructions?: string[];
	/** Bodies PRD-005 selected; rendered in a deterministic order. */
	skills?: SelectedSkill[];
	/** MCP tool schemas PRD-006 selected. */
	mcps?: unknown[];
	contract?: ExecutionContract;
	workingState?: WorkingState;
	/** Latest evidence summaries, newest last. */
	evidence?: string[];
	diff?: string;
	currentFailure?: string;
	/** When present, a repeated block is replaced by its `artifact://` reference. */
	artifacts?: ArtifactStore;
}

export interface AssembledPrompt {
	/** STATIC layer only — must be byte-identical every turn. */
	prefix: string;
	/** STATIC + SEMI-STABLE: everything that precedes any turn-specific content. */
	cacheablePrefix: string;
	layers: { static: string; semiStable: string; volatile: string };
	/** The full assembled prompt. */
	text: string;
	bytes: number;
	/** Content hashes emitted, for the dedup back-references. */
	hashes: Set<string>;
}

const TOOL_PROTOCOL = `Tool protocol: ${BASELINE_TOOL_NAMES.join(", ")}. Read before editing; verify with the project's own runner.`;

function hashBlock(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

/**
 * One content block: an exact repeat becomes a reference, never a second copy.
 * With a store the reference is the `artifact://` ref that expands to the same
 * bytes; without one it is a short content-hash back-reference.
 */
function dedup(block: string, seen: Map<string, string>, artifacts?: ArtifactStore): string {
	if (block.length === 0) return block;
	const hash = hashBlock(block);
	if (seen.has(hash)) {
		const ref = artifacts ? artifacts.store(block, "context", `prompt:${hash}`) : `sha256:${hash}`;
		return `[same content as earlier block: ${ref}]`;
	}
	seen.set(hash, block);
	return block;
}

function renderContract(contract: ExecutionContract): string {
	return [
		"task contract:",
		`  type: ${contract.task.type}`,
		`  prd_required: ${contract.task.prd_required}`,
		`  execution_complexity: ${contract.task.execution_complexity}`,
		`  review_risk: ${contract.task.review_risk}`,
		`  executor: ${contract.routing.executor_class}`,
		`  verification: ${contract.verification.required.join(", ")}`,
	].join("\n");
}

/**
 * Assemble the three layers. Every block is content-hashed: a repeat is emitted
 * as its existing reference rather than a second copy (AC-3).
 */
export function assemble(parts: AssembleParts): AssembledPrompt {
	const seen = new Map<string, string>();
	const staticLayer = [buildStaticPrefix(parts.config as LeanPiConfig), TOOL_PROTOCOL].filter((block) => block.length > 0).join("\n\n");

	const semiStableBlocks: string[] = [];
	if (parts.projectInstructions?.length) {
		semiStableBlocks.push(`project instructions:\n${[...parts.projectInstructions].sort().join("\n\n")}`);
	}
	const skills = [...(parts.skills ?? [])].sort((left, right) => left.name.localeCompare(right.name));
	for (const skill of skills) {
		semiStableBlocks.push(`### skill: ${skill.name} (${skill.source})\n${skill.body.trim()}`);
	}
	if (parts.mcps?.length) semiStableBlocks.push(`mcp schemas:\n${JSON.stringify(parts.mcps)}`);
	if (parts.contract) semiStableBlocks.push(renderContract(parts.contract));
	const semiStable = semiStableBlocks.map((block) => dedup(block, seen, parts.artifacts)).join("\n\n");

	const volatileBlocks: string[] = [];
	if (parts.workingState) volatileBlocks.push(`working state:\n${serializeWorkingState(parts.workingState).trimEnd()}`);
	if (parts.diff) volatileBlocks.push(`current diff:\n${parts.diff}`);
	if (parts.currentFailure) volatileBlocks.push(`current failure:\n${parts.currentFailure}`);
	for (const item of parts.evidence ?? []) volatileBlocks.push(`evidence: ${item}`);
	const volatileLayer = volatileBlocks.map((block) => dedup(block, seen, parts.artifacts)).join("\n\n");

	const cacheablePrefix = [staticLayer, semiStable].filter((layer) => layer.length > 0).join("\n\n");
	const text = [cacheablePrefix, volatileLayer].filter((layer) => layer.length > 0).join("\n\n");
	return {
		prefix: staticLayer,
		cacheablePrefix,
		layers: { static: staticLayer, semiStable, volatile: volatileLayer },
		text,
		bytes: Buffer.byteLength(text, "utf8"),
		hashes: new Set(seen.keys()),
	};
}
