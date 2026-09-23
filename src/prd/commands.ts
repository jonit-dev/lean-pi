/**
 * `/prd create|status|close` (PRD-012 Phases 1–4, FR-030/FR-033/FR-035).
 *
 * Lives in `src/prd/` rather than `src/commands/` for the same reason the rest
 * of the lane does: the quick path must be able to not load it. `close`
 * delegates to the installed `prd-manager` closure helper; when no helper
 * resolves it performs the internal status write plus move and records the
 * degradation instead of reporting success silently.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RequiredCapability } from "../compiler/contract.js";
import type { ArtifactStore } from "../context/artifacts.js";
import { prdSuggestEnabled, setPrdSuggest, type UiPrefsEnv } from "../cli/ui-settings.js";
import type { CommandHandler, CommandRegistry, CommandResult } from "../commands/registry.js";
import type { LeanPiConfig } from "../core/types.js";
import type { JevClient } from "../jev/client.js";
import { authorPrd, resolveSkillScript, writePrdFile, type AuthoringModel } from "./creator.js";
import { noteLaneModuleLoad, PRD_COMMAND_HELP } from "./dispatch.js";
import { createPrdState, readPrdState, writePrdState } from "./state.js";

noteLaneModuleLoad("commands");

export interface PrdCommandDeps {
	cwd: string;
	config: LeanPiConfig;
	artifactStore: ArtifactStore;
	/** The authoring model pass; without it `/prd create` reports the missing dependency. */
	author?: AuthoringModel;
	/**
	 * The request the user already typed, for `/prd create` with no argument.
	 * The status line invites the user into the PRD lane *because of* a turn that
	 * was just classified `PRD_REQUIRED`; making them retype that turn's text as
	 * a quoted argument was asking for something the session already had.
	 */
	defaultObjective?: () => string | undefined;
	/** The PRD-level routing annotation; the compiler's classification when one exists. */
	requiredCapability?: RequiredCapability;
	jev?: JevClient;
	hashWorkspace?: () => string;
	now?: () => Date;
	/** Where `/prd suggest` reads and writes its preference (PRD-044). */
	prefsEnv?: UiPrefsEnv;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	const match = /^(["'])(.*)\1$/s.exec(trimmed);
	return (match ? match[2]! : trimmed).trim();
}

/** `git mv` when the repository can do it, a plain rename otherwise. */
function moveToDone(cwd: string, prdPath: string): string {
	const target = join(dirname(prdPath), "done", basename(prdPath));
	mkdirSync(dirname(target), { recursive: true });
	try {
		execFileSync("git", ["mv", prdPath, target], { cwd, stdio: "pipe" });
	} catch {
		renameSync(prdPath, target);
	}
	return target;
}

export function createPrdHandler(deps: PrdCommandDeps): CommandHandler {
	const now = deps.now ?? (() => new Date());

	async function create(argument: string): Promise<CommandResult> {
		const objective = argument.length > 0 ? argument : (deps.defaultObjective?.() ?? "");
		if (objective.length === 0) return { ok: false, text: 'usage: /prd create "<objective>"' };
		if (!deps.author) return { ok: false, text: "/prd create needs an authoring model; none is wired in this session" };

		const authored = await authorPrd({ objective, cwd: deps.cwd, config: deps.config, author: deps.author });
		const notes = [
			`skill_source: ${authored.contractSource}`,
			...authored.gaps.map((gap) => `gap: ${gap.id} ${gap.reason}`),
		];

		if (authored.missingSections.length > 0) {
			return {
				ok: false,
				text: [`PRD not written — missing §11.1 sections: ${authored.missingSections.join(", ")}`, ...notes].join("\n"),
			};
		}
		if (authored.criteria.length === 0) {
			return { ok: false, text: ["PRD not written — no acceptance criterion carried a verification command", ...notes].join("\n") };
		}

		const written = writePrdFile(deps.cwd, authored);
		const artifactRef = deps.artifactStore.store(written.body, "prd", written.path);
		const state = createPrdState({
			prdId: written.id,
			prdPath: written.path,
			body: written.body,
			artifactRef,
			skillSource: authored.contractSource,
			requiredCapability: deps.requiredCapability ?? { min_coding_index: 0 },
		});
		writePrdState(deps.cwd, state);

		return {
			ok: true,
			text: [`created ${written.id} at ${written.path}`, `criteria: ${authored.criteria.length}`, ...notes].join("\n"),
		};
	}

	function status(): CommandResult {
		const state = readPrdState(deps.cwd);
		if (!state) return { ok: false, text: `no active PRD in ${deps.cwd} — /prd create "<objective>"` };
		const lines = [
			`${state.prdId} — ${state.prdPath}`,
			`skill_source: ${state.skillSource}`,
			`artifact: ${state.artifactRef}`,
			...state.criteria.map(
				(criterion) =>
					`${criterion.id} ${criterion.status} — ${criterion.text}` +
					`${criterion.verifyCommand.length > 0 ? ` [verify: ${criterion.verifyCommand}]` : ""}` +
					` evidence: ${criterion.evidenceRef ?? "none"}` +
					`${criterion.reason === undefined ? "" : ` (${criterion.reason})`}`,
			),
		];
		return { ok: true, text: lines.join("\n") };
	}

	function close(): CommandResult {
		const state = readPrdState(deps.cwd);
		if (!state) return { ok: false, text: `no active PRD in ${deps.cwd}` };
		const incomplete = state.criteria.filter((criterion) => criterion.status !== "VERIFIED");
		if (incomplete.length > 0) {
			const detail = incomplete.map((criterion) => `${criterion.id} is ${criterion.status}`).join(", ");
			return { ok: false, text: `cannot close ${state.prdId}: ${detail}` };
		}

		const helper = resolveSkillScript({
			cwd: deps.cwd,
			config: deps.config,
			name: "prd-manager",
			script: join("scripts", "prd-close.mjs"),
		});

		if (helper && existsSync(state.prdPath)) {
			try {
				const output = execFileSync(process.execPath, [helper, state.prdPath, "--yes"], { cwd: deps.cwd, encoding: "utf8" });
				state.closure = { source: "installed", detail: `${helper} ${basename(state.prdPath)}`, at: now().toISOString() };
				writePrdState(deps.cwd, state);
				return { ok: true, text: [`closed ${state.prdId} with the installed prd-manager helper`, output.trim()].join("\n").trimEnd() };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, text: `prd-manager helper failed for ${state.prdId}: ${message}; ${state.prdPath} left in place` };
			}
		}

		const moved = existsSync(state.prdPath) ? moveToDone(deps.cwd, state.prdPath) : state.prdPath;
		state.closure = {
			source: "builtin-fallback",
			detail: `prd-manager helper not found under the configured skill roots; internal status write + move to ${moved}`,
			at: now().toISOString(),
		};
		writePrdState(deps.cwd, state);
		return {
			ok: true,
			text: `closed ${state.prdId} (closure: builtin-fallback — prd-manager helper not found; moved to ${moved})`,
		};
	}

	/** PRD-044: the only way back after "No, don't ask again". */
	function suggest(value: string): CommandResult {
		const env = deps.prefsEnv ?? process.env;
		if (value === "") return { ok: true, text: `PRD suggestions: ${prdSuggestEnabled(env) ? "on" : "off"}` };
		if (value !== "on" && value !== "off") return { ok: false, text: "usage: /prd suggest [on|off]" };
		const path = setPrdSuggest(value === "on", env);
		return { ok: true, text: `PRD suggestions: ${value} (saved to ${path})` };
	}

	const handler = async (args: string): Promise<CommandResult> => {
		const trimmed = args.trim();
		const separator = trimmed.search(/\s/);
		const subcommand = separator === -1 ? trimmed : trimmed.slice(0, separator);
		const rest = separator === -1 ? "" : trimmed.slice(separator + 1).trim();

		if (subcommand === "create") return create(unquote(rest));
		if (subcommand === "status") return status();
		if (subcommand === "close") return close();
		if (subcommand === "suggest") return suggest(rest);
		return { ok: false, text: `usage: ${PRD_COMMAND_HELP.usage}` };
	};

	return handler;
}

/** Registers `/prd` directly; callers that must keep the quick path unloaded use `registerPrdCommandsLazily`. */
export function registerPrdCommands(registry: CommandRegistry, deps: PrdCommandDeps): void {
	// A later session supersedes the earlier handler, exactly like `/skills`.
	if (registry.has("prd")) registry.unregister("prd");
	registry.register("prd", createPrdHandler(deps), PRD_COMMAND_HELP);
}
