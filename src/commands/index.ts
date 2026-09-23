/**
 * The command surface's single registration point (PRD-016 Phase 1).
 *
 * Every PRD registers into `src/commands/registry.ts`; this module registers
 * the commands PRD-016 owns and hands back the session state they share.
 * Nothing else stands up a second dispatcher, which is why `/help` is complete
 * without knowing who registered what.
 *
 * Commands Pi already ships interactively (`/new`, `/resume`, `/tree`) are
 * deliberately absent: bridged into Pi's slash-command surface they would
 * shadow Pi's own with weaker re-implementations. `/model` is the one
 * exception, and shadowing is the point: Pi's lists only its own registry,
 * LeanPi's lists the vendor CLIs the machine can actually run. LeanPi's
 * deterministic reduction survives under its own name, `/compact-refs`: it
 * rewrites repeated blocks to `artifact://` references and spends no tokens,
 * where Pi's `/compact` asks a model for a summary. `/clear`, an alias for
 * `/new`, is absent for the same reason and registered straight onto Pi by
 * `registerClearAlias` (`src/index.ts`), not through this registry.
 */
import { registerConfigCommand } from "./config.js";
import { registerContextCommands } from "./context.js";
import { registerDoctorCommand } from "./doctor.js";
import { registerHelpCommand } from "./help.js";
import { registerModelCommands } from "./model.js";
import { registerRecapCommand } from "./recap.js";
import type { CommandRegistry } from "./registry.js";
import { registerRoleCommands } from "./role.js";
import { registerRouteCommand } from "./route.js";
import { registerStatusCommand } from "./status.js";
import { createCommandSurface, type CommandSurface, type CommandSurfaceDeps } from "./surface.js";

export { commandRegistry } from "./registry.js";
export type { Command, CommandContext, CommandHandler, CommandRegistry, CommandResult } from "./registry.js";
export { createCommandSurface, createSessionHost } from "./surface.js";
export type { CommandSurface, CommandSurfaceDeps, ProbeResult, RoleBinding, SessionHost } from "./surface.js";
export { renderHelp } from "./help.js";
export { renderStatus } from "./status.js";
export { renderConfig } from "./config.js";
export { renderModels } from "./role.js";
export { doctorRows, renderDoctor, worstStatus } from "./doctor.js";
export { renderRoute, routeLines, jevLine } from "./route.js";
export { contextReport, renderContextReport } from "./context.js";

/** The commands PRD-016 owns, in the order `/help` lists them. */
export const OWNED_COMMANDS = ["help", "status", "model", "role", "route", "context", "compact-refs", "config", "doctor", "recap"] as const;

/**
 * The commands the other PRDs own and `activate()` registers: PRD-025's `/todo`,
 * PRD-013's `/goal`, PRD-011's `/review` and PRD-012's `/prd`. They are named
 * here so a second activation in one process replaces them like the owned twelve
 * rather than colliding with them (`register` rejects a duplicate name).
 */
export const PRD_OWNED_COMMANDS = ["todo", "goal", "review", "prd"] as const;

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
	registerRoleCommands(registry, surface);
	registerRouteCommand(registry, surface);
	registerContextCommands(registry, surface);
	registerConfigCommand(registry, surface);
	registerDoctorCommand(registry, surface);
	registerRecapCommand(registry, deps.recap ? { recap: deps.recap } : {});
	return surface;
}
