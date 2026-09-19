/**
 * The verifier registry (PRD-009 Phase 2, ROADMAP §35).
 *
 * One map from verifier kind to `{ run(descriptor, ctx) }`. The six command
 * kinds are one row of data each through `shellVerifier`; a kind that cannot be
 * expressed as a command with a stdout parser — PRD-022's runtime and browser
 * verifiers, which need process-group teardown and a Pi tab handle — registers
 * its own `run` here through `registerVerifier`, which is the only registration
 * point. A kind with no registration produces a `not_run` record with a reason,
 * never a silent omission.
 */
import type { ArtifactStore } from "../context/artifacts.js";
import type { EvidenceStatus, VerifierResult } from "./evidence.js";
import { execShell, type ShellExec, type ShellRunResult } from "./run.js";

/**
 * The canonical verifier-kind union, and the only place it is written down.
 * The first six are implemented here; PRD-022 registers the last four.
 */
export const VERIFIER_KINDS = [
	"typecheck",
	"targeted_test",
	"full_suite",
	"lint",
	"build",
	"git_status",
	"runtime_smoke",
	"cli_invocation",
	"browser_test",
	"screenshot_compare",
] as const;

export type VerifierKind = (typeof VERIFIER_KINDS)[number];

export function isVerifierKind(value: string): value is VerifierKind {
	return (VERIFIER_KINDS as readonly string[]).includes(value);
}

/** The kinds this module implements as a shelled command. */
export const SHELL_VERIFIER_KINDS: readonly VerifierKind[] = ["typecheck", "targeted_test", "full_suite", "lint", "build", "git_status"];

/** Default commands (§35's table). A host project overrides them through config. */
export const DEFAULT_COMMANDS: Record<string, string> = {
	typecheck: "npm run typecheck",
	targeted_test: "npx vitest run {{scope}}",
	full_suite: "npm test",
	lint: "npm run lint",
	build: "npm run build",
	git_status: "git status --porcelain",
};

/** Default surface per kind, when the contract's verification block declares none. */
export const DEFAULT_SCOPES: Record<string, string> = {
	typecheck: "src/**/*.ts",
	lint: "src",
	build: "package",
	git_status: "workspace",
	full_suite: "tests",
	// targeted_test has no default surface: a pattern the contract did not name
	// would run an unknown set of tests, so an undeclared scope is a `not_run`.
	targeted_test: "",
};

export interface VerifierDescriptor {
	/** Canonical kind, or the unsupported name the contract asked for. */
	kind: string;
	/** Fully resolved command; empty when the kind has no runnable command here. */
	command: string;
	mandatory: boolean;
	/** Acceptance-criterion ids, stamped by `selectVerifiers`; a caller never supplies them. */
	criterion: string[];
	scope: string;
}

export interface VerifierContext {
	cwd: string;
	timeoutMs: number;
	artifacts?: ArtifactStore;
	/** Test seam: command execution is injectable so specs never shell out. */
	exec?: ShellExec;
}

export interface VerifierRunner {
	run(descriptor: VerifierDescriptor, context: VerifierContext): Promise<VerifierResult>;
}

/** A verifier result carrying the descriptor's attribution, so `record()` never invents it. */
export function verifierOutcome(
	descriptor: VerifierDescriptor,
	status: EvidenceStatus,
	fields: { exitCode?: number | null; artifactRef?: string | null; reason?: string } = {},
): VerifierResult {
	return {
		kind: descriptor.kind,
		status,
		exitCode: fields.exitCode ?? null,
		artifactRef: fields.artifactRef ?? null,
		criterion: [...descriptor.criterion],
		scope: descriptor.scope,
		...(fields.reason ? { reason: fields.reason } : {}),
	};
}

/** Store a verifier's output; the artifact payload is where a record's `reason` lives. */
export function captureArtifact(artifacts: ArtifactStore | undefined, kind: string, payload: string): string | null {
	if (!artifacts) return null;
	const pathSafe = /^[a-z][a-z0-9_]*$/i.test(kind) ? kind : "verifier";
	return artifacts.store(payload, pathSafe, kind);
}

/** A template with `{{scope}}` and no scope is empty, not a command with a hole in it. */
function applyScope(template: string, scope: string): string {
	const trimmed = template.trim();
	if (!trimmed.includes("{{scope}}")) return trimmed;
	return scope.trim().length === 0 ? "" : trimmed.replaceAll("{{scope}}", scope).trim();
}

/** The command a kind runs for a scope, with config overrides on top of the table. */
export function resolveCommand(kind: string, scope: string, overrides: Partial<Record<string, string>> = {}): string {
	return applyScope(overrides[kind] ?? DEFAULT_COMMANDS[kind] ?? "", scope);
}

export type ShellParse = (run: ShellRunResult) => { status?: EvidenceStatus; reason?: string } | undefined;

/** 32 KiB of tail output: failures and summaries print last. */
function artifactPayload(command: string, run: ShellRunResult, reason: string | undefined): string {
	const head = [reason, `$ ${command}`, `exit: ${run.exitCode ?? "none"}${run.timedOut ? " (timeout)" : ""}`]
		.filter((line): line is string => typeof line === "string" && line.length > 0)
		.join("\n");
	const tail = `${run.stdout}${run.stderr}`.trim();
	return `${head}\n${tail}`.slice(-32_768);
}

/**
 * A verifier that shells one command and maps exit code plus parsed counts into a
 * result: timeout and launch failure are `error`, 0 is `pass`, 127 is `error`
 * (the command is absent from the host project), anything else is `fail`.
 */
export function shellVerifier(command: string, parse?: ShellParse): VerifierRunner {
	return {
		async run(descriptor, context) {
			const resolved = descriptor.command.trim() || applyScope(command, descriptor.scope);
			if (resolved.length === 0) {
				const reason = `no command resolved for ${descriptor.kind}${descriptor.scope.length === 0 ? ": the contract declared no scope" : ""}`;
				return verifierOutcome(descriptor, "not_run", {
					reason,
					artifactRef: captureArtifact(context.artifacts, descriptor.kind, reason),
				});
			}
			const run = await (context.exec ?? execShell)(resolved, context.cwd, context.timeoutMs);
			const parsed = parse?.(run);
			const status: EvidenceStatus =
				parsed?.status ?? (run.spawnError !== null || run.timedOut || run.exitCode === 127 ? "error" : run.exitCode === 0 ? "pass" : "fail");
			const reason =
				parsed?.reason ??
				run.spawnError ??
				(run.timedOut
					? `timed out after ${context.timeoutMs}ms`
					: run.exitCode === 127
						? `command not found: ${resolved}`
						: undefined);
			return verifierOutcome(descriptor, status, {
				exitCode: run.exitCode,
				reason,
				artifactRef: captureArtifact(context.artifacts, descriptor.kind, artifactPayload(resolved, run, reason)),
			});
		},
	};
}

const registry = new Map<string, VerifierRunner>();

/** The single registration point: PRD-018's diagnostics and PRD-022's four kinds land here. */
export function registerVerifier(kind: string, runner: VerifierRunner): void {
	registry.set(kind, runner);
}

export function verifierFor(kind: string): VerifierRunner | undefined {
	return registry.get(kind);
}

for (const kind of SHELL_VERIFIER_KINDS) registerVerifier(kind, shellVerifier(DEFAULT_COMMANDS[kind]!));
