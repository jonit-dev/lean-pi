/**
 * The command registry (PRD-002 created the dispatcher; PRD-016 owns the
 * surface).
 *
 * One `Map<string, Command>` plus `register()` and `dispatch()`. Deliberately a
 * map and not a plugin framework: no lifecycle hooks, no middleware chain, no
 * per-command permission layer (permissions are PRD-017's, enforced at the tool
 * boundary). Every PRD registers its command here rather than standing up a
 * second dispatcher, which is what makes `/help` complete for free.
 *
 * Registration accepts either a `Command` or the positional
 * `(name, handler, init?)` form the earlier PRDs already use, so extending the
 * registry added the summary/usage fields without editing callers.
 */

export interface CommandContext {
	cwd: string;
	/** Interactive prompt; absent in non-interactive modes. */
	prompt?: (message: string) => Promise<string | undefined>;
	notify?: (message: string) => void;
	/**
	 * Pi's live session facts, present only when the command came from Pi's TUI.
	 * LeanPi's own `SessionManager` is not the one Pi writes turns to, so a
	 * command that wants a *measured* session number must read it from here and
	 * say so when it is absent rather than deriving a plausible one.
	 */
	session?: {
		id: string;
		/** Pi's own context usage for the active model; null when Pi does not know yet. */
		contextTokens: number | null;
		contextWindow: number;
		model?: string;
		thinkingLevel?: string;
	};
}

export interface CommandResult {
	ok: boolean;
	text: string;
	/**
	 * A prompt the bridge should send as a user message once the command's echo
	 * is shown. `/goal <text>` sets *and* starts: without this the session sat
	 * idle after the echo and only moved when the user typed again.
	 */
	start?: string;
}

export type CommandHandler = (args: string, context: CommandContext) => Promise<CommandResult> | CommandResult;

/** One registered command: what `/help` renders and `dispatch()` runs. */
export interface Command {
	name: string;
	/** One line, no trailing period required; `/help` prints it verbatim. */
	summary: string;
	usage: string;
	run: CommandHandler;
}

/** The metadata a positional `register()` call may attach to its handler. */
export interface CommandInit {
	summary?: string;
	usage?: string;
}

export interface CommandRegistry {
	register(command: Command): void;
	register(name: string, handler: CommandHandler, init?: CommandInit): void;
	unregister(name: string): void;
	has(name: string): boolean;
	dispatch(line: string, context: CommandContext): Promise<CommandResult>;
	/** Registered names, insertion order. */
	list(): string[];
	/** Every registered command, insertion order; `/help` renders exactly this. */
	entries(): Command[];
	get(name: string): Command | undefined;
	/** Nearest registered name by Levenshtein distance, or `undefined` for an empty registry. */
	nearest(name: string): string | undefined;
}

export class DuplicateCommandError extends Error {
	constructor(name: string) {
		super(`Command "${name}" is already registered.`);
		this.name = "DuplicateCommandError";
	}
}

/** Plain Levenshtein over two short names; no fuzzy-search dependency (PRD-016). */
export function levenshtein(left: string, right: string): number {
	if (left === right) return 0;
	const previous = new Array<number>(right.length + 1);
	const current = new Array<number>(right.length + 1);
	for (let column = 0; column <= right.length; column += 1) previous[column] = column;
	for (let row = 1; row <= left.length; row += 1) {
		current[0] = row;
		for (let column = 1; column <= right.length; column += 1) {
			const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
			current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution);
		}
		for (let column = 0; column <= right.length; column += 1) previous[column] = current[column]!;
	}
	return previous[right.length]!;
}

function isCommand(value: string | Command): value is Command {
	return typeof value !== "string";
}

export function createCommandRegistry(): CommandRegistry {
	const commands = new Map<string, Command>();

	const nearest = (name: string): string | undefined => {
		let best: string | undefined;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (const candidate of commands.keys()) {
			const distance = levenshtein(name, candidate);
			if (distance < bestDistance) {
				bestDistance = distance;
				best = candidate;
			}
		}
		return best;
	};

	const register = (nameOrCommand: string | Command, handler?: CommandHandler, init?: CommandInit): void => {
		const command: Command = isCommand(nameOrCommand)
			? nameOrCommand
			: {
					name: nameOrCommand,
					summary: init?.summary ?? "",
					usage: init?.usage ?? `/${nameOrCommand}`,
					run: handler as CommandHandler,
				};
		if (commands.has(command.name)) throw new DuplicateCommandError(command.name);
		commands.set(command.name, command);
	};

	return {
		register,
		unregister(name) {
			commands.delete(name);
		},
		has: (name) => commands.has(name),
		get: (name) => commands.get(name),
		entries: () => [...commands.values()],
		list: () => [...commands.keys()],
		nearest,
		async dispatch(line, context) {
			const trimmed = line.trim().replace(/^\//, "");
			const separator = trimmed.search(/\s/);
			const name = separator === -1 ? trimmed : trimmed.slice(0, separator);
			const args = separator === -1 ? "" : trimmed.slice(separator + 1).trim();
			const command = commands.get(name);
			if (!command) {
				const suggestion = nearest(name);
				return { ok: false, text: `unknown command \`/${name}\`${suggestion ? ` — did you mean \`/${suggestion}\`?` : ""}` };
			}
			// A handler bug is a message, never a crashed session.
			try {
				return await command.run(args, context);
			} catch (error) {
				return { ok: false, text: `/${name} failed: ${error instanceof Error ? error.message : String(error)}` };
			}
		},
	};
}

/** Upsert: a later session supersedes the earlier handler of the same name. */
export function upsertCommand(
	registry: CommandRegistry,
	name: string,
	handler: CommandHandler,
	init?: CommandInit,
): void {
	if (registry.has(name)) registry.unregister(name);
	registry.register(name, handler, init);
}

/** The process-wide registry `activate()` registers into; PRD-016 extends it. */
export const commandRegistry: CommandRegistry = createCommandRegistry();
