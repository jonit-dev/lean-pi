/**
 * Public surface of MCP disclosure (PRD-006). `src/index.ts` re-exports this
 * barrel; `activate()` builds the runtime, registers the provider and calls
 * `registerMcpCommand`.
 */
export * from "./catalog.js";
export * from "./client.js";
export * from "./select.js";
export * from "./tools.js";
export * from "./command.js";
