/**
 * Public surface of MCP disclosure (PRD-006). `src/index.ts` re-exports this
 * barrel; `activate()` calls `registerMcpCommand` for the `/mcp` surface and
 * `registerMcpDisclosure` for the provider that fills `capabilities.mcps`.
 */
export * from "./catalog.js";
export * from "./client.js";
export * from "./select.js";
export * from "./tools.js";
export * from "./command.js";
