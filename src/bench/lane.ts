/**
 * The bench lane entry: `npm run bench -- <args>`.
 *
 * `src/bench/` owns the harness; this file exists only to hand it the one
 * dependency that lives in the package entry — PRD-001's `createLeanPiSession()`
 * — so the bench modules themselves never import the barrel.
 *
 * `package.json`: `"bench": "tsc -p tsconfig.json && node dist/bench/lane.js"`.
 * The run is guarded on being the executed entry point, so importing the lane
 * (`runArgv`) from a test starts nothing.
 */
import { pathToFileURL } from "node:url";
import { createLeanPiSession } from "../index.js";
import { main, type CliIo } from "./cli.js";
import type { BenchAttempt } from "./types.js";
import type { LeanPiConfig } from "../core/types.js";

/** The session factory a `leanpi` row boots through: the package entry's own boot path. */
export function leanPiSessionFactory(attempt: BenchAttempt, config: LeanPiConfig) {
	return createLeanPiSession({ cwd: attempt.workspace, config });
}

/** `main()` with the lane's dependencies wired; the test seam is the options object. */
export function runArgv(argv: string[], options: { cwd?: string; io?: CliIo } = {}): Promise<number> {
	return main(argv, {
		cwd: options.cwd ?? process.cwd(),
		...(options.io ? { io: options.io } : {}),
		adapterDeps: { session: leanPiSessionFactory },
	});
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	process.exitCode = await runArgv(process.argv.slice(2));
}
