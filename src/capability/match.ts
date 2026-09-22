/**
 * Local model ids, matched to the ranking's records (PRD-030 root 2).
 *
 * The ranking is scraped from a published leaderboard, so its ids are that
 * leaderboard's spellings — `claude-opus-5`, `gpt-5-6-sol`, `deepseek-v4-1-flash`.
 * What the machine reports is whatever the vendor CLI calls the same model:
 * `opus[1m]` from Claude's settings, `gpt-5.6-sol` from Codex's catalog,
 * `opencode-go/deepseek-v4.1-flash` from `opencode models`. Neither side is
 * going to change for the other, so the join happens here, at match time, and
 * the data stays a faithful copy of its source.
 *
 * Every rule below is a spelling rule except one: a vendor's *moving* alias
 * (`claude --model opus`) names whichever model that vendor currently ships in
 * the tier. That is a claim about the world that goes stale, so it lives in one
 * table that says so, rather than being spread through the data as aliases.
 */

/**
 * The Claude CLI's documented tier selectors (`claude --model opus`). Each names
 * whichever model the vendor currently ships in that tier, which no committed
 * table can know, so the tier is resolved against the ranking instead: the
 * highest-scoring record of that family. That answer is grounded in the data and
 * re-derives itself on the next scrape, where a hardcoded `claude-opus-5` would
 * quietly rot — and where a guess at `claude-haiku-5` names a record the
 * leaderboard does not carry at all.
 */
const CLI_TIERS: Record<string, RegExp> = {
	opus: /^claude.*opus/,
	sonnet: /^claude.*sonnet/,
	haiku: /^claude.*haiku/,
};

/** `opencode-go/deepseek-v4.1-flash` → `deepseek-v4.1-flash`: the provider is the backend's business. */
function withoutProvider(id: string): string {
	const slash = id.lastIndexOf("/");
	return slash < 0 ? id : id.slice(slash + 1);
}

/**
 * The spellings one local id could be written as on the leaderboard, best first.
 * Each is a mechanical rewrite of the last — nothing here invents a model.
 */
export function idCandidates(local: string): string[] {
	const base = withoutProvider(local.trim().toLowerCase());
	// `opus[1m]` is Claude's 1M-context variant of a tier alias; the leaderboard
	// ranks the model, not the context window it was dialed with.
	const bare = base.replace(/\[[^\]]*\]$/, "");
	const dashed = bare.replaceAll(".", "-");
	const candidates = [local, base, bare, dashed];
	// A vendor suffix the leaderboard does not carry — OpenCode's plan tier in
	// `muse-spark-1.3-contributor`. Tried last, so it can never beat an exact id.
	const trimmed = dashed.replace(/-[a-z]+$/, "");
	if (trimmed !== dashed && trimmed.length > 0) candidates.push(trimmed);
	return [...new Set(candidates.filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0))];
}

/** Whether this local id is a vendor tier selector rather than a model id. */
function tierOf(local: string): RegExp | undefined {
	return CLI_TIERS[withoutProvider(local.trim().toLowerCase()).replace(/\[[^\]]*\]$/, "")];
}

/** The first record any spelling of `local` names, or undefined. */
export function matchModel<T extends { model_id: string; aliases: readonly string[]; coding_score?: number | null }>(
	records: readonly T[],
	local: string,
): T | undefined {
	for (const candidate of idCandidates(local)) {
		const found = records.find((record) => record.model_id.toLowerCase() === candidate || record.aliases.some((alias) => alias.toLowerCase() === candidate));
		if (found) return found;
	}
	// A local id that is the leading part of exactly one record's id: the
	// leaderboard writes `qwen3-coder-480b-a35b-instruct` where a config says
	// `qwen3-coder-480b-a35b`. "Exactly one" is the whole safeguard — `gpt-5`
	// leads a dozen records and therefore names none of them.
	const dashed = idCandidates(local).at(-1);
	if (dashed !== undefined) {
		const prefixed = records.filter((record) => record.model_id.toLowerCase().startsWith(`${dashed}-`));
		if (prefixed.length === 1) return prefixed[0];
	}

	const tier = tierOf(local);
	if (tier === undefined) return undefined;
	// Best-ranked wins the tier. Records with no score cannot win it: an unranked
	// model is not evidence that it is the vendor's current flagship.
	return records
		.filter((record) => tier.test(record.model_id.toLowerCase()) && typeof record.coding_score === "number")
		.sort((a, b) => (b.coding_score ?? 0) - (a.coding_score ?? 0))[0];
}
