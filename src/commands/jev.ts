/**
 * `/jev` — status, setup, key management, privacy mode and a live round trip
 * (PRD-002 Phase 3).
 *
 * Single surface form with subcommands; there is no `/jev-setup` alias.
 * Registration goes through `src/commands/registry.ts`, so the command is
 * reachable at this PRD's closure rather than waiting on PRD-016.
 */
import type { JevMode } from "../core/types.js";
import { clearStoredKey, writeStoredKey, type CredentialEnv } from "../jev/credentials.js";
import type { JevClient, JevStatus } from "../jev/client.js";
import type { CommandContext, CommandRegistry, CommandResult } from "./registry.js";

const MODES: JevMode[] = ["enabled", "disabled", "metadata-only", "redacted"];

export interface JevCommandDeps {
	client: JevClient;
	env?: CredentialEnv;
	/** Recorded so the user is not prompted on every turn. */
	onDeclined?: () => void;
	wasDeclined?: () => boolean;
}

function statusText(status: JevStatus): string {
	const lines = [
		`JEV: ${status.configured ? "configured" : "not configured"}${status.source ? ` (source: ${status.source})` : ""}`,
		`mode: ${status.mode}`,
		`model: ${status.modelVersion}`,
		`reachable: ${status.reachable}`,
		`session fallbacks: ${status.fallbackCount}`,
	];
	if (status.degraded.length > 0) lines.push(`degraded capabilities: ${status.degraded.join(", ")}`);
	return lines.join("\n");
}

/** `jevStatus` is the object PRD-016 renders in `/doctor` and `/status`; the key is never part of it. */
export async function jevStatus(client: JevClient): Promise<JevStatus> {
	return client.status();
}

/**
 * `/jev` always drives the session that is alive now: a session created later in
 * the same process supersedes the earlier one's handler, while `register()`
 * still rejects a genuinely accidental duplicate name.
 */
function upsert(registry: CommandRegistry, name: string, handler: import("./registry.js").CommandHandler): void {
	if (registry.has(name)) registry.unregister(name);
	registry.register(name, handler);
}

export function registerJevCommands(registry: CommandRegistry, deps: JevCommandDeps): void {
	const { client } = deps;

	upsert(registry, "jev", async (args, context: CommandContext): Promise<CommandResult> => {
		const [subcommand, ...rest] = args.split(/\s+/).filter(Boolean);
		const value = rest.join(" ").trim();

		switch (subcommand) {
			case undefined:
				return { ok: true, text: statusText(await client.status()) };

			case "setup": {
				if (!context.prompt) return { ok: false, text: "setup requires an interactive prompt" };
				const key = await context.prompt("Paste your JEV API key (leave empty to decline):");
				if (!key) {
					deps.onDeclined?.();
					return {
						ok: true,
						text: "JEV left unconfigured. LeanPi continues on deterministic fallback; planning gate, complexity classification, skill disclosure and proof sufficiency are degraded.",
					};
				}
				// Exactly one validation attempt: an invalid key yields one error and no retry loop.
				const validation = await client.validateKey(key);
				if (!validation.ok) return { ok: false, text: `JEV key rejected: ${validation.error}` };
				writeStoredKey(key, deps.env);
				return {
					ok: true,
					text: `JEV configured (model ${validation.modelVersion}, ${validation.latencyMs}ms, $${validation.costUsd.toFixed(6)}).`,
				};
			}

			case "key": {
				const action = rest[0];
				if (action === "set") {
					const key = rest.slice(1).join(" ").trim() || (await context.prompt?.("Paste your JEV API key:"));
					if (!key) return { ok: false, text: "no key provided" };
					const validation = await client.validateKey(key);
					if (!validation.ok) return { ok: false, text: `JEV key rejected: ${validation.error}` };
					writeStoredKey(key, deps.env);
					return { ok: true, text: `JEV key stored (model ${validation.modelVersion}).` };
				}
				if (action === "clear") {
					const removed = clearStoredKey(deps.env);
					// The credential store is one of four sources. Announcing the
					// deterministic fallback after clearing it was wrong whenever
					// `$JEV_API_KEY`, the project's `.env` or `jev.apiKey` still held
					// one: the session carries on with the control plane live, and the
					// user has been told the opposite.
					const source = client.credentialSource();
					if (source !== null && source !== "credential store") {
						return { ok: true, text: `${removed ? "JEV key cleared" : "no stored JEV key"} — JEV is still configured from ${source}.` };
					}
					return { ok: true, text: removed ? "JEV key cleared. LeanPi continues on deterministic fallback." : "no stored JEV key" };
				}
				return { ok: false, text: "usage: /jev key set <key> | /jev key clear" };
			}

			case "mode": {
				if (!MODES.includes(value as JevMode)) return { ok: false, text: `usage: /jev mode <${MODES.join("|")}>` };
				client.setMode(value as JevMode);
				return { ok: true, text: `JEV mode: ${value}` };
			}

			case "test": {
				const result = await client.test();
				if (!result.ok) return { ok: false, text: `JEV test failed: ${result.error}` };
				const answer = result.answer;
				const rendered = answer ? `${answer.kind}:${"choice" in answer ? answer.choice : "score" in answer ? answer.score : answer.value}` : "no answer";
				return {
					ok: true,
					text: `JEV test ok — ${rendered} (model ${result.modelVersion}, ${result.latencyMs}ms, $${result.costUsd.toFixed(6)})`,
				};
			}

			default:
				return { ok: false, text: `unknown /jev subcommand: ${subcommand}` };
		}
	});
}
