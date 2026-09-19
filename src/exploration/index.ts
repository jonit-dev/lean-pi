/**
 * The exploration governor (PRD-023): candidates in, a bounded selection out.
 *
 * `explore()` is the entry point; `createExplorationSession()` is the seam a
 * session wires `session.explore(request)` to.
 */
export * from "./budget.js";
export * from "./gather.js";
export * from "./governor.js";
export * from "./rank.js";
export * from "./sites.js";
export * from "./tests.js";
