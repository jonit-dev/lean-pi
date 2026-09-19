/**
 * The browser facility seam and the `browser_test` verifier (PRD-022 Phase 2,
 * AC-3, ROADMAP §35/§40).
 *
 * No browser engine is bundled: the host harness owns the browser and hands
 * LeanPi a tab handle through `BrowserFacility`. A production adapter maps the
 * harness's own tab (`observe`/`evaluate`/`screenshot`/`close`) onto the four
 * methods below; when no facility is reachable — no adapter wired, no harness
 * browser, `globalThis.browser` absent — the verifier records `unavailable`,
 * which is a first-class status distinct from `fail` so the gate reports "could
 * not obtain browser evidence" rather than "the UI is broken".
 *
 * The verifier asserts only what the contract declares: a URL, CSS selectors and
 * text. Nothing here infers a selector from a rendered page, and nothing raises
 * an unobserved assertion to a pass.
 */
import { captureArtifact, verifierOutcome, type VerifierContext, type VerifierDescriptor, type VerifierRunner } from "../verify/descriptors.js";
import type { VerifierResult } from "../verify/evidence.js";
import { currentRuntimePlan, DEFAULT_DEVICE_SCALE_FACTOR, DEFAULT_VIEWPORT } from "./plan.js";

const DEFAULT_NAVIGATE_TIMEOUT_MS = 20_000;

export interface BrowserQuery {
	count: number;
	text: string | null;
}

/** What LeanPi needs from a tab handle. The host adapter maps its own handle onto these four. */
export interface BrowserTab {
	/** Navigate and settle before resolving; rejects when the page cannot be loaded. */
	goto(url: string, options?: { timeoutMs?: number }): Promise<void>;
	/** Number of elements matching a CSS selector and the first match's text. */
	querySelector(selector: string): Promise<BrowserQuery>;
	/** The page's visible text, for text assertions. */
	text(): Promise<string>;
	/** A PNG capture at the fixed viewport and device scale the facility was opened with. */
	screenshot(): Promise<Uint8Array | Buffer>;
	close(): Promise<void>;
}

export interface BrowserOpenOptions {
	viewport: { width: number; height: number };
	deviceScaleFactor: number;
}

export interface BrowserFacility {
	open(options: BrowserOpenOptions): BrowserTab | Promise<BrowserTab>;
}

let injected: BrowserFacility | null | undefined;

/** Inject the harness adapter (tests, or a host that owns the browser). `null` disables the facility. */
export function setBrowserFacility(facility: BrowserFacility | null | undefined): void {
	injected = facility;
}

function isFacility(value: unknown): value is BrowserFacility {
	return value !== null && typeof value === "object" && typeof (value as { open?: unknown }).open === "function";
}

/** The injected adapter, else the harness's `globalThis.browser`; `undefined` when neither exists. */
export function browserFacility(): BrowserFacility | undefined {
	if (injected !== undefined) return injected ?? undefined;
	return isFacility((globalThis as { browser?: unknown }).browser) ? (globalThis as { browser?: unknown }).browser as BrowserFacility : undefined;
}

interface TraceStep {
	step: "goto" | "selector" | "text";
	target: string;
	result: string;
}

/** Line one is the reason, so a packet reading the artifact's first line names the failure. */
function trace(reason: string, url: string, steps: readonly TraceStep[], viewport: { width: number; height: number }): string {
	return `${reason}\n${JSON.stringify({ url, viewport, deviceScaleFactor: DEFAULT_DEVICE_SCALE_FACTOR, steps }, null, 2)}`;
}

export function browserTestVerifier(): VerifierRunner {
	return {
		async run(descriptor: VerifierDescriptor, context: VerifierContext): Promise<VerifierResult> {
			const plan = currentRuntimePlan().browser;
			const notRun = (reason: string) =>
				verifierOutcome(descriptor, "not_run", { reason, artifactRef: captureArtifact(context.artifacts, descriptor.kind, reason) });
			if (!plan || plan.url === undefined) return notRun("the contract declares no `verification.runtime.browser` url to drive");
			if ((plan.selectors ?? []).length === 0 && (plan.text ?? []).length === 0) {
				return notRun("the contract declares no browser assertion (selectors or text) to check");
			}
			const facility = browserFacility();
			if (!facility) {
				const reason = "unavailable: no browser facility is exposed by this host, so no rendered UI evidence could be collected";
				return verifierOutcome(descriptor, "unavailable", { reason, artifactRef: captureArtifact(context.artifacts, descriptor.kind, reason) });
			}

			const timeoutMs = Math.min(plan.timeoutMs ?? DEFAULT_NAVIGATE_TIMEOUT_MS, context.timeoutMs);
			const viewport = { ...DEFAULT_VIEWPORT };
			const steps: TraceStep[] = [];
			let tab: BrowserTab | undefined;
			try {
				tab = await facility.open({ viewport, deviceScaleFactor: DEFAULT_DEVICE_SCALE_FACTOR });
				await tab.goto(plan.url, { timeoutMs });
				steps.push({ step: "goto", target: plan.url, result: "loaded" });
				for (const selector of plan.selectors ?? []) {
					const found = await tab.querySelector(selector);
					steps.push({ step: "selector", target: selector, result: `${found.count} match(es)${found.text === null ? "" : `, text ${JSON.stringify(found.text.slice(0, 80))}`}` });
					if (found.count === 0) {
						const reason = `selector ${JSON.stringify(selector)} matched no element on ${plan.url}`;
						return verifierOutcome(descriptor, "fail", {
							reason,
							artifactRef: captureArtifact(context.artifacts, descriptor.kind, trace(reason, plan.url, steps, viewport)),
						});
					}
				}
				if ((plan.text ?? []).length > 0) {
					const pageText = await tab.text();
					for (const expected of plan.text ?? []) {
						const present = pageText.includes(expected);
						steps.push({ step: "text", target: expected, result: present ? "present" : "absent" });
						if (!present) {
							const reason = `expected text ${JSON.stringify(expected)} is absent from ${plan.url}`;
							return verifierOutcome(descriptor, "fail", {
								reason,
								artifactRef: captureArtifact(context.artifacts, descriptor.kind, trace(reason, plan.url, steps, viewport)),
							});
						}
					}
				}
				const reason = `asserted ${steps.length - 1} declaration(s) against ${plan.url}`;
				return verifierOutcome(descriptor, "pass", {
					reason,
					artifactRef: captureArtifact(context.artifacts, descriptor.kind, trace(reason, plan.url, steps, viewport)),
				});
			} catch (error) {
				const reason = `driving the browser facility failed: ${error instanceof Error ? error.message : String(error)}`;
				return verifierOutcome(descriptor, "error", {
					reason,
					artifactRef: captureArtifact(context.artifacts, descriptor.kind, trace(reason, plan.url, steps, viewport)),
				});
			} finally {
				await tab?.close().catch(() => {
					// A handle the facility already tore down is not a verifier failure.
				});
			}
		},
	};
}
