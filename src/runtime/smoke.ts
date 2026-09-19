/**
 * `runtime_smoke` — start the task's program, wait for the readiness signal the
 * contract declares, then terminate it (PRD-022 Phase 1, AC-1, ROADMAP §35).
 *
 * The verifier infers nothing: command, readiness signal and timeout all come
 * from the contract's `verification.runtime.smoke` block. A program that exits
 * before the signal is a `fail` naming the exit; a deadline that passes with the
 * program still silent is a `fail` carrying the captured output — never a pass
 * and never a retry. The child is reaped on every path, so a hung server cannot
 * outlive the verifier that started it (§43).
 */
import {
	captureArtifact,
	verifierOutcome,
	type VerifierContext,
	type VerifierDescriptor,
	type VerifierRunner,
} from "../verify/descriptors.js";
import type { VerifierResult } from "../verify/evidence.js";
import { currentRuntimePlan } from "./plan.js";
import { startProcess, type ReadinessOutcome } from "./proc.js";

const DEFAULT_READY_TIMEOUT_MS = 10_000;

/** The captured stdio an operator reads to see what the program actually printed. */
function payload(reason: string, command: string, ended: string, captured: string): string {
	return `${reason}\n$ ${command}\nexit: ${ended}\n${captured.trim()}`.slice(-32_768);
}

export function runtimeSmokeVerifier(): VerifierRunner {
	return {
		async run(descriptor: VerifierDescriptor, context: VerifierContext): Promise<VerifierResult> {
			const plan = currentRuntimePlan().smoke;
			const command = descriptor.command.trim().length > 0 ? descriptor.command.trim() : (plan?.command?.trim() ?? "");
			const notRun = (reason: string) =>
				verifierOutcome(descriptor, "not_run", { reason, artifactRef: captureArtifact(context.artifacts, descriptor.kind, reason) });
			if (!plan) return notRun("the contract declares no `verification.runtime.smoke` block, so no service to start was named");
			if (command.length === 0) return notRun("the contract names neither a smoke command nor a descriptor command to run");
			const ready = plan.ready;
			if (!ready || (ready.log === undefined && ready.port === undefined)) {
				return notRun("the contract declares no readiness signal (ready.log or ready.port) for the smoke command");
			}
			let pattern: RegExp | undefined;
			if (ready.log !== undefined) {
				try {
					pattern = new RegExp(ready.log);
				} catch (error) {
					const reason = `the declared readiness log pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`;
					return verifierOutcome(descriptor, "error", { reason, artifactRef: captureArtifact(context.artifacts, descriptor.kind, reason) });
				}
			}
			const signal = ready.log === undefined ? `port ${ready.port}` : ready.port === undefined ? `log /${ready.log}/` : `log /${ready.log}/ or port ${ready.port}`;
			const timeoutMs = Math.min(ready.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS, context.timeoutMs);

			const service = startProcess(command, { cwd: context.cwd });
			let outcome: ReadinessOutcome;
			try {
				outcome = await service.awaitReadiness({
					...(pattern ? { log: pattern } : {}),
					...(ready.port !== undefined ? { port: ready.port } : {}),
					timeoutMs,
				});
			} catch (error) {
				await service.terminate();
				const reason = `starting ${command} failed: ${error instanceof Error ? error.message : String(error)}`;
				return verifierOutcome(descriptor, "error", {
					reason,
					artifactRef: captureArtifact(context.artifacts, descriptor.kind, payload(reason, command, "none", service.capture())),
				});
			}

			if (service.pid === undefined) {
				const reason = `starting ${command} failed: ${service.capture().trim().split("\n")[0] ?? "the process could not be launched"}`;
				return verifierOutcome(descriptor, "error", {
					reason,
					artifactRef: captureArtifact(context.artifacts, descriptor.kind, payload(reason, command, "none", service.capture())),
				});
			}

			if (outcome === "ready") {
				await service.terminate();
				const reason = `readiness observed (${signal}) within ${timeoutMs}ms; the service was terminated and its process group reaped`;
				return verifierOutcome(descriptor, "pass", {
					exitCode: null,
					artifactRef: captureArtifact(context.artifacts, descriptor.kind, payload(reason, command, "terminated after readiness", service.capture())),
				});
			}

			await service.terminate();
			const ended = service.exit() ?? { code: null, signal: null };
			const endedText = ended.signal !== null ? `signal ${ended.signal}` : `exit ${ended.code ?? "none"}`;
			const reason =
				outcome === "exited"
					? `the service ${endedText} before the readiness signal (${signal}) was observed`
					: `timed out after ${timeoutMs}ms waiting for the readiness signal (${signal})`;
			return verifierOutcome(descriptor, "fail", {
				exitCode: ended.code,
				reason,
				artifactRef: captureArtifact(context.artifacts, descriptor.kind, payload(reason, command, endedText, service.capture())),
			});
		},
	};
}
