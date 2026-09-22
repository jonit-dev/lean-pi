/**
 * `/jev` — status, setup, key management, privacy mode and a live round trip
 * (PRD-002 Phase 3).
 *
 * Single surface form with subcommands; there is no `/jev-setup` alias.
 * Registration goes through `src/commands/registry.ts`, so the command is
 * reachable at this PRD's closure rather than waiting on PRD-016.
 */
import type { JevMode, JevProvider } from "../core/types.js";
import { writeUserProvider } from "../core/config-write.js";
import { clearStoredKey, writeStoredKey, type CredentialEnv } from "../jev/credentials.js";
import type { JevClient, JevStatus } from "../jev/client.js";
import type { LayaStatus } from "../jev/laya.js";
import type { CommandContext, CommandRegistry, CommandResult } from "./registry.js";

const MODES: JevMode[] = ["enabled", "disabled", "metadata-only", "redacted"];
const PROVIDERS: JevProvider[] = ["typesafe", "laya"];

function isProvider(value: string): value is JevProvider {
	return (PROVIDERS as readonly string[]).includes(value);
}

/** The provider switch, absent when the caller has no local runtime to manage. */
export interface JevProviderDeps {
	current(): JevProvider;
	/** Swaps the live session's provider; rejects with an actionable message. */
	swap(name: JevProvider): Promise<void>;
	status(): Promise<LayaStatus>;
	setup(): Promise<{ home: string; python: string; installed: boolean }>;
}

export interface JevCommandDeps {
	client: JevClient;
	env?: CredentialEnv;
	/** Recorded so the user is not prompted on every turn. */
	onDeclined?: () => void;
	wasDeclined?: () => boolean;
	/** PRD-042. Absent in a session that only ever runs TypeSafe. */
	provider?: JevProviderDeps;
}

function statusText(status: JevStatus, laya?: LayaStatus): string {
	const lines = [
		`JEV: ${status.configured ? "configured" : "not configured"}${status.source ? ` (source: ${status.source})` : ""}`,
		`provider: ${status.provider}`,
		`mode: ${status.mode}`,
		`model: ${status.modelVersion}`,
		`reachable: ${status.reachable}`,
		`session fallbacks: ${status.fallbackCount}`,
	];
	if (laya) {
		lines.push(`laya runtime: ${laya.detail}`);
		lines.push(`laya home: ${laya.home}`);
		if (laya.endpoint) lines.push(`laya endpoint: ${laya.endpoint}`);
	}
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
function upsert(
	registry: CommandRegistry,
	name: string,
	handler: import("./registry.js").CommandHandler,
	init?: import("./registry.js").CommandInit,
): void {
	if (registry.has(name)) registry.unregister(name);
	registry.register(name, handler, init);
}

export function registerJevCommands(registry: CommandRegistry, deps: JevCommandDeps): void {
	const { client } = deps;

	upsert(
		registry,
		"jev",
		async (args, context: CommandContext): Promise<CommandResult> => {
		const [subcommand, ...rest] = args.split(/\s+/).filter(Boolean);
		const value = rest.join(" ").trim();

		switch (subcommand) {
			case undefined:
				return { ok: true, text: statusText(await client.status(), deps.provider ? await deps.provider.status() : undefined) };

			case "provider": {
				// `/jev provider` reports; `/jev provider <name>` switches the session and
				// persists the choice as the one `jev.provider` leaf in the user config.
				// `--save` is still accepted (and ignored) so old muscle memory works.
				const [name] = rest;
				if (name === undefined) {
					const current = deps.provider ? deps.provider.current() : "typesafe";
					return { ok: true, text: `provider: ${current}\nvalues: ${PROVIDERS.join(" | ")}\n\`/jev provider <name>\` switches and saves it for every run.` };
				}
				if (!isProvider(name)) {
					return { ok: false, text: `Unknown provider "${name}". Valid values: ${PROVIDERS.join(" | ")}.` };
				}
				if (!deps.provider) {
					return { ok: false, text: "This session cannot switch providers." };
				}
				await deps.provider.swap(name);
				const lines = [`provider: ${name}`];
				if (name === "laya") {
					const laya = await deps.provider.status();
					lines.push(`laya runtime: ${laya.detail}`);
					if (!laya.installed) {
						lines.push("setup downloads ~2.5 GB of wheels and ~0.8 GB of weights: /jev setup-laya");
					}
				}
				try {
					lines.push(`saved to ${writeUserProvider(name, deps.env)}`);
				} catch (error) {
					lines.push(`could not save: ${error instanceof Error ? error.message : String(error)}`);
				}
				return { ok: true, text: lines.join("\n") };
			}

			case "setup-laya": {
				if (!deps.provider) return { ok: false, text: "This session has no Laya runtime to set up." };
				try {
					const result = await deps.provider.setup();
					return {
						ok: true,
						text: [`laya runtime: ${result.installed ? "installed" : "already present"}`, `home: ${result.home}`, `python: ${result.python}`].join("\n"),
					};
				} catch (error) {
					return { ok: false, text: `Laya setup failed: ${error instanceof Error ? error.message : String(error)}` };
				}
			}

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
		},
		{
			summary: "Control plane: status, key, privacy mode, provider, round trip",
			usage: "/jev [provider [typesafe|laya] | setup-laya | setup | key set|clear | mode <mode> | test]",
		},
	);
}
