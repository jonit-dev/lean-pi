/**
 * `cli_invocation` — run the task's program with the declared argv and stdin, and
 * compare its exit code and streams against the expectation the contract declares
 * (PRD-022 Phase 1, AC-2, ROADMAP §35).
 *
 * The comparison is the whole verifier, so the record's artifact is the real
 * captured stdout, stderr and exit code: a verifier that returned a literal
 * `pass` without executing could not produce the fixture's marker. An
 * expectation the contract never declared is `not_run`, not a guessed
 * `exit 0 == success`, and a command that overruns its timeout is a `fail` after
 * the whole group is reaped.
 */
import {
	captureArtifact,
	verifierOutcome,
	type VerifierContext,
	type VerifierDescriptor,
	type VerifierRunner,
} from "../verify/descriptors.js";
import type { VerifierResult } from "../verify/evidence.js";
import { currentRuntimePlan, type CliExpectation } from "./plan.js";
import { startProcess } from "./proc.js";

const DEFAULT_CLI_TIMEOUT_MS = 60_000;

/** A trailing newline is not an output difference; anything else is. */
function withoutTrailingNewline(value: string): string {
	return value.replace(/\n+$/, "");
}

function mismatches(expect: CliExpectation, result: { code: number | null; signal: string | null; stdout: string; stderr: string }): string[] {
	const found: string[] = [];
	if (expect.exitCode !== undefined && result.code !== expect.exitCode) {
		found.push(`the exit code was ${result.signal !== null ? `signal ${result.signal}` : (result.code ?? "none")}, the contract expects ${expect.exitCode}`);
	}
	if (expect.stdoutEquals !== undefined && withoutTrailingNewline(result.stdout) !== withoutTrailingNewline(expect.stdoutEquals)) {
		found.push(`stdout was ${JSON.stringify(withoutTrailingNewline(result.stdout))}, the contract expects ${JSON.stringify(withoutTrailingNewline(expect.stdoutEquals))}`);
	}
	for (const marker of expect.stdoutContains ?? []) {
		if (!result.stdout.includes(marker)) found.push(`stdout did not contain ${JSON.stringify(marker)}`);
	}
	for (const marker of expect.stderrContains ?? []) {
		if (!result.stderr.includes(marker)) found.push(`stderr did not contain ${JSON.stringify(marker)}`);
	}
	return found;
}

export function cliInvocationVerifier(): VerifierRunner {
	return {
		async run(descriptor: VerifierDescriptor, context: VerifierContext): Promise<VerifierResult> {
			const plan = currentRuntimePlan().cli;
			const command = descriptor.command.trim().length > 0 ? descriptor.command.trim() : (plan?.command?.trim() ?? "");
			const notRun = (reason: string) =>
				verifierOutcome(descriptor, "not_run", { reason, artifactRef: captureArtifact(context.artifacts, descriptor.kind, reason) });
			if (!plan) return notRun("the contract declares no `verification.runtime.cli` block, so no invocation was named");
			if (command.length === 0) return notRun("the contract names neither a CLI command nor a descriptor command to run");
			const expect = plan.expect;
			if (!expect) return notRun("the contract declares no expectation (expect.exitCode/stdoutEquals/stdoutContains) for the CLI invocation");
			const timeoutMs = Math.min(plan.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS, context.timeoutMs);

			const invocation = startProcess(command, { cwd: context.cwd, ...(plan.stdin !== undefined ? { stdin: plan.stdin } : {}) });
			const outcome = await invocation.awaitReadiness({ timeoutMs });
			if (outcome === "timeout") await invocation.terminate();

			const stdout = invocation.capture("stdout");
			const stderr = invocation.capture("stderr");
			const ended = invocation.exit() ?? { code: null, signal: null };
			const endedText = ended.signal !== null ? `signal ${ended.signal}` : `exit ${ended.code ?? "none"}`;
			const body = [`$ ${command}`, `stdin: ${plan.stdin === undefined ? "(none)" : JSON.stringify(plan.stdin)}`, `exit: ${endedText}`, "--- stdout ---", withoutTrailingNewline(stdout), "--- stderr ---", withoutTrailingNewline(stderr)].join("\n");

			if (outcome === "timeout") {
				const reason = `the invocation timed out after ${timeoutMs}ms and its process group was terminated`;
				return verifierOutcome(descriptor, "fail", {
					exitCode: null,
					reason,
					artifactRef: captureArtifact(context.artifacts, descriptor.kind, `${reason}\n${body}`.slice(-32_768)),
				});
			}

			const reasons = mismatches(expect, { code: ended.code, signal: ended.signal, stdout, stderr });
			if (reasons.length > 0) {
				return verifierOutcome(descriptor, "fail", {
					exitCode: ended.code,
					reason: reasons.join("; "),
					artifactRef: captureArtifact(context.artifacts, descriptor.kind, `${reasons.join("; ")}\n${body}`.slice(-32_768)),
				});
			}
			const reason = `the exit code and streams match the declared expectation (${endedText})`;
			return verifierOutcome(descriptor, "pass", {
				exitCode: ended.code,
				reason,
				artifactRef: captureArtifact(context.artifacts, descriptor.kind, `${reason}\n${body}`.slice(-32_768)),
			});
		},
	};
}
