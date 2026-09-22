/**
 * `todo_add` and `todo_update` on Pi's tool surface (PRD-025 Phase 4, ROADMAP §22).
 *
 * PRD-025 built the tool schema (`TODO_ADD_TOOL`) and the append
 * (`invokeTodoAdd`) — and nothing outside the tests ever called them. The list
 * could be written by `/todo` and derived from a PRD, but the model running the
 * turn had no way to put a step on it, so a multi-step task was tracked only if
 * the user tracked it by hand.
 *
 * `todo_update` closes the other half of that hole. With append as the only
 * handle, a step the executor opened could only be closed by the user typing
 * `/todo done`: the widget showed a list that never moved and PRD-013's
 * boundary, which reads `remainingWork()`, could never drain it. The update tool
 * routes through the same transitions `/todo` drives, so a derived item still
 * meets PRD-010's gate and is refused without a `PASS`.
 *
 * Whether a list is warranted is the executor's call. PRD-025 originally
 * gated this tool on a `todo.needed` JEV site fed the raw user turn, which
 * judged resume-shaped turns ("start it") on a string carrying no task: it
 * answered `no` at 0.59 for a HIGH-complexity, five-step PRD turn and refused
 * every append in it. The gate bought nothing — the schema is registered
 * unconditionally and the prompt block only appears once the list has items —
 * so the decision now belongs to the model, which is the party that knows how
 * many steps it is about to take.
 */
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import { invokeTodoAdd, invokeTodoUpdate, TODO_ADD_TOOL, TODO_ADD_TOOL_NAME, TODO_UPDATE_STATUSES, TODO_UPDATE_TOOL, TODO_UPDATE_TOOL_NAME } from "./render.js";
import { createTodoList, type TodoCarrier, type TodoGate } from "./state.js";

export interface TodoToolDeps {
	/** The session's list — the same carrier `/todo` and the prompt block read. */
	state: TodoCarrier;
	/** PRD-010's gate, so a derived item still cannot be self-completed. */
	gate?: () => TodoGate | undefined;
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
			const gate = deps.gate?.();
			const result = invokeTodoAdd({
				list: createTodoList(deps.state, gate === undefined ? {} : { gate }),
				text: params.text,
				...(params.phase === undefined ? {} : { phase: params.phase }),
			});
			return { content: [{ type: "text", text: result.text }], ...(result.ok ? {} : { isError: true }), details: {} };
		},
	} as ToolDefinition;
}

/** Puts `todo_add` and `todo_update` on the session's tool surface. */
export function registerTodoTool(pi: ExtensionAPI, deps: TodoToolDeps): void {
	pi.registerTool(todoToolDefinition(deps));
	pi.registerTool(todoUpdateToolDefinition(deps));
}

/** The tool's schema, as TypeBox, matching `TODO_UPDATE_TOOL.parameters`. */
const UPDATE_PARAMETERS = Type.Object(
	{
		id: Type.String({ description: "the item's id, as shown at the start of its row in the todo block" }),
		status: Type.Union(TODO_UPDATE_STATUSES.map((status) => Type.Literal(status)), { description: "the item's new status" }),
		reason: Type.Optional(Type.String({ description: "why it is blocked; only used with `blocked`" })),
	},
	{ additionalProperties: false },
);

/**
 * The executor's completion handle. It routes through the same list `/todo`
 * drives, so a derived item still meets PRD-010's gate and is refused without a
 * `PASS` — the tool adds a way to close a step, not a way to self-certify one.
 */
export function todoUpdateToolDefinition(deps: TodoToolDeps): ToolDefinition {
	return {
		name: TODO_UPDATE_TOOL_NAME,
		label: TODO_UPDATE_TOOL_NAME,
		description: TODO_UPDATE_TOOL.description,
		parameters: UPDATE_PARAMETERS,
		execute: async (_id, raw): Promise<AgentToolResult<unknown>> => {
			const params = raw as Static<typeof UPDATE_PARAMETERS>;
			const gate = deps.gate?.();
			const result = await invokeTodoUpdate({
				list: createTodoList(deps.state, gate === undefined ? {} : { gate }),
				id: params.id,
				status: params.status,
				...(params.reason === undefined ? {} : { reason: params.reason }),
			});
			return { content: [{ type: "text", text: result.text }], ...(result.ok ? {} : { isError: true }), details: {} };
		},
	} as ToolDefinition;
}
