/**
 * `/todo` — the user's handle on the list (PRD-025 Phases 1–2, ROADMAP §51).
 *
 * Registers through PRD-016's command registry like every other command; the
 * handler mutates PRD-014's `WorkingState` through `src/todo/state.ts`, so
 * persistence, resume and fork come from the record rather than from this
 * module. `done` on a derived item consults PRD-010's gate and may refuse: a
 * model marking its own work complete is the failure the gate exists to refuse,
 * and allowing it here would reintroduce it through the back door.
 */
import type { CommandHandler, CommandRegistry, CommandResult } from "../commands/registry.js";
import { readPrdState, type PrdState } from "../prd/state.js";
import { syncFromPrd } from "./derive.js";
import { createTodoList, type TodoCarrier, type TodoGate, type TodoItem, type TodoStatus } from "./state.js";

export interface TodoCommandDeps {
	cwd: string;
	state: TodoCarrier;
	/** PRD-025's gate. Without one, a derived item can never be marked done. */
	gate?: TodoGate;
	/** Explicit PRD state; otherwise the active PRD is read from `.leanpi/prd/` on `sync`. */
	prd?: () => PrdState | null;
}

const COUNT_ORDER: readonly TodoStatus[] = ["done", "in_progress", "pending", "blocked", "dropped"];

/** The `/todo` listing: id, status (with a blocked reason), criterion, then the text. */
export function renderListing(items: readonly TodoItem[]): string {
	if (items.length === 0) return "todo (0 items)";
	const counts = COUNT_ORDER.map((status) => [status, items.filter((item) => item.status === status).length] as const)
		.filter(([, count]) => count > 0)
		.map(([status, count]) => `${status} ${count}`);
	const lines = items.map((item) => {
		const reason = item.status === "blocked" ? ` (${item.blockedReason ?? "unspecified"})` : "";
		const criterion = item.criterion === undefined ? "" : ` ${item.criterion}`;
		const text = item.text.length > 0 && item.text !== item.id ? ` — ${item.text}` : "";
		return `${item.id}: ${item.status}${reason}${criterion}${text}`;
	});
	return [`todo (${items.length} items · ${counts.join(", ")})`, ...lines].join("\n");
}

export function createTodoHandler(deps: TodoCommandDeps): CommandHandler {
	const list = () => createTodoList(deps.state, { gate: deps.gate });
	const view = () => renderListing(list().items);

	return async (args: string): Promise<CommandResult> => {
		const [subcommand, ...rest] = args.split(/\s+/).filter(Boolean);
		if (subcommand === undefined) return { ok: true, text: view() };

		if (subcommand === "add") {
			const text = rest.join(" ").trim();
			if (text.length === 0) return { ok: false, text: "usage: /todo add <text>" };
			const item = list().add(text);
			return { ok: true, text: `added ${item.id}: ${item.text}` };
		}

		if (subcommand === "clear") return list().clear();

		if (subcommand === "sync") {
			const prd = deps.prd ? deps.prd() : readPrdState(deps.cwd);
			if (!prd) return { ok: false, text: `no active PRD in ${deps.cwd} — the list is user-managed` };
			const items = await syncFromPrd(deps.state, { prd, gate: deps.gate });
			const derived = items.filter((item) => item.criterion !== undefined).length;
			return { ok: true, text: [`synced ${derived} derived item(s)`, view()].join("\n") };
		}

		const [id, ...reason] = rest;
		if (id === undefined || id.length === 0) return { ok: false, text: `usage: /todo ${subcommand} <id>` };
		if (subcommand === "start") return list().start(id);
		if (subcommand === "done") return list().complete(id);
		if (subcommand === "unblock") return list().unblock(id);
		if (subcommand === "drop") return list().drop(id);
		if (subcommand === "block") return list().block(id, reason.join(" "));
		return { ok: false, text: `unknown /todo subcommand: ${subcommand}` };
	};
}

/** Registers `/todo`; a later session supersedes the earlier handler, exactly like `/skills`. */
export function registerTodoCommands(registry: CommandRegistry, deps: TodoCommandDeps): void {
	if (registry.has("todo")) registry.unregister("todo");
	registry.register("todo", createTodoHandler(deps));
}
