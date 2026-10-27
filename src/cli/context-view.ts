/**
 * The `pi-context-view` adapter: its viewer under `/context-view` (PRD-059).
 *
 * The package registers `context`, which LeanPi's own `/context` already owns
 * (`src/commands/context.ts`). Pi renames two `context` registrations to
 * `context:1`/`context:2`, so `/context` would resolve to neither. The factory
 * runs against a `Proxy` that registers that one command as `context-view`;
 * every other registration and event forwards untouched.
 */
export interface CommandPi {
	registerCommand(name: string, command: unknown): void;
}

export function contextViewAdapter<Pi extends CommandPi>(bundled: (pi: Pi) => void): (pi: Pi) => void {
	return (pi: Pi) => {
		const proxy = new Proxy(pi, {
			get(target, property) {
				if (property === "registerCommand") {
					return (name: string, command: unknown) => target.registerCommand(name === "context" ? "context-view" : name, command);
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		bundled(proxy);
	};
}
