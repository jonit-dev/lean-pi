/**
 * The todo list and its transitions (PRD-025 Phase 1, ROADMAP §42/§43/§51).
 *
 * The list is an ordered array of `TodoItem` held on PRD-014's `WorkingState`
 * (the `todo` field, added to the record by this PRD) — there is no store of its
 * own, so resume and fork inherit it with the record. Every mutation goes
 * through the functions below, which is what makes "at most one `in_progress`"
 * and "a `blocked` item is never auto-promoted" structural rather than a
 * convention repeated in eight handlers.
 *
 * The carrier is structural (`{ todo?: TodoItem[] }`), so this module never
 * imports `context/working-state.ts` and the record never imports this module.
 */
export type TodoStatus = "pending" | "in_progress" | "done" | "blocked" | "dropped";

export interface TodoItem {
	/** Short slug derived from the insertion index, so a user can type it. */
	id: string;
	text: string;
	status: TodoStatus;
	/** Optional flat label for grouping in the rendered view; not a tree. */
	phase?: string;
	/** Set on derived items only: the acceptance criterion this item stands for. */
	criterion?: string;
	blockedReason?: string;
}

/** PRD-014's `WorkingState` as this PRD reads it: the record plus its one new field. */
export interface TodoCarrier {
	todo?: TodoItem[];
}

/**
 * PRD-010's verdict for one criterion as the list needs it. `missing` names the
 * kinds with no fresh passing record; `reason` is the gate's own first clause.
 */
export interface TodoGateVerdict {
	decision: "PASS" | "MISSING_PROOF" | "FAILED" | "BLOCKED";
	missing: string[];
	reason: string;
}

/**
 * The proof gate as this module consults it. PRD-010 owns the verdict and its
 * evidence reads; this port exists so a derived item is never marked done by
 * anything else, and so the transitions need no evidence store to be testable.
 */
export interface TodoGate {
	/** `undefined` means the gate has not decided this criterion — never PASS. */
	verdict(criterionId: string): TodoGateVerdict | undefined | Promise<TodoGateVerdict | undefined>;
}

export interface TransitionResult {
	ok: boolean;
	text: string;
}

/** The ordered array on the record, created on first use. */
export function itemsOf(state: TodoCarrier): TodoItem[] {
	if (!Array.isArray(state.todo)) state.todo = [];
	return state.todo;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Spreadsheet-style slug for an insertion index: 0 → `a`, 25 → `z`, 26 → `aa`. */
export function slugAt(index: number): string {
	let value = index;
	let slug = "";
	do {
		slug = LETTERS[value % 26]! + slug;
		value = Math.floor(value / 26) - 1;
	} while (value >= 0);
	return slug;
}

/** The first free slug at or after the current length: ids never shift, so they stay typeable. */
export function nextItemId(items: readonly TodoItem[]): string {
	for (let index = items.length; ; index += 1) {
		const id = slugAt(index);
		if (!items.some((item) => item.id === id)) return id;
	}
}

export function findItem(items: readonly TodoItem[], id: string): TodoItem | undefined {
	return items.find((item) => item.id === id);
}

export function activeItem(items: readonly TodoItem[]): TodoItem | undefined {
	return items.find((item) => item.status === "in_progress");
}

/**
 * The promotion rule, in one place: the first `pending` item in list order
 * becomes active when nothing else is. `blocked`, `dropped` and `done` items are
 * skipped, and a `blocked` item re-enters the order only through `unblock`.
 */
export function promoteNext(items: TodoItem[]): TodoItem | undefined {
	if (activeItem(items)) return undefined;
	const next = items.find((item) => item.status === "pending");
	if (!next) return undefined;
	next.status = "in_progress";
	return next;
}

export function addItem(items: TodoItem[], text: string, options: { phase?: string; criterion?: string } = {}): TodoItem {
	const item: TodoItem = {
		id: nextItemId(items),
		text,
		status: "pending",
		...(options.phase === undefined ? {} : { phase: options.phase }),
		...(options.criterion === undefined ? {} : { criterion: options.criterion }),
	};
	items.push(item);
	return item;
}

function unknown(items: readonly TodoItem[], id: string): TransitionResult {
	const known = items.map((item) => item.id).join(", ");
	return { ok: false, text: `no todo item "${id}"${known.length > 0 ? ` (known: ${known})` : ""}` };
}

/** A second `start` never creates a second active item: it names the one already running. */
export function startItem(items: TodoItem[], id: string): TransitionResult {
	const item = findItem(items, id);
	if (!item) return unknown(items, id);
	const active = activeItem(items);
	if (active && active.id !== item.id) return { ok: false, text: `${active.id} is already in progress; finish or block it first` };
	if (item.status === "done" || item.status === "dropped" || item.status === "blocked") {
		return { ok: false, text: `${item.id} is ${item.status} and cannot be started` };
	}
	item.status = "in_progress";
	return { ok: true, text: `${item.id} in_progress` };
}

/** The refusal text: the verdict and the evidence kind the gate said was missing. */
export function refusalFor(item: TodoItem, verdict: TodoGateVerdict): string {
	const evidence = verdict.missing.length > 0 ? `no fresh evidence for ${verdict.missing.join(", ")}` : verdict.reason || "the gate named no missing evidence";
	return `cannot mark ${item.id} done: ${verdict.decision} (${evidence})`;
}

/**
 * Complete one item. An item carrying a `criterion` reaches `done` only on a
 * PRD-010 verdict of `PASS`: a model marking its own work complete is the exact
 * failure the proof gate exists to refuse, so this is the only writer of `done`
 * for a derived item and it never accepts a self-report.
 */
export async function completeItem(items: TodoItem[], id: string, gate?: TodoGate): Promise<TransitionResult> {
	const item = findItem(items, id);
	if (!item) return unknown(items, id);
	if (item.status === "done") return { ok: false, text: `${item.id} is already done` };
	if (item.status === "dropped") return { ok: false, text: `${item.id} was dropped` };
	if (item.criterion !== undefined) {
		const verdict = gate ? await gate.verdict(item.criterion) : undefined;
		if (!verdict || verdict.decision !== "PASS") {
			const evaluated: TodoGateVerdict = verdict ?? { decision: "MISSING_PROOF", missing: [], reason: "no proof gate evaluated this criterion" };
			return { ok: false, text: refusalFor(item, evaluated) };
		}
	}
	item.status = "done";
	delete item.blockedReason;
	const promoted = promoteNext(items);
	return { ok: true, text: `${item.id} done${promoted ? `; ${promoted.id} in_progress` : ""}` };
}

export function blockItem(items: TodoItem[], id: string, reason?: string): TransitionResult {
	const item = findItem(items, id);
	if (!item) return unknown(items, id);
	if (item.status === "done" || item.status === "dropped") return { ok: false, text: `${item.id} is ${item.status}` };
	item.status = "blocked";
	item.blockedReason = reason && reason.trim().length > 0 ? reason.trim() : "unspecified";
	return { ok: true, text: `${item.id} blocked (${item.blockedReason})` };
}

/** The only way back out of `blocked`; it returns to `pending` and displaces nothing. */
export function unblockItem(items: TodoItem[], id: string): TransitionResult {
	const item = findItem(items, id);
	if (!item) return unknown(items, id);
	if (item.status !== "blocked") return { ok: false, text: `${item.id} is ${item.status}, not blocked` };
	item.status = "pending";
	delete item.blockedReason;
	return { ok: true, text: `${item.id} pending` };
}

/** Terminal: the item stays visible in state and leaves every remaining-work calculation. */
export function dropItem(items: TodoItem[], id: string): TransitionResult {
	const item = findItem(items, id);
	if (!item) return unknown(items, id);
	if (item.status === "dropped") return { ok: false, text: `${item.id} is already dropped` };
	item.status = "dropped";
	return { ok: true, text: `${item.id} dropped` };
}

/** Derived items are left in place: the next sync would regenerate them anyway. */
export function clearItems(items: TodoItem[]): TransitionResult {
	const kept = items.filter((item) => item.criterion !== undefined);
	const removed = items.length - kept.length;
	items.length = 0;
	items.push(...kept);
	return { ok: true, text: `cleared ${removed} manual item(s); ${kept.length} derived item(s) kept` };
}

/**
 * `remainingWork` — the predicate PRD-013's boundary reads as its "useful work
 * remains" input. `actionable` is every item that is neither `done`, `dropped`
 * nor `blocked`; everything it needs was decided by the transitions above, so
 * this reads no evidence and calls no gate.
 */
export interface RemainingWork {
	actionable: TodoItem[];
	blocked: TodoItem[];
}

export function remainingWork(list: readonly TodoItem[]): RemainingWork {
	return {
		actionable: list.filter((item) => item.status !== "done" && item.status !== "dropped" && item.status !== "blocked"),
		blocked: list.filter((item) => item.status === "blocked"),
	};
}

/** The handle the command surface and PRD-013's boundary both drive. */
export interface TodoList {
	readonly items: readonly TodoItem[];
	add(text: string, options?: { phase?: string; criterion?: string }): TodoItem;
	start(id: string): TransitionResult;
	complete(id: string): Promise<TransitionResult>;
	block(id: string, reason?: string): TransitionResult;
	unblock(id: string): TransitionResult;
	drop(id: string): TransitionResult;
	clear(): TransitionResult;
	active(): TodoItem | undefined;
	remainingWork(): RemainingWork;
}

export function createTodoList(state: TodoCarrier, options: { gate?: TodoGate } = {}): TodoList {
	const items = itemsOf(state);
	return {
		items,
		add: (text, options) => addItem(items, text, options),
		start: (id) => startItem(items, id),
		complete: (id) => completeItem(items, id, options.gate),
		block: (id, reason) => blockItem(items, id, reason),
		unblock: (id) => unblockItem(items, id),
		drop: (id) => dropItem(items, id),
		clear: () => clearItems(items),
		active: () => activeItem(items),
		remainingWork: () => remainingWork(items),
	};
}
