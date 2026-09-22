/**
 * Regenerate `src/capability/models.json` from Artificial Analysis' public
 * leaderboard. Run by hand, by a maintainer, and the result is committed:
 *
 *     node scripts/capability-scrape.mjs
 *
 * PRD-024 keeps the *runtime* free of any fetch — `src/capability/` makes zero
 * network calls and its AC-1 spec asserts that with network spies. Nothing here
 * changes that: this script is not imported by the package, is not wired into
 * build, prepack or install, and the shipped artifact is still the committed
 * JSON file whose provenance is a reviewed pull request. It replaces a
 * maintainer typing numbers by hand, not the file they type them into.
 *
 * Source: https://artificialanalysis.ai/leaderboards/models — the page embeds
 * its table as JSON in the Next.js flight payload, so there is no API key, no
 * headless browser and no HTML scraping of rendered rows.
 */
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "https://artificialanalysis.ai/leaderboards/models";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "capability", "models.json");

/**
 * The leaderboard rows, out of the flight payload.
 *
 * Next.js streams the page as `self.__next_f.push([1, "<json-escaped chunk>"])`
 * calls whose chunks concatenate into one document. The table is the `models`
 * array of the component that carries `intelligenceIndex`, which is the field
 * that distinguishes it from the two smaller model lists on the same page.
 */
function extractRows(html) {
	const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map((match) => JSON.parse(match[1]));
	const blob = chunks.join("");
	const marker = blob.indexOf('"intelligenceIndex"');
	if (marker < 0) throw new Error("no intelligenceIndex in the payload — the page's shape changed");
	// Walk back to the `[` that opens the array this record sits in, then forward
	// to its match. Scanning beats a regex here: the records contain brackets.
	const start = blob.lastIndexOf('"models":[', marker) + '"models":'.length;
	if (start < '"models":'.length) throw new Error("no models array around the leaderboard rows");
	let depth = 0;
	for (let i = start; i < blob.length; i++) {
		if (blob[i] === "[") depth++;
		else if (blob[i] === "]" && --depth === 0) return JSON.parse(blob.slice(start, i + 1));
	}
	throw new Error("unterminated models array");
}

/** `medianOutputTokensPerSecond` into the three tiers the schema carries. */
function speedTier(tokensPerSecond) {
	if (typeof tokensPerSecond !== "number") return "medium";
	return tokensPerSecond >= 120 ? "fast" : tokensPerSecond >= 40 ? "medium" : "slow";
}

/** The 3:1 input:output blend the schema documents as the "cheapest" number. */
function blended(input, output) {
	if (typeof input !== "number" || typeof output !== "number") return null;
	return Math.round(((input * 3 + output) / 4) * 10_000) / 10_000;
}

/**
 * Spellings a vendor CLI or a config may use for the same model, so a local id
 * resolves to exactly one record. Only mechanical restatements of the slug and
 * the published name — never a guess that one model stands in for another.
 */
function aliasesFor(row) {
	const aliases = new Set([row.slug.replaceAll("-", "."), row.name.toLowerCase().replaceAll(" ", "-")]);
	// `gpt-5-6-sol` is how the leaderboard spells the id the CLIs call
	// `gpt-5.6-sol`; the same rewrite covers `deepseek-v4-1-flash`.
	aliases.add(row.slug.replace(/-(\d+)-(\d+)-/g, "-$1.$2-"));
	aliases.delete(row.slug);
	return [...aliases].filter((alias) => alias.length > 0);
}

const html = await fetch(SOURCE, { headers: { "user-agent": "leanpi-capability-scrape" } }).then((response) => {
	if (!response.ok) throw new Error(`${SOURCE} answered ${response.status}`);
	return response.text();
});
const rows = extractRows(html).filter((row) => typeof row.intelligenceIndex === "number");
// The index is rescaled so the snapshot's best model sits at 100, which is the
// one transform that puts a published number on the 0-100 scale the role floors
// (`min_coding_index`) are configured against without inventing a value: it is
// monotonic in the source and carries no per-model judgement.
const top = Math.max(...rows.map((row) => row.intelligenceIndex));
const today = new Date().toISOString().slice(0, 10);

// An alias is only useful if it names exactly one model. Mechanical restatements
// collide — `step-3-5-flash-0202` restates to `step-3.5-flash`, which is already
// `step-3-5-flash`'s — and the schema rejects the file for it, correctly. A
// contested spelling resolves to nothing, so it is dropped from every record
// rather than awarded to whichever was scraped first.
const ids = new Set(rows.map((row) => row.slug));
const claims = new Map();
for (const row of rows) for (const alias of aliasesFor(row)) claims.set(alias, (claims.get(alias) ?? 0) + 1);
const usable = (alias) => claims.get(alias) === 1 && !ids.has(alias);

const models = rows.map((row) => {
	const score = Math.round((row.intelligenceIndex / top) * 100);
	return {
		model_id: row.slug,
		aliases: aliasesFor(row).filter(usable),
		provider: row.modelCreatorName ?? "unknown",
		backend_hint: null,
		coding_score: score,
		general_score: score,
		specializations: [],
		price_input_per_mtok: row.price1mInputTokens ?? null,
		price_output_per_mtok: row.price1mOutputTokens ?? null,
		price_blended_per_mtok: blended(row.price1mInputTokens, row.price1mOutputTokens),
		speed_tier: speedTier(row.medianOutputTokensPerSecond),
		context_window: row.contextWindowTokens ?? null,
		updated_at: today,
		// `measured` is reserved for LeanPi's own PRD-021 benchmark runs. These are
		// someone else's measurements, however carefully made, so every record
		// scraped here is `estimated` and the note says whose numbers they are.
		evidence: "estimated",
	};
});

const document = {
	revision: 3,
	notes: [
		`Artificial Analysis Intelligence Index, scraped from ${SOURCE} on ${today} by scripts/capability-scrape.mjs.`,
		`coding_score and general_score are that index rescaled so the snapshot's highest-scoring model (${rows.find((row) => row.intelligenceIndex === top).slug}, ${top.toFixed(2)}) is 100;`,
		"the transform is monotonic in the published number and adds no per-model judgement.",
		"The index is a composite that includes coding benchmarks; LeanPi has no separate coding-only index with comparable coverage, so both fields carry it.",
		"Prices are the leaderboard's published per-million-token figures; price_blended_per_mtok is the schema's 3:1 input:output blend.",
		"evidence is 'estimated' on every record: 'measured' is reserved for LeanPi's own PRD-021 runs.",
		"Data: Artificial Analysis (artificialanalysis.ai). Regenerate with `node scripts/capability-scrape.mjs`; there is no runtime fetch.",
	].join(" "),
	models,
};

writeFileSync(OUT, `${JSON.stringify(document, null, "\t")}\n`);
console.log(`wrote ${models.length} records to ${OUT} (top ${top.toFixed(2)} → 100)`);
