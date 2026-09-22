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
import { detectVendors, type SubscriptionState } from "../backends/subscriptions.js";
import { BUNDLED_RANKING_PATH, matchModel } from "../capability/index.js";
import { parseRankingFile } from "../capability/schema.js";
import type { JevClient } from "../jev/client.js";
import { accept } from "../jev/confidence.js";
import { ensureSite } from "../jev/registry.js";
import type { JevQuestion, JevResult } from "../jev/types.js";
import { MODEL_ROLES, type BackendType, type ModelRole } from "../core/types.js";

export interface ModelCandidate {
	vendor: HarnessVendor;
	/** Config backend name; differs from the vendor when the backend is native. */
	backend?: string;
	/** The id to write into the config; `default` means "whatever the CLI picks". */
	model: string;
	/** How the id was obtained, for the line the bootstrap prints. */
	source: string;
}

/** Whether this machine can run a discovered model right now. */
export type ModelAvailability = "ready" | "signed-out" | "not-installed";

/**
 * What the machine and the ranking say about one discovered model. These are the
 * facts JEV needs to judge a model and the ones `/model` prints; a null score or
 * price is *unknown*, never zero, and is kept distinct from an unusable vendor.
 */
export interface ModelFacts {
	/** How LeanPi would reach it: a vendor CLI (`external_harness`) or a Pi provider (`native`). */
	execution: BackendType;
	/** `not-installed`/`signed-out` are exclusions the ballot must state, not errors to hide. */
	availability: ModelAvailability;
	/** The vendor's own evidence line, so the exclusion can be acted on. */
	evidence: string;
	/** Coding score from the bundled ranking; null is *unknown*. */
	coding_score: number | null;
	/** Blended price from the bundled ranking; null is *unknown*. */
	price_blended_per_mtok: number | null;
}

/** A discovered model with the facts the role ballot and the JEV prompt carry. */
export interface DiscoveredModel extends ModelCandidate {
	facts: ModelFacts;
}

/**
 * `default` is a real answer, not a placeholder: it is the id `runHarness`
 * strips, so the vendor CLI's own configured model runs and the config says so
 * instead of naming a model nobody selected.
 */
export const VENDOR_DEFAULT = VENDOR_MODEL_DEFAULT;

type Runner = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => string;

const runCommand: Runner = (command, args, env) => {
	// `opencode` colourises unless told not to, and a colourised list is not a
	// list of model ids. `NO_COLOR` is dropped rather than set alongside
	// `FORCE_COLOR`: Node warns on stderr when the two disagree.
	const { NO_COLOR: _dropped, ...rest } = env;
	return execFileSync(command, [...args], {
		encoding: "utf8",
		timeout: 20_000,
		stdio: ["ignore", "pipe", "ignore"],
		env: { ...rest, FORCE_COLOR: "0" },
	});
};

function readJsonField(path: string, field: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const value = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[field];
		return typeof value === "string" && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The documented `claude --model` selectors. They name the vendor's current
 * model in each tier, so discovery lists them alongside the configured exact id:
 * a subscription exposes more than the one model its settings file happened to
 * save. `default` is appended only when the CLI names nothing at all.
 */
export const CLAUDE_MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;

function dedupe(models: readonly { model: string; source: string }[]): { model: string; source: string }[] {
	const seen = new Set<string>();
	return models.filter((entry) => (seen.has(entry.model) ? false : (seen.add(entry.model), true)));
}

/**
 * Claude's discoverable models: the configured exact id, then the documented
 * aliases. There is no supported enumeration interface on the CLI, so discovery
 * is explicitly incomplete here — the aliases plus the saved id, never a guessed
 * full id.
 */
function claudeModels(home: string): { model: string; source: string }[] {
	const configured = readJsonField(join(home, ".claude.json"), "model") ?? readJsonField(join(home, ".claude", "settings.json"), "model");
	const found = configured ? [{ model: configured, source: "claude settings" }] : [];
	for (const alias of CLAUDE_MODEL_ALIASES) found.push({ model: alias, source: "claude alias" });
	return dedupe(found);
}

/**
 * Codex's discoverable models, from the vendor's own local artifacts: the
 * configured model, any `[profiles.*]` model override, and the catalog the CLI
 * cached from its app-server `model/list`. No network, no invented flag.
 * `ponytail:` the cache is the CLI's, so a machine that never ran Codex lists
 * only its configured id — call it incomplete rather than probing a daemon.
 */
function codexModels(home: string): { model: string; source: string }[] {
	const found: { model: string; source: string }[] = [];
	const path = join(home, ".codex", "config.toml");
	if (existsSync(path)) {
		let section = "";
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
			if (header) {
				section = header[1] ?? "";
				continue;
			}
			const model = /^\s*model\s*=\s*"([^"]+)"/.exec(line)?.[1];
			if (!model) continue;
			if (section === "") found.push({ model, source: "codex config.toml" });
			else if (section.startsWith("profiles.")) found.push({ model, source: `codex profile ${section.slice("profiles.".length)}` });
		}
	}
	const cache = join(home, ".codex", "models_cache.json");
	if (existsSync(cache)) {
		try {
			const parsed = JSON.parse(readFileSync(cache, "utf8")) as { models?: { slug?: unknown; visibility?: unknown }[] };
			for (const model of parsed.models ?? []) {
				if (typeof model.slug === "string" && model.slug.length > 0 && model.visibility !== "hidden") {
					found.push({ model: model.slug, source: "codex model catalog" });
				}
			}
		} catch {
			// A cache mid-write is not a reason to lose the configured model.
		}
	}
	return dedupe(found);
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
			// `provider/model` per line, and only the provider LeanPi has a rate card
			// for: an `anthropic/…` line from the same list would otherwise be
			// written under OpenCode's base URL and priced with OpenCode's numbers.
			const listed = run("opencode", ["models"], env)
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.startsWith("opencode-go/"));
			if (listed.length > 0) return listed.map((model) => ({ vendor, model, source: "opencode models" }));
		} catch {
			// Not installed, not signed in, or offline — fall through to the config.
		}
		const configured = readJsonField(join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode", "opencode.json"), "model");
		return [{ vendor, model: configured ?? VENDOR_DEFAULT, source: configured ? "opencode.json" : "vendor default" }];
	}
	if (vendor === "codex") {
		const found = codexModels(home);
		return (found.length > 0 ? found : [{ model: VENDOR_DEFAULT, source: "vendor default" }]).map((entry) => ({ vendor, ...entry }));
	}
	return claudeModels(home).map((entry) => ({ vendor, ...entry }));
}

/**
 * Every model this machine can see, across every vendor CLI, whether or not a
 * role binds it and whether or not the vendor is signed in. This is the
 * inventory JEV is asked to judge: a signed-out vendor's models stay in the data
 * with their exclusion stated, rather than being dropped before the question.
 */
export function discoverInventory(
	options: { env?: NodeJS.ProcessEnv; home?: string; run?: Runner; verify?: boolean; states?: readonly SubscriptionState[]; ranking?: readonly RankedRecord[] } = {},
): DiscoveredModel[] {
	const states = options.states ?? detectVendors({ env: options.env, home: options.home, verify: options.verify, run: options.run });
	// The shipped ranking, joined by the same matcher role resolution uses. A
	// discovered id is the vendor CLI's spelling and the ranking's is the
	// leaderboard's; a model neither names keeps its explicit unknowns rather
	// than borrowing a neighbour's numbers.
	const ranking = options.ranking ?? bundledRecords();
	return states.flatMap((state) =>
		detectModels(state.vendor, { env: options.env, home: options.home, run: options.run }).map((candidate) => {
			const record = matchModel(ranking, candidate.model);
			return {
				...candidate,
				facts: {
					execution: "external_harness" as BackendType,
					availability: !state.onPath ? "not-installed" : state.signedIn ? "ready" : "signed-out",
					evidence: state.evidence,
					coding_score: record?.coding_score ?? null,
					price_blended_per_mtok: record?.price_blended_per_mtok ?? null,
				},
			};
		}),
	);
}

/** What the join needs off a ranking record; the ranking itself is PRD-024's. */
type RankedRecord = { model_id: string; aliases: readonly string[]; coding_score: number | null; price_blended_per_mtok: number | null };

/**
 * The shipped ranking, read without a config. First run has no config yet — that
 * is the run this inventory exists for — and the scores do not depend on one. An
 * unreadable ranking is not a reason to have no inventory: the models are still
 * discovered, with their metadata explicitly unknown.
 */
function bundledRecords(): RankedRecord[] {
	try {
		return parseRankingFile(JSON.parse(readFileSync(BUNDLED_RANKING_PATH, "utf8")), BUNDLED_RANKING_PATH).models;
	} catch {
		return [];
	}
}

export const ALLOCATE_SITE_ID = "bootstrap.role_models";

/** `vendor:model`, the key JEV chooses by and the map this module answers with. */
export function candidateKey(candidate: ModelCandidate): string {
	return `${candidate.backend ?? candidate.vendor}:${candidate.model}`;
}

/** The one line that states a model's availability, score and price — unknown included. */
export function modelFactsLine(facts: ModelFacts): string {
	const score = facts.coding_score === null ? "coding_score unknown" : `coding_score ${facts.coding_score}`;
	const price = facts.price_blended_per_mtok === null ? "price unknown" : `price $${facts.price_blended_per_mtok}/Mtok`;
	return `${facts.execution}, ${facts.availability}, ${score}, ${price}`;
}

function candidateLabel(candidate: ModelCandidate & { facts?: ModelFacts }): string {
	return candidate.facts ? `${candidate.vendor} ${candidate.model} (${modelFactsLine(candidate.facts)})` : `${candidate.vendor} ${candidate.model}`;
}

/**
 * One line per discovered model, ineligible ones included. This is the decision
 * data the JEV prompt carries: `state` is hashed in `metadata-only` mode, so
 * anything JEV must reason about has to travel inside the question itself.
 */
export function inventoryLines(inventory: readonly (ModelCandidate & { facts?: ModelFacts })[]): string[] {
	return inventory.map((candidate) => `${candidateKey(candidate)} (${candidate.facts ? modelFactsLine(candidate.facts) : "metadata unknown"})`);
}

const ROLE_QUESTION: Record<ModelRole, string> = {
	quick: "which model should serve short mechanical turns where cost dominates and capability is rarely the constraint?",
	balanced: "which model should serve ordinary feature work — the default turn?",
	strong: "which model should serve the hardest turns: unfamiliar, coupled, concurrency or performance-critical work?",
	specialist: "which model should serve work whose correctness depends on deep language or runtime knowledge?",
	review_quick: "which model should verify low-risk changes, where review must be cheap?",
	review_strong: "which model should verify high-risk changes, where a missed defect is expensive?",
};

export function allocationQuestions(candidates: readonly ModelCandidate[], inventory: readonly (ModelCandidate & { facts?: ModelFacts })[] = candidates): JevQuestion[] {
	// Only the usable candidates are options: JEV may pick a model, not a vendor
	// this machine cannot run. The full inventory — signed-out vendors included —
	// rides in the question text as decision data, so the exclusion is visible.
	const options: Record<string, string> = {};
	for (const candidate of candidates) {
		options[candidateKey(candidate)] = candidateLabel(candidate);
	}
	const data = inventoryLines(inventory).join("; ");
	return MODEL_ROLES.map((role) => ({
		id: role,
		kind: "Choice" as const,
		// The question names the criterion; the model ids are the options, so the
		// capability/price knowledge JEV applies is about these exact models. The
		// inventory line is the part `metadata-only` would otherwise hash away.
		text: `Models discovered on this machine: ${data}. Routing a coding harness across the subscriptions this machine has, ${ROLE_QUESTION[role]} Judge by published capability and price data for these models; unknown metadata is not evidence against a model.`,
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
	/** True when no role got a usable JEV answer. */
	fallbackUsed: boolean;
	/** The roles JEV decided, in `MODEL_ROLES` order; the rest took the ladder. */
	decided: ModelRole[];
}

export async function allocateRoles(
	client: Pick<JevClient, "ask" | "fallbackCount">,
	candidates: readonly ModelCandidate[],
	inventory: readonly (ModelCandidate & { facts?: ModelFacts })[] = candidates,
): Promise<Allocation> {
	if (candidates.length === 0) throw new Error("no model candidates to allocate");
	const questions = allocationQuestions(candidates, inventory);
	const fallback = ladderAllocation(candidates);
	ensureSite({
		id: ALLOCATE_SITE_ID,
		questions,
		returnType: questions.map(() => "Choice" as const),
		// Low, deliberately (§50's table): the answer lands in a config file the
		// user can read and edit, is printed at every startup, and its fallback is
		// a working ladder — the cost of a wrong pick is one edit, not a bad
		// change shipped. It also has to clear the bar *with* four or five
		// candidate models on the ballot, where an honest spread of probabilities
		// sits under the 0.7 normal threshold: measured live, every role came back
		// below it and the whole allocation fell back.
		consequence: "low",
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
		return { roles: fallback, fallbackUsed: true, decided: [] };
	}
	if (client.fallbackCount() > before) return { roles: fallback, fallbackUsed: true, decided: [] };
	// Per role, not all-or-nothing: six questions over a handful of models will
	// have one the model is genuinely unsure about — `review_quick` on a machine
	// with two near-equal cheap models — and throwing away five confident
	// answers because of it is how a control plane ends up never used. Each
	// unconfident role takes the ladder; the confident ones stand.
	const roles = {} as Record<ModelRole, ModelCandidate>;
	const decided: ModelRole[] = [];
	for (const role of MODEL_ROLES) {
		const result = results.find((entry) => entry.questionId === role);
		const chosen =
			result !== undefined && accept(result, "low") && result.kind === "Choice"
				? candidates.find((candidate) => candidateKey(candidate) === result.choice)
				: undefined;
		if (chosen) decided.push(role);
		roles[role] = chosen ?? fallback[role];
	}
	return { roles, fallbackUsed: decided.length === 0, decided };
}
