/**
 * `/help` — the registry rendered (PRD-016 Phase 1, FR-140).
 *
 * The listing is registry-driven: a command registered by any PRD appears here
 * with no edit to this module, which is what makes the one registration point
 * worth having. Commands whose registrar attached no summary fall back to the
 * built-in line below — never to a hidden or unlisted command.
 */
import type { Command, CommandRegistry, CommandResult } from "./registry.js";

/** One line for each shared-surface command whose PRD registered no metadata. */
const BUILTIN_SUMMARIES: Record<string, string> = {
	goal: "show the active goal and its acceptance criteria (PRD-013)",
	review: "run the reviewer lane over the current diff (PRD-011)",
	prd: "author, inspect and close the active PRD (PRD-012)",
	skills: "list, enable, disable or pin skills (PRD-005)",
	mcp: "list, enable, disable or refresh MCP servers (PRD-006)",
	permissions: "show or change the permission state (PRD-017)",
	jev: "JEV status, setup, key management and privacy mode (PRD-002)",
	cost: "session cost, per task and per verified success (PRD-015)",
};

export function renderHelp(registry: CommandRegistry): string {
	const commands = registry.entries();
	if (commands.length === 0) return "no commands registered";
	const width = Math.max(...commands.map((command) => command.name.length + 1));
	const rows = commands.map((command: Command): string => {
		const summary = command.summary.length > 0 ? command.summary : (BUILTIN_SUMMARIES[command.name] ?? "no summary registered");
		return `/${command.name.padEnd(width)}  ${summary}`;
	});
	return ["LeanPi commands:", ...rows].join("\n");
}

export function registerHelpCommand(registry: CommandRegistry): void {
	registry.register({
		name: "help",
		summary: "list every registered command, or one command's usage",
		usage: "/help [command]",
		run: (args): CommandResult => {
			const name = args.trim().replace(/^\//, "");
			if (name.length === 0) return { ok: true, text: renderHelp(registry) };
			const command = registry.get(name);
			if (!command) {
				const suggestion = registry.nearest(name);
				return { ok: false, text: `unknown command \`/${name}\`${suggestion ? ` — did you mean \`/${suggestion}\`?` : ""}` };
			}
			const summary = command.summary.length > 0 ? command.summary : (BUILTIN_SUMMARIES[command.name] ?? "no summary registered");
			return { ok: true, text: `/${command.name} — ${summary}\nusage: ${command.usage}` };
		},
	});
}
