/**
 * `todo_add` on Pi's tool surface (PRD-025 Phase 4, ROADMAP §22).
 *
 * PRD-025 built the decision (`todo.needed`), the admission rule
 * (`admitTodoAdd`), the tool schema (`TODO_ADD_TOOL`) and the append
 * (`invokeTodoAdd`) — and nothing outside the tests ever called them. The list
 * could be written by `/todo` and derived from a PRD, but the model running the
 * turn had no way to put a step on it, so a multi-step task was tracked only if
 * the user tracked it by hand.
 *
 * Whether the list is warranted is `todo.needed`'s answer, not this module's:
 * `decideTodoNeeded` asks JEV and falls back to `todoNeededFallback` (an active
 * PRD, or MEDIUM/HIGH complexity) when JEV cannot answer, so a one-line task
 * costs no tool schema, no list and no block in the prompt. The answer is read
 * per call rather than captured at registration, because the tool is registered
 * once per session and warranted once per turn.
 */
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import { invokeTodoAdd, TODO_ADD_TOOL, TODO_ADD_TOOL_NAME } from "./render.js";
import type { TodoNeededDecision } from "./goal.js";
import { createTodoList, type TodoCarrier, type TodoGate } from "./state.js";

export interface TodoToolDeps {
	/** The session's list — the same carrier `/todo` and the prompt block read. */
	state: TodoCarrier;
	/** PRD-010's gate, so a derived item still cannot be self-completed. */
	gate?: () => TodoGate | undefined;
	/**
	 * `todo.needed` for the turn in flight, or `undefined` before one is compiled
	 * — which is the one state where nothing has judged this task, and so reads
	 * as "not warranted" rather than as permission.
	 */
	decision: () => TodoNeededDecision | undefined;
}

/** The tool's schema, as TypeBox, matching `TODO_ADD_TOOL.parameters`. */
const PARAMETERS = Type.Object(
	{
		text: Type.String({ description: "one line describing the step" }),
		phase: Type.Optional(Type.String({ description: "optional flat grouping label" })),
	},
	{ additionalProperties: false },
);

export function todoToolDefinition(deps: TodoToolDeps): ToolDefinition {
	return {
		name: TODO_ADD_TOOL_NAME,
		label: TODO_ADD_TOOL_NAME,
		description: TODO_ADD_TOOL.description,
		parameters: PARAMETERS,
		execute: async (_id, raw): Promise<AgentToolResult<unknown>> => {
			const params = raw as Static<typeof PARAMETERS>;
			const decision = deps.decision();
			const admitted = decision?.needed === true;
			const gate = deps.gate?.();
			const result = invokeTodoAdd({
				admission: {
					admitted,
					tools: admitted ? [TODO_ADD_TOOL] : [],
					refusal: admitted
						? null
						: { code: "not_warranted", message: `todo_add is not admitted for this task: ${decision?.reason ?? "no turn has been compiled yet"}` },
				},
				list: createTodoList(deps.state, gate === undefined ? {} : { gate }),
				text: params.text,
				...(params.phase === undefined ? {} : { phase: params.phase }),
			});
			return { content: [{ type: "text", text: result.text }], ...(result.ok ? {} : { isError: true }), details: {} };
		},
	} as ToolDefinition;
}

/** Puts `todo_add` on the session's tool surface. */
export function registerTodoTool(pi: ExtensionAPI, deps: TodoToolDeps): void {
	pi.registerTool(todoToolDefinition(deps));
}
