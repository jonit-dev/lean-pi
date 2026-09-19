/**
 * The minimal command registry (PRD-002 Phase 3).
 *
 * PRD-016 depends on PRD-002, so this PRD cannot wait for the full command
 * surface: it owns `register()` / `dispatch()`, duplicate-name rejection and the
 * unknown-command error, and PRD-016 extends the same module with argument
 * grammar, help and rendering. It holds no grammar, no help text and no
 * rendering of its own.
 */

export interface CommandContext {
	cwd: string;
	/** Interactive prompt; absent in non-interactive modes. */
	prompt?: (message: string) => Promise<string | undefined>;
	notify?: (message: string) => void;
}

export interface CommandResult {
	ok: boolean;
	text: string;
}

export type CommandHandler = (args: string, context: CommandContext) => Promise<CommandResult> | CommandResult;

export interface CommandRegistry {
	register(name: string, handler: CommandHandler): void;
	unregister(name: string): void;
	has(name: string): boolean;
	dispatch(line: string, context: CommandContext): Promise<CommandResult>;
	list(): string[];
}

export class DuplicateCommandError extends Error {
	constructor(name: string) {
		super(`Command "${name}" is already registered.`);
		this.name = "DuplicateCommandError";
	}
}

export function createCommandRegistry(): CommandRegistry {
	const handlers = new Map<string, CommandHandler>();
	return {
		register(name, handler) {
			if (handlers.has(name)) throw new DuplicateCommandError(name);
			handlers.set(name, handler);
		},
		unregister(name) {
			handlers.delete(name);
		},
		has: (name) => handlers.has(name),
		async dispatch(line, context) {
			const trimmed = line.trim().replace(/^\//, "");
			const separator = trimmed.search(/\s/);
			const name = separator === -1 ? trimmed : trimmed.slice(0, separator);
			const args = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
			const handler = handlers.get(name);
			if (!handler) return { ok: false, text: `unknown command: /${name}` };
			return handler(args, context);
		},
		list: () => [...handlers.keys()],
	};
}

/** The process-wide registry `activate()` registers into; PRD-016 extends it. */
export const commandRegistry: CommandRegistry = createCommandRegistry();
