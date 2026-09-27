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

/** `pi-patty-bg-tasks`'s report of a command log that holds nothing yet. */
const EMPTY_LOG = "(no output yet)";

/** What a command that wrote nothing actually did. */
const NO_OUTPUT = "(no output)";

interface BackgroundToolResult {
	content?: Array<{ type?: string; text?: string }>;
}

interface BackgroundTool {
	name: string;
	execute?: (...args: unknown[]) => Promise<BackgroundToolResult>;
}

export interface BackgroundPi {
	registerTool(tool: BackgroundTool): void;
	on(event: "session_start", handler: () => Promise<void>): void;
}

/**
 * The package reads an empty command log as the sentinel `(no output yet)` and
 * hands that sentinel straight back: on success it is the whole result, and on a
 * non-zero exit it *is* the error message — the exit code is lost and "yet" reads
 * as still running. The exit code is not recoverable here (upstream keeps it), so
 * the report says what is true instead: a non-zero exit with nothing on it.
 */
function reportEmptyOutput(tool: BackgroundTool): BackgroundTool {
	const execute = tool.execute;
	if (execute === undefined) return tool;
	return {
		...tool,
		async execute(...args: unknown[]): Promise<BackgroundToolResult> {
			try {
				const result = await execute.apply(tool, args);
				return { ...result, content: result.content?.map((block) => (block.text === EMPTY_LOG ? { ...block, text: NO_OUTPUT } : block)) };
			} catch (error) {
				if (error instanceof Error && error.message === EMPTY_LOG) throw new Error("Command failed (non-zero exit) with no output");
				throw error;
			}
		},
	};
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
			if (bash !== undefined) pi.registerTool(reportEmptyOutput(bash));
		});
	};
}
