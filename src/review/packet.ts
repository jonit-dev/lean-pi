/**
 * The reviewer packet builder (PRD-011 Phase 1, ROADMAP §30).
 *
 * `buildPacket()` takes the objective and acceptance criteria from the PRD-004
 * contract, the candidate diff and changed-file list from the workspace, the
 * PRD-009 evidence records, collected warnings and the executor's own summary
 * string. It takes **no transcript argument**, and no other function in
 * `src/review/` reads one, so the §30 packet cannot grow with the session: a
 * review payload is bounded by the diff bound below, not by how long the
 * executor talked.
 */
import { execFileSync } from "node:child_process";
import type { ExecutionContract } from "../compiler/contract.js";
import type { ArtifactStore } from "../context/artifacts.js";
import type { EvidenceRecord } from "../verify/evidence.js";
import type { SelectedSkill } from "../core/types.js";
import { readVendoredPonytail } from "../core/instructions/prefix.js";
import { porcelainPaths } from "../runtime/git.js";
import type { AcceptanceCriterion, ActiveReviewLevel, ReviewPacket } from "./schema.js";

/** Above this many bytes the full diff goes to the artifact store and the packet keeps a head. */
export const DEFAULT_INLINE_DIFF_BYTES = 32_768;

/** PRD-014 kind under which a compacted diff is stored (`artifact://diff/<sha>`). */
export const DIFF_ARTIFACT_KIND = "diff";

/** The four prompt profiles `/review`'s modes select; `gate` reuses `quick`. */
export type ReviewProfile = "quick" | "strong" | "security" | "diff";

/** `git`'s exit code is not the question — `--no-index` exits 1 on a difference — so only stdout is read. */
function git(cwd: string, args: string[]): string {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
			maxBuffer: 32 * 1024 * 1024,
		});
	} catch (error) {
		const stdout = (error as { stdout?: string | Buffer }).stdout;
		return typeof stdout === "string" ? stdout : "";
	}
}

/**
 * The candidate change as git reports it: tracked modifications against `base`
 * plus a `/dev/null` diff for each untracked file, so a fresh file the executor
 * created is part of `final_diff` rather than a silent omission. Nothing here
 * writes to the index.
 */
export function workspaceChange(cwd: string, base = "HEAD"): { diff: string; files: string[] } {
	const status = git(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
	const files = porcelainPaths(status);
	const tracked = git(cwd, ["diff", base, "--"]);
	const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
		.split("\0")
		.filter(Boolean)
		.map((path) => git(cwd, ["diff", "--no-index", "--no-color", "--", "/dev/null", path]));
	return { diff: [tracked, ...untracked].filter((part) => part.trim().length > 0).join("\n"), files };
}

/**
 * The contract's acceptance criteria. PRD-004's §8 block carries them as
 * `verification.criteria` (ids with an optional label); a `task.acceptance_criteria`
 * list is honoured when a contract carries one. An id with no text is still a
 * criterion — the finding's `criterion` field points at it.
 *
 * A compiled contract carries the same id in both blocks — the criterion list
 * and the verification block that names its scope — so the first occurrence
 * wins: the reviewer must see one criterion per id, with the text the task
 * stated rather than a bare id repeated after it.
 */
export function acceptanceCriteriaOf(contract: ExecutionContract): AcceptanceCriterion[] {
	const raw = (contract as { task?: { acceptance_criteria?: unknown }; verification?: { criteria?: unknown } });
	const sources = [raw.task?.acceptance_criteria, raw.verification?.criteria];
	const criteria: AcceptanceCriterion[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		if (!Array.isArray(source)) continue;
		for (const entry of source) {
			if (typeof entry === "string") {
				if (entry.trim().length > 0 && !seen.has(entry)) {
					seen.add(entry);
					criteria.push({ id: entry, text: entry });
				}
				continue;
			}
			if (entry === null || typeof entry !== "object") continue;
			const item = entry as Record<string, unknown>;
			if (typeof item.id !== "string" || item.id.length === 0 || seen.has(item.id)) continue;
			const text = typeof item.text === "string" && item.text.length > 0 ? item.text : typeof item.label === "string" ? item.label : item.id;
			seen.add(item.id);
			criteria.push({ id: item.id, text });
		}
	}
	return criteria;
}

export interface PacketInputs {
	objective: string;
	acceptanceCriteria?: ReadonlyArray<AcceptanceCriterion | string>;
	/** Read the diff and changed-file list from git when `diff` is not supplied. */
	cwd?: string;
	/** Revision the candidate change is compared against; defaults to `HEAD`. */
	base?: string;
	diff?: string;
	changedFiles?: readonly string[];
	evidence?: readonly EvidenceRecord[];
	warnings?: readonly string[];
	executorSummary?: string;
	artifacts?: ArtifactStore;
	inlineDiffBytes?: number;
}

export interface BuiltPacket {
	packet: ReviewPacket;
	/** The full diff's `artifact://` reference, or `null` when it fit inline or no store was supplied. */
	diffArtifact: string | null;
}

export function buildPacket(inputs: PacketInputs): BuiltPacket {
	const fromWorkspace = inputs.diff === undefined && inputs.cwd !== undefined ? workspaceChange(inputs.cwd, inputs.base ?? "HEAD") : null;
	const diff = inputs.diff ?? fromWorkspace?.diff ?? "";
	const bound = inputs.inlineDiffBytes ?? DEFAULT_INLINE_DIFF_BYTES;

	let finalDiff = diff;
	let diffArtifact: string | null = null;
	if (Buffer.byteLength(diff, "utf8") > bound) {
		if (inputs.artifacts) {
			diffArtifact = inputs.artifacts.store(diff, DIFF_ARTIFACT_KIND, "review.final_diff");
			const head = Buffer.from(diff, "utf8").subarray(0, bound).toString("utf8");
			finalDiff = `${head}\n[truncated: ${Buffer.byteLength(diff, "utf8")} bytes; full diff: ${diffArtifact}]`;
		} else {
			// No store means no retrievable bytes, and the packet says so rather than
			// implying a reference it cannot honour.
			const head = Buffer.from(diff, "utf8").subarray(0, bound).toString("utf8");
			finalDiff = `${head}\n[truncated: ${Buffer.byteLength(diff, "utf8")} bytes; no artifact store available]`;
		}
	}

	const criteria = (inputs.acceptanceCriteria ?? []).map((entry) =>
		typeof entry === "string" ? { id: entry, text: entry } : { id: entry.id, text: entry.text },
	);

	return {
		diffArtifact,
		packet: {
			objective: inputs.objective,
			acceptance_criteria: criteria,
			final_diff: finalDiff,
			changed_files: [...(inputs.changedFiles ?? fromWorkspace?.files ?? [])],
			verification_results: [...(inputs.evidence ?? [])],
			known_warnings: [...(inputs.warnings ?? [])],
			executor_summary: inputs.executorSummary ?? "",
		},
	};
}

/** Per-profile review guidance; the reviewer never re-derives its own instructions. */
const REVIEW_PROFILE_INSTRUCTIONS: Record<ReviewProfile, string> = {
	quick:
		"Review the evidence packet below against the stated acceptance criteria. Look for a criterion the change does not satisfy, a branch left unhandled, or a check the evidence claims but does not show.",
	strong:
		"Review the evidence packet below against the stated acceptance criteria, then look past it: unhandled edge cases, silent behaviour changes, and evidence that cannot support the claim it is attached to. Be specific about where the change fails.",
	security:
		"Review the evidence packet below for security defects first: missing input validation at a trust boundary, secret or credential exposure, permission or path escapes, injection, and unsafe deserialization. Report only defects you can point at in the diff.",
	diff:
		"Review the diff below on its own. No verification was run for this request, so treat every claim as unproven and say what would have to be run to support it.",
};

const VERDICT_CONTRACT = [
	"## output",
	"Reply with exactly one JSON object and no prose around it:",
	'{"decision":"PASS|FIX_REQUIRED|ESCALATE","findings":[{"criterion":"","file":"","location":"","severity":"","evidence":""}]}',
	"Every finding field is required and must be non-empty. `criterion` names the acceptance-criterion id; `file` and `location` point at the change; `evidence` states what you observed. Use `PASS` only when the evidence supports every criterion.",
].join("\n");

/**
 * The reviewer's request: the mode's frame first, then PRD-001's vendored
 * Ponytail bundle as the baseline instruction prefix, then the packet and the
 * verdict contract. A matched review skill (PRD-005) replaces the profile text
 * when one is supplied.
 *
 * The header leads deliberately: the prompt is passed to a vendor CLI as a
 * positional argument, and a prompt that begins with the bundle's `---`
 * frontmatter is read as a flag by every one of them.
 */
export function renderReviewPrompt(
	packet: ReviewPacket,
	level: ActiveReviewLevel,
	profile: ReviewProfile,
	skill?: SelectedSkill,
): string {
	const instruction = skill ? `## review contract: ${skill.name}\n\n${skill.body.trim()}` : REVIEW_PROFILE_INSTRUCTIONS[profile];
	return [
		`# reviewer lane (${level.toLowerCase()}, ${profile})`,
		"You are reviewing another agent's completed change. You receive evidence, not the executor's conversation. Do not modify the workspace; produce a verdict only.",
		readVendoredPonytail().trim(),
		instruction,
		"## evidence packet",
		JSON.stringify(packet, null, 2),
		VERDICT_CONTRACT,
	].join("\n\n");
}
