/**
 * PRD-012 Phase 1 / AC-1 — `/prd create` over the installed authoring contract.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../src/commands/registry.js";
import { registerPrdCommands } from "../../src/prd/commands.js";
import {
	loadAuthoringContract,
	resolveInstalledSkill,
	resolveSkillScript,
	type AuthoringModel,
	type AuthoringRequest,
} from "../../src/prd/creator.js";
import { readPrdState, REQUIREMENT_SECTIONS } from "../../src/prd/state.js";
import { fixtureRepo, tempDir } from "../helpers/fixtures.js";
import { AC1_COMMAND, AC2_COMMAND, AC3_COMMAND, artifactStoreFor, prdConfig, writeInstalledSkill } from "./helpers.js";

const CREATOR_MARKER = "PRD-CREATOR-CONTRACT-MARKER";

function authoredMarkdown(commandlessThird: boolean): string {
	return [
		"## Problem Statement",
		"",
		"The cache is rebuilt on every turn, so warm work is thrown away.",
		"",
		"## Goals",
		"",
		"- Keep a warm cache across turns.",
		"",
		"## Non-Goals",
		"",
		"- Distributed caching.",
		"",
		"## Functional Requirements",
		"",
		"- FR-1: the cache survives a turn boundary.",
		"",
		"## Architecture Constraints",
		"",
		"- One process, one cache instance.",
		"",
		"## Acceptance Criteria",
		"",
		`- [ ] AC-1 Plan the cache layout — Verify: \`${AC1_COMMAND}\``,
		`- [ ] AC-2 Measure the hit rate — Verify: \`${AC2_COMMAND}\``,
		commandlessThird
			? "- [ ] AC-3 Document the eviction policy"
			: `- [ ] AC-3 Document the eviction policy — Verify: \`${AC3_COMMAND}\``,
		"",
		"## Verification Requirements",
		"",
		"- Every criterion names its own command.",
		"",
		"## Dependencies",
		"",
		"- None outside the repository.",
		"",
		"## Unresolved Risks",
		"",
		"- Eviction policy is unspecified until it is documented.",
		"",
	].join("\n");
}

function recordingAuthor(response: string): { author: AuthoringModel; requests: AuthoringRequest[] } {
	const requests: AuthoringRequest[] = [];
	return {
		requests,
		author: async (request) => {
			requests.push(request);
			return response;
		},
	};
}

describe("PRD-012 Phase 1 — PRD creation", () => {
	it("AC-1: a command-less criterion is re-asked once, then reported as a named gap and never written", async () => {
		const { cwd, agentDir } = fixtureRepo();
		const skillsRoot = tempDir("leanpi-skills-");
		writeInstalledSkill(skillsRoot, "prd-creator", CREATOR_MARKER, "Authoring contract fixture");
		const config = prdConfig(cwd, { skillRoots: [skillsRoot] });
		const artifactStore = artifactStoreFor(agentDir);
		const { author, requests } = recordingAuthor(authoredMarkdown(true));

		const registry = createCommandRegistry();
		registerPrdCommands(registry, { cwd, config, artifactStore, author });
		const result = await registry.dispatch('/prd create "make the cache warm across turns"', { cwd });

		expect(result.ok).toBe(true);

		// The authoring contract is the installed skill, observably read from disk.
		expect(requests).toHaveLength(2);
		expect(requests[0]!.contractSource).toBe("installed");
		expect(requests[0]!.contract).toContain(CREATOR_MARKER);
		// The single targeted re-ask names the criterion that failed validation.
		expect(requests[1]!.reask?.commandless.map((criterion) => criterion.id)).toEqual(["AC-3"]);
		expect(result.text).toContain("skill_source: installed");
		expect(result.text).toContain("gap: AC-3");

		const state = readPrdState(cwd)!;
		expect(state.skillSource).toBe("installed");
		expect(state.criteria.map((criterion) => criterion.id)).toEqual(["AC-1", "AC-2"]);
		expect(state.criteria.every((criterion) => criterion.status === "PENDING")).toBe(true);

		const written = readFileSync(state.prdPath, "utf8");
		for (const section of REQUIREMENT_SECTIONS) expect(written).toContain(`## ${section}`);
		expect(written).toContain(`Verify: \`${AC1_COMMAND}\``);
		// The rejected criterion is a named gap, not prose in the file.
		expect(written).not.toContain("Document the eviction policy");

		// The full PRD stays retrievable through the artifact reference.
		expect(artifactStore.expand(state.artifactRef).toString("utf8")).toBe(written);
	});

	it("AC-1: a missing skillRoots directory still produces a PRD and records skill_source: builtin-fallback", async () => {
		const { cwd, agentDir } = fixtureRepo();
		const config = prdConfig(cwd, { skillRoots: [join(cwd, "no-such-skills-directory")] });
		const artifactStore = artifactStoreFor(agentDir);
		const { author, requests } = recordingAuthor(authoredMarkdown(false));

		const registry = createCommandRegistry();
		registerPrdCommands(registry, { cwd, config, artifactStore, author });
		const result = await registry.dispatch('/prd create "make the cache warm across turns"', { cwd });

		expect(result.ok).toBe(true);
		expect(result.text).toContain("skill_source: builtin-fallback");
		expect(requests).toHaveLength(1);
		expect(requests[0]!.contractSource).toBe("builtin-fallback");
		// Distinguishable from the primary case: the built-in floor is not the skill.
		expect(requests[0]!.contract).not.toContain(CREATOR_MARKER);
		for (const section of REQUIREMENT_SECTIONS) expect(requests[0]!.contract).toContain(section);

		const state = readPrdState(cwd)!;
		expect(state.skillSource).toBe("builtin-fallback");
		expect(basename(state.prdPath)).toMatch(/^PRD-\d{3}-make-the-cache-warm-across-turns\.md$/);
		expect(state.criteria).toHaveLength(3);
		expect(state.criteria.every((criterion) => criterion.verifyCommand.length > 0)).toBe(true);
	});

	it("AC-1: a response whose criteria all lack commands is refused, named, and writes nothing", async () => {
		const { cwd, agentDir } = fixtureRepo();
		const config = prdConfig(cwd, { skillRoots: [tempDir("leanpi-empty-skills-")] });
		const artifactStore = artifactStoreFor(agentDir);
		const commandless = authoredMarkdown(true).replace(` — Verify: \`${AC1_COMMAND}\``, "").replace(` — Verify: \`${AC2_COMMAND}\``, "");
		const { author } = recordingAuthor(commandless);

		const registry = createCommandRegistry();
		registerPrdCommands(registry, { cwd, config, artifactStore, author });
		const result = await registry.dispatch('/prd create "make the cache warm across turns"', { cwd });

		expect(result.ok).toBe(false);
		expect(result.text).toContain("no acceptance criterion carried a verification command");
		expect(result.text).toContain("gap: AC-1");
		expect(readPrdState(cwd)).toBeNull();
		expect(existsSync(join(cwd, "docs", "PRDs", "v1"))).toBe(false);
	});

	it("AC-1: a second create for the same objective takes the next id instead of overwriting the first", async () => {
		const { cwd, agentDir } = fixtureRepo();
		const config = prdConfig(cwd, { skillRoots: [tempDir("leanpi-empty-skills-")] });
		const artifactStore = artifactStoreFor(agentDir);
		const registry = createCommandRegistry();
		const { author } = recordingAuthor(authoredMarkdown(false));
		registerPrdCommands(registry, { cwd, config, artifactStore, author });

		await registry.dispatch('/prd create "make the cache warm across turns"', { cwd });
		const first = readPrdState(cwd)!;
		await registry.dispatch('/prd create "make the cache warm across turns"', { cwd });
		const second = readPrdState(cwd)!;

		expect(second.prdId).not.toBe(first.prdId);
		expect(second.prdPath).not.toBe(first.prdPath);
		expect(existsSync(first.prdPath)).toBe(true);
		expect(readFileSync(first.prdPath, "utf8")).toContain("## Acceptance Criteria");
	});

	// This machine's real `$HOME/.claude/skills` install; skipped unless asked for,
	// because another machine's defaults are not this suite's contract.
	const realInstall = process.env.LEANPI_PRD_REAL_SKILLS === "1" ? it : it.skip;
	realInstall("AC-1/AC-8: with no configured roots, the installed skills resolve through PRD-005's defaults", async () => {
		const { cwd } = fixtureRepo();
		const config = prdConfig(cwd);

		const authoring = loadAuthoringContract({ cwd, config });
		expect(authoring.source).toBe("installed");
		expect(authoring.skillPath).toMatch(/prd-creator[/\\]SKILL\.md$/);

		expect(resolveInstalledSkill({ cwd, config, name: "prd-executor" })).not.toBeNull();
		expect(resolveSkillScript({ cwd, config, name: "prd-manager", script: join("scripts", "prd-close.mjs") })).toMatch(
			/prd-close\.mjs$/,
		);
	});
});
