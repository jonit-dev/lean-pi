/**
 * `/subagents-limit` (PRD-041).
 *
 * Upstream `pi-subagents` reads `globalConcurrencyLimit` once when its extension
 * starts and ships no writer, so this is the operator's handle on the per-run
 * child ceiling. It writes the same file upstream reads and reports honestly
 * which value this session already captured: a change applies after `/reload` or
 * a restart.
 *
 * Showing never writes. Setting never writes on invalid input, and refuses to
 * rewrite a file it cannot safely round-trip.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isValidConcurrencyLimit, inspectOperatorLimit, setLimit, type CapturedLimit } from "../subagents/index.js";
import { upsertCommand, type CommandRegistry, type CommandResult } from "./registry.js";

const NAME = "subagents-limit";

function usage(message: string): CommandResult {
	return { ok: false, text: `${message}\nusage: /${NAME} [N|reset]` };
}

function show(captured: CapturedLimit | undefined, agentDir: string): CommandResult {
	const view = inspectOperatorLimit(agentDir, captured?.limit);
	const active = view.active === undefined ? "not active in this session" : String(view.active);
	const saved = view.saved === null ? `unreadable (${view.problem ?? "unknown"})` : String(view.saved);
	const pending = view.active !== undefined && view.saved !== null && view.active !== view.saved ? "; applies after /reload or restart" : "";
	return { ok: true, text: `subagent concurrency: active ${active}, saved ${saved}${pending}\nconfig: ${view.path}` };
}

/**
 * Register `/subagents-limit` against the session's captured limit.
 *
 * `captured` is read lazily from the session that attached the package
 * (`subagentsFactory`), because the factory runs *after* `activate` registers
 * this command. Reading a caller-owned value — never a process-global — is what
 * keeps two sessions that share an upstream config path honest: each shows the
 * limit it captured. The global agent directory is captured at registration so
 * subsequent environment changes do not redirect the command's saved writes.
 */
export function registerSubagentsLimitCommand(
	registry: CommandRegistry,
	captured?: CapturedLimit | (() => CapturedLimit | undefined),
	agentDir: string = getAgentDir(),
): void {
	const readCaptured = typeof captured === "function" ? captured : () => captured;
	upsertCommand(
		registry,
		NAME,
		(args): CommandResult => {
			const value = args.trim();
			try {
				const limits = readCaptured();
				if (value.length === 0) return show(limits, agentDir);
				if (value === "reset") {
					const written = setLimit("reset", agentDir);
					return { ok: true, text: `subagent concurrency limit saved as ${written.limit}; applies after /reload or restart.` };
				}
				if (!/^\d+$/.test(value)) return usage(`subagent concurrency limit must be a positive integer, got "${value}"`);
				const requested = Number(value);
				if (!isValidConcurrencyLimit(requested)) return usage(`subagent concurrency limit must be a positive safe integer, got ${requested}`);
				const written = setLimit(requested, agentDir);
				return { ok: true, text: `subagent concurrency limit saved as ${written.limit}; applies after /reload or restart.` };
			} catch (error) {
				return { ok: false, text: error instanceof Error ? error.message : String(error) };
			}
		},
		{ summary: "show or set the per-run subagent concurrency limit", usage: `/${NAME} [N|reset]` },
	);
}
