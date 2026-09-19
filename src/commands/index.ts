/**
 * The command surface's single registration point (PRD-016 Phase 1).
 *
 * Every PRD registers into `src/commands/registry.ts`; this module registers
 * the twelve commands PRD-016 owns and hands back the session state they share.
 * Nothing else stands up a second dispatcher, which is why `/help` is complete
 * without knowing who registered what.
 */
import { registerConfigCommand } from "./config.js";
import { registerContextCommands } from "./context.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerHelpCommand } from "./help.js";
import { registerModelCommands } from "./model.js";
import type { CommandRegistry } from "./registry.js";
import { registerRouteCommand } from "./route.js";
import { registerSessionCommands } from "./session-commands.js";
import { registerStatusCommand } from "./status.js";
import { createCommandSurface, type CommandSurface, type CommandSurfaceDeps } from "./surface.js";

export { commandRegistry } from "./registry.js";
export type { Command, CommandContext, CommandHandler, CommandRegistry, CommandResult } from "./registry.js";
export { createCommandSurface, createSessionHost } from "./surface.js";
export type { CommandSurface, CommandSurfaceDeps, ProbeResult, RoleBinding, SessionHost } from "./surface.js";
export { renderHelp } from "./help.js";
export { renderStatus } from "./status.js";
export { renderConfig } from "./config.js";
export { renderBindings, renderModels } from "./model.js";
export { doctorRows, renderDoctor, worstStatus } from "./doctor.js";
export { renderRoute, routeLines, jevLine } from "./route.js";
export { renderTree } from "./session-commands.js";
export { contextReport, renderContextReport } from "./context.js";

/** The twelve commands PRD-016 owns, in the order `/help` lists them. */
export const OWNED_COMMANDS = [
	"help",
	"status",
	"model",
	"models",
	"route",
	"context",
	"compact",
	"tree",
	"config",
	"doctor",
	"new",
	"resume",
] as const;

/**
 * Register the owned handlers and return the session state they share. A later
 * session supersedes the earlier handlers, exactly like `/jev` and `/skills`, so
 * `activate()` may run more than once in one process.
 */
export function registerCommandSurface(registry: CommandRegistry, deps: CommandSurfaceDeps): CommandSurface {
	const surface = createCommandSurface(deps);
	for (const name of OWNED_COMMANDS) if (registry.has(name)) registry.unregister(name);

	registerHelpCommand(registry);
	registerStatusCommand(registry, surface);
	registerModelCommands(registry, surface);
	registerRouteCommand(registry, surface);
	registerContextCommands(registry, surface);
	registerSessionCommands(registry, surface);
	registerConfigCommand(registry, surface);
	registerDoctorCommand(registry, surface);
	return surface;
}
