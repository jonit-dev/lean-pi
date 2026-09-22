/**
 * `screenshot_compare` — capture the declared page and compare it against a
 * stored baseline (PRD-022 Phase 2, AC-4, ROADMAP §35).
 *
 * A comparison is only ever `pass` or `fail` when two real images were decoded:
 * an absent baseline, an unreachable browser facility or an undecodable file is
 * `unavailable`, never a pass on a comparison that did not happen. The diff
 * image is written through PRD-014's artifact store, so the recorded
 * `artifact://` reference resolves to the picture an operator reviews.
 *
 * The viewport and device scale are fixed by the plan (not by the page) so two
 * runs' captures are comparable, and the ratio threshold is configurable because
 * a conservative default that never fires is as useless as one that always does.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { captureArtifact, verifierOutcome, type VerifierContext, type VerifierDescriptor, type VerifierRunner } from "../verify/descriptors.js";
import type { VerifierResult } from "../verify/evidence.js";
import { browserFacility } from "./browser.js";
import { currentRuntimePlan, DEFAULT_DEVICE_SCALE_FACTOR, DEFAULT_VIEWPORT } from "./plan.js";
import { decodePng, encodePng, PngError, pixelDiff, type DecodedPng, type PixelDiff } from "./png.js";

/** 1% of pixels may differ before a page stops matching its baseline. */
const DEFAULT_RATIO_THRESHOLD = 0.01;

export function screenshotCompareVerifier(): VerifierRunner {
	return {
		async run(descriptor: VerifierDescriptor, context: VerifierContext): Promise<VerifierResult> {
			const plan = context.runtime ? context.runtime.screenshot : currentRuntimePlan().screenshot;
			const notRun = (reason: string) =>
				verifierOutcome(descriptor, "not_run", { reason, artifactRef: captureArtifact(context.artifacts, descriptor.kind, reason) });
			if (!plan || plan.url === undefined) return notRun("the contract declares no `verification.runtime.screenshot` url to capture");
			if (plan.baseline === undefined) return notRun("the contract declares no screenshot baseline path to compare against");
			const baselinePath = isAbsolute(plan.baseline) ? plan.baseline : resolve(context.cwd, plan.baseline);
			if (!existsSync(baselinePath)) {
				const reason = `unavailable: the stored baseline ${baselinePath} is missing, so no comparison was made`;
				return verifierOutcome(descriptor, "unavailable", { reason, artifactRef: captureArtifact(context.artifacts, descriptor.kind, reason) });
			}
			const facility = context.browserFacility !== undefined ? (context.browserFacility ?? undefined) : browserFacility();
			if (!facility) {
				const reason = "unavailable: no browser facility is exposed by this host, so no screenshot could be captured";
				return verifierOutcome(descriptor, "unavailable", { reason, artifactRef: captureArtifact(context.artifacts, descriptor.kind, reason) });
			}

			const viewport = plan.viewport ?? { ...DEFAULT_VIEWPORT };
			const threshold = plan.threshold ?? DEFAULT_RATIO_THRESHOLD;
			let captured: Buffer;
			try {
				const tab = await facility.open({ viewport, deviceScaleFactor: plan.deviceScaleFactor ?? DEFAULT_DEVICE_SCALE_FACTOR });
				try {
					await tab.goto(plan.url);
					captured = Buffer.from(await tab.screenshot());
				} finally {
					await tab.close().catch(() => {
						// A handle the facility already tore down is not a verifier failure.
					});
				}
			} catch (error) {
				const reason = `capturing ${plan.url} failed: ${error instanceof Error ? error.message : String(error)}`;
				return verifierOutcome(descriptor, "error", {
					reason,
					artifactRef: captureArtifact(context.artifacts, descriptor.kind, reason),
				});
			}

			let baseline: DecodedPng;
			let capture: DecodedPng;
			try {
				baseline = decodePng(readFileSync(baselinePath));
				capture = decodePng(captured);
			} catch (error) {
				if (error instanceof PngError && error.message.startsWith("screenshot dimensions differ")) {
					return verifierOutcome(descriptor, "fail", {
						reason: error.message,
						artifactRef: captureArtifact(context.artifacts, descriptor.kind, `${error.message}\n${plan.url} · baseline ${baselinePath}`),
					});
				}
				const reason = `the comparison could not be made: ${error instanceof Error ? error.message : String(error)}`;
				return verifierOutcome(descriptor, "error", {
					reason,
					artifactRef: captureArtifact(context.artifacts, descriptor.kind, `${reason}\nbaseline ${baselinePath}`),
				});
			}

			let diff: PixelDiff;
			try {
				diff = pixelDiff(baseline, capture, { ...(plan.colorThreshold !== undefined ? { colorThreshold: plan.colorThreshold } : {}) });
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return verifierOutcome(descriptor, "fail", {
					reason,
					artifactRef: captureArtifact(context.artifacts, descriptor.kind, `${reason}\n${plan.url} · baseline ${baselinePath}`),
				});
			}

			const summary = `${plan.url} · ${capture.width}x${capture.height} · ${diff.differing}/${diff.total} pixels differ (ratio ${diff.ratio.toFixed(4)}, threshold ${threshold})`;
			const artifactRef = context.artifacts?.store(encodePng(capture.width, capture.height, diff.diff, { text: summary }), descriptor.kind, descriptor.kind) ?? null;
			if (diff.ratio > threshold) {
				const reason = `the capture exceeds the configured threshold: ${summary}`;
				return verifierOutcome(descriptor, "fail", { reason, artifactRef });
			}
			return verifierOutcome(descriptor, "pass", { reason: `the capture matches its baseline: ${summary}`, artifactRef });
		},
	};
}
