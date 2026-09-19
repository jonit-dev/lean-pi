/**
 * The single permission chokepoint (PRD-017 Phase 1 and Phase 3).
 *
 * One guard installed on Pi's tool-dispatch hook covers every tool call —
 * built-in read/edit/shell, MCP invocations and subagent spawns — so no caller
 * has to cooperate and a new capability type is covered by construction. Each
 * call implicates a *set* of scopes; the guard resolves each independently and
 * takes the strictest decision, so `shell: allow` cannot buy network egress.
 *
 * Refusal is a returned tool error, never a thrown exception: the session
 * reports it and continues.
 */
import {
	createBashToolDefinition,
	type BashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { classifyScopes, resolveAll, type PermissionDecision, type Resolution, type Scope } from "./rules.js";
import { childEnv, redactSecrets, secretValues, type SecretsPolicy } from "./secrets.js";
import type { PermissionState } from "./state.js";

export interface GuardQuestion {
	/** The exact capability id the answer is scoped to. */
	capability: string;
	scopes: Scope[];
	target: string;
}

export interface PermissionAuditRow {
	toolName: string;
	capabilities: string[];
	scope: Scope | null;
	decision: PermissionDecision;
	source: string;
	reason: string;
}

export interface GuardDeps {
	cwd: string;
	/** Live state; a function keeps a mid-session `/permissions set` visible. */
	state: PermissionState | (() => PermissionState);
	env?: NodeJS.ProcessEnv;
	/** `ask` resolution; defaults to Pi's confirmation prompt and denies without a UI. */
	confirm?: (question: GuardQuestion, ctx: ExtensionContext) => Promise<boolean> | boolean;
	/** Install an `execute` tool that spawns with the allowlisted environment (default true). */
	applySpawnEnv?: boolean;
	/** Execution seam for `execute`; Pi's local shell by default, a remote harness otherwise. */
	operations?: BashOperations;
	/** Receives the already-redacted tool output; PRD-014's artifact store plugs in here. */
	onOutput?: (redacted: string) => void;
}

export interface CallEvaluation {
	capabilities: string[];
	scopes: Scope[];
	decision: PermissionDecision;
	deciding: Resolution;
}

export interface PermissionGuard {
	/** One row per refused call, for the session's own reporting. */
	audit: PermissionAuditRow[];
	evaluate(toolName: string, input: Record<string, unknown>): CallEvaluation;
}

function scopeNameOf(capability: string): string {
	const separator = capability.indexOf(":");
	return separator === -1 ? capability : capability.slice(0, separator);
}

/** The pure decision: classify every implicated scope, then take the strictest. */
export function evaluateCall(call: { toolName: string; input: Record<string, unknown> }, current: PermissionState): CallEvaluation {
	const classified = classifyScopes(call, current.cwd);
	const capabilities = classified.map((entry) => entry.capability);
	const aggregate = resolveAll(capabilities, current.permissions);
	return {
		capabilities,
		scopes: classified.map((entry) => entry.scope),
		decision: aggregate.decision,
		deciding: aggregate.deciding,
	};
}

/** Names both the deciding scope and the requested capability, and why. */
export function refusalText(evaluation: CallEvaluation): string {
	const capability = evaluation.deciding.capability;
	return [
		`LeanPi refused this call: scope "${scopeNameOf(capability)}", capability "${capability}"`,
		`(${evaluation.deciding.source} decision: ${evaluation.deciding.decision}; the call did not run).`,
		`Change it with "/permissions set ${capability} ask".`,
	].join(" ");
}

export function installPermissionGuard(pi: ExtensionAPI, deps: GuardDeps): PermissionGuard {
	const env = deps.env ?? process.env;
	const current = (): PermissionState => (typeof deps.state === "function" ? deps.state() : deps.state);
	const policy = (): SecretsPolicy => current().permissions.secrets;
	/** Answers are cached per exact capability id, for this session only. */
	const approvals = new Map<string, boolean>();
	const audit: PermissionAuditRow[] = [];

	const decide = async (event: { toolName: string; input: Record<string, unknown> }, ctx: ExtensionContext): Promise<{ block: true; reason: string } | undefined> => {
		const state = current();
		const evaluation = evaluateCall({ toolName: event.toolName, input: event.input }, state);
		const record = (decision: PermissionDecision, reason: string): void => {
			audit.push({
				toolName: event.toolName,
				capabilities: evaluation.capabilities,
				scope: (scopeNameOf(evaluation.deciding.capability) || null) as Scope | null,
				decision,
				source: evaluation.deciding.source,
				reason,
			});
		};

		if (evaluation.decision === "allow") return undefined;

		if (evaluation.decision === "deny") {
			const reason = refusalText(evaluation);
			record("deny", reason);
			return { block: true, reason };
		}

		// One prompt for the whole set, naming every scope it covers.
		const pending = evaluation.capabilities.filter((capability) => !approvals.has(capability));
		if (pending.length > 0) {
			const question: GuardQuestion = {
				capability: pending[0]!,
				scopes: evaluation.scopes,
				target: pending.join(", "),
			};
			const asked = deps.confirm
				? await deps.confirm(question, ctx)
				: ctx.hasUI
					? await ctx.ui.confirm("LeanPi permission request", `Allow ${pending.join(", ")} for scopes ${evaluation.scopes.join(", ")}?`)
					: false;
			for (const capability of pending) approvals.set(capability, asked);
		}

		const refused = evaluation.capabilities.filter((capability) => approvals.get(capability) === false);
		if (refused.length === 0) return undefined;

		const reason = `LeanPi refused this call: scope "${scopeNameOf(refused[0]!)}", capability "${refused[0]}" (the user declined the confirmation prompt; the call did not run).`;
		record("deny", reason);
		return { block: true, reason };
	};

	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		return decide({ toolName: event.toolName, input }, ctx);
	});

	// Output path: redact by value, so a secret echoed by an unrelated command is
	// caught too, and the artifact store receives the redacted text.
	pi.on("tool_result", (event) => {
		const secrets = secretValues(env, policy());
		if (secrets.size === 0) return undefined;
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text") return part;
			const text = redactSecrets(part.text, secrets);
			if (text === part.text) return part;
			changed = true;
			return { ...part, text };
		});
		if (!changed) return undefined;
		deps.onOutput?.(
			content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		);
		return { content };
	});

	// Spawn path: children get the allowlisted environment, never the parent's.
	// Registration must happen after `registerBaselineTools` so this definition is
	// the one in play for the `execute` name.
	if (deps.applySpawnEnv !== false) {
		const definition = createBashToolDefinition(deps.cwd, {
			...(deps.operations ? { operations: deps.operations } : {}),
			spawnHook: (context) => ({ ...context, env: childEnv(context.env, policy()) }),
		}) as unknown as ToolDefinition;
		pi.registerTool({ ...definition, name: "execute", label: "execute" });
	}

	return {
		audit,
		evaluate: (toolName, input) => evaluateCall({ toolName, input }, current()),
	};
}
