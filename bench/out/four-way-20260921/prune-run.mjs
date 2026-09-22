#!/usr/bin/env node
/**
 * Prune a paid run directory down to its evidence (repo rule, `bench/out/<run>`).
 *
 * A raw attempt is ~180 MB: `workspace/` is a full clone of the fixture with
 * its `node_modules`. The evidence is ~1 MB — the record, the telemetry ledger,
 * the JEV decisions, the final `index.js` and the arm's logs — so this copies
 * the two workspace files worth keeping out, then deletes the checkout, the
 * agent dir and any codex home before they reach git.
 *
 * `bench/out/real-session-audit-20260921/fixtures/**` is deliberately out of
 * scope: its `node_modules` is a test dependency, not run litter.
 *
 * Usage: node prune-run.mjs bench/out/<run> [...]
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Copied out of the throwaway workspace before it is deleted. */
const COPY = [
	["workspace/.leanpi/decisions.jsonl", "decisions.jsonl"],
	["workspace/index.js", "solution-index.js"],
];
/** Directories that only ever hold a run's litter. */
const DROP = ["workspace", "agentdir", "codex-home", ".bench-agent", "preflight/accept"];

let failed = false;
for (const root of process.argv.slice(2)) {
	const attempts = join(root, "attempts");
	if (!existsSync(attempts)) {
		console.error(`skip ${root}: no attempts/ directory`);
		failed = true;
		continue;
	}
	let pruned = 0;
	for (const name of readdirSync(attempts)) {
		const dir = join(attempts, name);
		if (!statSync(dir).isDirectory()) continue;
		for (const [from, to] of COPY) {
			const src = join(dir, from);
			if (existsSync(src) && !existsSync(join(dir, to))) cpSync(src, join(dir, to));
		}
		for (const drop of DROP) rmSync(join(dir, drop), { recursive: true, force: true });
		pruned += 1;
	}
	rmSync(join(root, "preflight/accept"), { recursive: true, force: true });
	console.log(`${root}: pruned ${pruned} attempt(s)`);
}
process.exit(failed ? 1 : 0);
