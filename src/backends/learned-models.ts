import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A model id a vendor resolved, with the window it reported. */
export interface LearnedModel {
	id: string;
	contextWindow?: number;
}

/** `<home>/.leanpi/model-ids.json`: what each model name asked of a vendor turned out to be. */
function learnedPath(env: NodeJS.ProcessEnv): string {
	return join(env.HOME ?? homedir(), ".leanpi", "model-ids.json");
}

/**
 * Names this machine has seen resolve — `opus` → `claude-opus-5-5` — keyed by
 * the name asked for and by the full id itself. Learned from real runs, never
 * guessed: the Claude CLI has no model-list command (`cli/allocate.ts`).
 */
export function learnedModels(env: NodeJS.ProcessEnv = process.env): Record<string, LearnedModel> {
	const path = learnedPath(env);
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, LearnedModel>) : {};
	} catch {
		// A corrupt cache only costs the full ids until the next run relearns them.
		return {};
	}
}

export function learnModel(env: NodeJS.ProcessEnv, asked: string, ran: LearnedModel): void {
	const known = learnedModels(env);
	const before = JSON.stringify(known);
	// Only a name that is not already a full id is an alias to remember.
	if (asked !== ran.id) known[asked] = ran;
	known[ran.id] = ran;
	if (JSON.stringify(known) === before) return;
	const path = learnedPath(env);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(known, null, 2));
}

