/**
 * Which model serves which role, decided by JEV from what the machine has.
 *
 * The role map is the routing table (§14) and it is exactly the kind of
 * judgement this harness is built to delegate: "is this model the cheap one or
 * the strong one" is public, changing, model-specific knowledge — an Artificial
 * Analysis intelligence index and price tier — and a hardcoded table of model
 * ids is wrong the week after it is written. So the candidates are read off the
 * vendor CLIs (never guessed), and JEV allocates them.
 *
 * §49 still holds: the site declares a deterministic fallback, the quota-class
 * ladder, so a machine with no usable JEV answer still gets a working config.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VENDOR_MODEL_DEFAULT, type HarnessVendor } from "../backends/harness.js";
import type { JevClient } from "../jev/client.js";
import { accept } from "../jev/confidence.js";
import { ensureSite } from "../jev/registry.js";
import type { JevQuestion, JevResult } from "../jev/types.js";
import { MODEL_ROLES, type ModelRole } from "../core/types.js";

export interface ModelCandidate {
	vendor: HarnessVendor;
	/** The id to write into the config; `default` means "whatever the CLI picks". */
	model: string;
	/** How the id was obtained, for the line the bootstrap prints. */
	source: string;
}

/**
 * `default` is a real answer, not a placeholder: it is the id `runHarness`
 * strips, so the vendor CLI's own configured model runs and the config says so
 * instead of naming a model nobody selected.
 */
export const VENDOR_DEFAULT = VENDOR_MODEL_DEFAULT;

type Runner = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => string;

const runCommand: Runner = (command, args, env) =>
	execFileSync(command, [...args], {
		encoding: "utf8",
		timeout: 20_000,
		stdio: ["ignore", "pipe", "ignore"],
		// `opencode` colourises unless told not to, and a colourised list is not a
		// list of model ids.
		// `FORCE_COLOR=0` alone: setting `NO_COLOR` as well makes Node warn that the
		// two disagree, on the stderr the user reads.
		env: { ...env, FORCE_COLOR: "0" },
	});

function readJsonField(path: string, field: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[field];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/** The models a vendor will actually run here, asked of the vendor itself. */
export function detectModels(
	vendor: HarnessVendor,
	options: { env?: NodeJS.ProcessEnv; home?: string; run?: Runner } = {},
): ModelCandidate[] {
	const env = options.env ?? process.env;
	const home = options.home ?? env.HOME ?? homedir();
	const run = options.run ?? runCommand;
	if (vendor === "opencode") {
		// The one vendor LeanPi passes `--model` to, and the one with a list
		// command: `opencode models` prints `provider/model` per line.
		try {
			const listed = run("opencode", ["models"], env)
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && line.includes("/"));
			if (listed.length > 0) return listed.map((model) => ({ vendor, model, source: "opencode models" }));
		} catch {
			// Not installed, not signed in, or offline — fall through to the config.
		}
		const configured = readJsonField(join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode", "opencode.json"), "model");
		return [{ vendor, model: configured ?? VENDOR_DEFAULT, source: configured ? "opencode.json" : "vendor default" }];
	}
	if (vendor === "codex") {
		const path = join(home, ".codex", "config.toml");
		const match = existsSync(path) ? /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(path, "utf8")) : null;
		return [{ vendor, model: match?.[1] ?? VENDOR_DEFAULT, source: match ? "codex config.toml" : "vendor default" }];
	}
	const configured = readJsonField(join(home, ".claude.json"), "model") ?? readJsonField(join(home, ".claude", "settings.json"), "model");
	return [{ vendor, model: configured ?? VENDOR_DEFAULT, source: configured ? "claude settings" : "vendor default" }];
}

export const ALLOCATE_SITE_ID = "bootstrap.role_models";

/** `vendor:model`, the key JEV chooses by and the map this module answers with. */
export function candidateKey(candidate: ModelCandidate): string {
	return `${candidate.vendor}:${candidate.model}`;
}

const ROLE_QUESTION: Record<ModelRole, string> = {
	quick: "which model should serve short mechanical turns where cost dominates and capability is rarely the constraint?",
	balanced: "which model should serve ordinary feature work — the default turn?",
	strong: "which model should serve the hardest turns: unfamiliar, coupled, concurrency or performance-critical work?",
	specialist: "which model should serve work whose correctness depends on deep language or runtime knowledge?",
	review_quick: "which model should verify low-risk changes, where review must be cheap?",
	review_strong: "which model should verify high-risk changes, where a missed defect is expensive?",
};

export function allocationQuestions(candidates: readonly ModelCandidate[]): JevQuestion[] {
	const options: Record<string, string> = {};
	for (const candidate of candidates) {
		options[candidateKey(candidate)] = `${candidate.vendor} ${candidate.model}`;
	}
	return MODEL_ROLES.map((role) => ({
		id: role,
		kind: "Choice" as const,
		// The question names the criterion; the model ids are the options, so the
		// capability/price knowledge JEV applies is about these exact models.
		text: `Routing a coding harness across the subscriptions this machine has, ${ROLE_QUESTION[role]} Judge by published capability and price data for these models.`,
		options,
	}));
}

/**
 * Cheapest-first preference by quota class, the answer when JEV has none. It is
 * ordering, not model knowledge: `opencode` is the low-cost subscription here,
 * `claude` the scarce-premium one.
 */
const LADDER: Record<ModelRole, readonly HarnessVendor[]> = {
	quick: ["opencode", "codex", "claude"],
	balanced: ["codex", "claude", "opencode"],
	strong: ["claude", "codex", "opencode"],
	specialist: ["claude", "codex", "opencode"],
	review_quick: ["opencode", "codex", "claude"],
	review_strong: ["claude", "codex", "opencode"],
};

export function ladderAllocation(candidates: readonly ModelCandidate[]): Record<ModelRole, ModelCandidate> {
	const allocation = {} as Record<ModelRole, ModelCandidate>;
	for (const role of MODEL_ROLES) {
		const chosen =
			LADDER[role].map((vendor) => candidates.find((candidate) => candidate.vendor === vendor)).find((candidate) => candidate !== undefined) ??
			(candidates[0] as ModelCandidate);
		allocation[role] = chosen;
	}
	return allocation;
}

export interface Allocation {
	roles: Record<ModelRole, ModelCandidate>;
	fallbackUsed: boolean;
}

export async function allocateRoles(
	client: Pick<JevClient, "ask" | "fallbackCount">,
	candidates: readonly ModelCandidate[],
): Promise<Allocation> {
	if (candidates.length === 0) throw new Error("no model candidates to allocate");
	const questions = allocationQuestions(candidates);
	const fallback = ladderAllocation(candidates);
	ensureSite({
		id: ALLOCATE_SITE_ID,
		questions,
		returnType: questions.map(() => "Choice" as const),
		// A wrong role map costs money and quality but is visible and editable in
		// the file it writes, so it is a normal-consequence decision.
		consequence: "normal",
		telemetryTag: ALLOCATE_SITE_ID,
		fallback: (): JevResult[] =>
			MODEL_ROLES.map((role) => ({
				kind: "Choice",
				questionId: role,
				choice: candidateKey(fallback[role]),
				probabilities: {},
				confidence: 0,
			})),
	});
	const before = client.fallbackCount();
	let results: JevResult[];
	try {
		results = await client.ask(ALLOCATE_SITE_ID, questions, { candidates });
	} catch {
		return { roles: fallback, fallbackUsed: true };
	}
	if (client.fallbackCount() > before || !results.every((result) => accept(result, "normal"))) {
		return { roles: fallback, fallbackUsed: true };
	}
	const roles = {} as Record<ModelRole, ModelCandidate>;
	for (const role of MODEL_ROLES) {
		const result = results.find((entry) => entry.questionId === role);
		const chosen = result?.kind === "Choice" ? candidates.find((candidate) => candidateKey(candidate) === result.choice) : undefined;
		roles[role] = chosen ?? fallback[role];
	}
	return { roles, fallbackUsed: false };
}
