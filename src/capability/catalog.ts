/**
 * Owner-gated live catalog fetch (PRD-024, owner only).
 *
 * PRD-024 ships no network path: the ranking is the committed file, `loadRanking`
 * never imports this module, and `index.ts` does not re-export it, so the offline
 * loader's export surface carries no fetch, refresh or cache entry point (AC-1).
 *
 * This file exists only because the owner maintains the ranking and may want to
 * pull a keyed catalog while authoring it. It refuses to run unless
 * `LEANPI_CAPABILITY_LIVE_CATALOG=1` is set in the process environment, and the
 * response goes through the *same* validator as the shipped file — a fetched
 * document is never trusted more than a committed one.
 */
import { parseRankingFile, type RankingFile } from "./schema.js";

export const LIVE_CATALOG_FLAG = "LEANPI_CAPABILITY_LIVE_CATALOG";

export class LiveCatalogDisabledError extends Error {
	constructor() {
		super(`live catalog fetch is owner-gated: set ${LIVE_CATALOG_FLAG}=1 to enable it (the bundled ranking is the shipped path)`);
		this.name = "LiveCatalogDisabledError";
	}
}

export function liveCatalogEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env[LIVE_CATALOG_FLAG] === "1";
}

/** Fetch a keyed catalog and validate it exactly as the bundled file is validated. */
export async function fetchOwnerCatalog(url: string, apiKey: string | null, env: Record<string, string | undefined> = process.env): Promise<RankingFile> {
	if (!liveCatalogEnabled(env)) throw new LiveCatalogDisabledError();
	const response = await fetch(url, { headers: apiKey === null ? {} : { authorization: `Bearer ${apiKey}` } });
	if (!response.ok) throw new Error(`live catalog fetch ${url} failed: HTTP ${response.status}`);
	return parseRankingFile(await response.json(), url);
}
