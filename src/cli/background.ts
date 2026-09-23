/**
 * The `pi-patty-bg-tasks` adapter: its backgrounding `bash` under either UI.
 *
 * The package overrides `bash`, and so does `pi-claude-code-ui` (`--ui compact`,
 * the default). Two things in Pi's own code follow, and neither is the
 * registration refusal the old gate assumed:
 *
 * - The resource loader reports a tool name that two extensions registered while
 *   loading as an extension error (`detectExtensionConflicts`), and Pi's CLI
 *   exits 1 on any startup error. That was the launch crash. The check runs once,
 *   over what each factory registered at load.
 * - At runtime the *first* extension in load order that owns a name wins
 *   (`ExtensionRunner.getAllRegisteredTools`). Attached after the compact UI, the
 *   package's `bash` — auto-background after 120s, `run_in_background`, the
 *   Ctrl+B hint — would load and never run.
 *
 * So the factory runs against a `Proxy` that holds its `bash` back and registers
 * it on `session_start`, after the load-time check, and the launcher attaches the
 * adapter ahead of the compact UI so it is the first owner. The compact UI's
 * bash-row renderer lives on its own definition, so this `bash` renders with Pi's
 * own bash rows (the definition the package spreads), as under `--ui plain`.
 * Every other registration — `bash_bg`, `jobs`, `job_decide`, `monitor`, Ctrl+B,
 * `/bg` — forwards untouched.
 */
interface BackgroundTool {
	name: string;
}

export interface BackgroundPi {
	registerTool(tool: BackgroundTool): void;
	on(event: "session_start", handler: () => Promise<void>): void;
}

export function backgroundTasksAdapter(bundled: (pi: BackgroundPi) => void): (pi: BackgroundPi) => void {
	return (pi: BackgroundPi) => {
		let bash: BackgroundTool | undefined;
		const proxy = new Proxy(pi, {
			get(target, property) {
				if (property === "registerTool") {
					return (tool: BackgroundTool) => {
						if (tool.name === "bash") {
							bash = tool;
							return;
						}
						target.registerTool(tool);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		bundled(proxy);
		pi.on("session_start", async () => {
			if (bash !== undefined) pi.registerTool(bash);
		});
	};
}
