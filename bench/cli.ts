/**
 * PRD-021's lane entry, at the path the PRD names.
 *
 * The implementation lives in `src/bench/lane.ts` so it compiles with the rest of
 * the package (`dist/bench/lane.js`, which the `bench` npm script runs). This
 * file is the same entry for a TypeScript-aware loader.
 */
export { leanPiSessionFactory, runArgv } from "../src/bench/lane.js";
