/**
 * Task todo list barrel (PRD-025). `src/index.ts` re-exports this module.
 */
export { createTodoHandler, registerTodoCommands, renderListing } from "./commands.js";
export type { TodoCommandDeps } from "./commands.js";
export { gateFromProofResult, syncFromPrd } from "./derive.js";
export { registerTodoTool, todoToolDefinition } from "./tool.js";
export type { TodoToolDeps } from "./tool.js";
export type { SyncInput } from "./derive.js";
export {
	boundaryTodoInput,
	decideTodoNeeded,
	registerTodoSites,
	remainingWork,
	todoNeededFallback,
	TODO_NEEDED_QUESTION,
	TODO_NEEDED_QUESTION_ID,
	TODO_NEEDED_SITE_ID,
} from "./goal.js";
export type { BoundaryTodoInput, RemainingWork, TodoNeededDecision, TodoNeededInput } from "./goal.js";
export {
	admitTodoAdd,
	invokeTodoAdd,
	renderTodo,
	TODO_ADD_TOOL,
	TODO_ADD_TOOL_NAME,
	TODO_PROMPT_BUDGET_BYTES,
	todoPromptBudgetBytes,
	withTodo,
} from "./render.js";
export type { TodoAddAdmission, TodoAddCall, TodoAddRefusal, TodoAddTool } from "./render.js";
export {
	activeItem,
	addItem,
	blockItem,
	clearItems,
	completeItem,
	createTodoList,
	dropItem,
	findItem,
	itemsOf,
	promoteNext,
	refusalFor,
	startItem,
	unblockItem,
} from "./state.js";
export type { TodoCarrier, TodoGate, TodoGateVerdict, TodoItem, TodoList, TodoStatus, TransitionResult } from "./state.js";
