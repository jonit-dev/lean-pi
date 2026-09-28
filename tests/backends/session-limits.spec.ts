/**
 * Session-scoped provider health: the classifier that tells a provider limit
 * from an operator interrupt, the cooldown that remembers it, and the role
 * resolution that walks the ladder past a limited backend.
 *
 * Red on `main`: neither the classifier nor `SessionLimits` exists, and
 * `resolveRoleAvoiding` is absent, so this file cannot even import.
 */
import { describe, expect, it } from "vitest";
import { assistantOutcome, classifyAssistantFailure, SessionLimits } from "../../src/backends/session-limits.js";
import { resolveRoleAvoiding } from "../../src/core/roles.js";
import type { LeanPiConfig } from "../../src/core/types.js";

/** A config whose two backends are unknown to the ranking, so the static ladder decides. */
const config = {
	backends: {
		metered: { type: "native", baseUrl: "https://stub", api: "openai-completions", apiKey: "k" },
		subscription: { type: "external_harness", vendor: "claude", command: "claude" },
	},
	models: {
		quick: { backend: "metered", model: "leanpi-test-flash" },
		balanced: { backend: "metered", model: "leanpi-test-flash" },
		strong: { backend: "subscription", model: "leanpi-test-opus" },
		specialist: { backend: "subscription", model: "leanpi-test-opus" },
	},
} as unknown as LeanPiConfig;

describe("classifyAssistantFailure", () => {
	it("names a 429 and a 402 as a limit", () => {
		expect(classifyAssistantFailure({ stopReason: "error", errorMessage: '429: {"type":"GoUsageLimitError"}' })?.kind).toBe("limit");
		expect(classifyAssistantFailure({ stopReason: "error", errorMessage: "402 Insufficient account funds" })?.kind).toBe("limit");
	});

	it("names a 401 and a 403 as auth", () => {
		expect(classifyAssistantFailure({ stopReason: "error", errorMessage: "401 Invalid API key." })?.kind).toBe("auth");
		expect(classifyAssistantFailure({ stopReason: "error", errorMessage: "opencode API error (403): FreeTierError" })?.kind).toBe("auth");
	});

	it("refuses to call an operator interrupt a provider failure", () => {
		// Pi reports Esc as `error` + this exact text; marking a healthy provider
		// limited on a keypress is the bug this guards.
		expect(classifyAssistantFailure({ stopReason: "error", errorMessage: "This operation was aborted" })).toBeNull();
		expect(classifyAssistantFailure({ stopReason: "aborted", errorMessage: "This operation was aborted" })).toBeNull();
	});

	it("ignores a plain error and a completed turn", () => {
		expect(classifyAssistantFailure({ stopReason: "error", errorMessage: "Stream ended without finish_reason" })).toBeNull();
		expect(classifyAssistantFailure({ stopReason: "stop" })).toBeNull();
		expect(classifyAssistantFailure({})).toBeNull();
	});
});

describe("assistantOutcome", () => {
	it("names an operator interrupt aborted, not an error", () => {
		expect(assistantOutcome({ stopReason: "error", errorMessage: "This operation was aborted" })).toBe("aborted");
		expect(assistantOutcome({ stopReason: "aborted", errorMessage: "This operation was aborted" })).toBe("aborted");
	});

	it("keeps a real provider error an error, and a stop a completion", () => {
		expect(assistantOutcome({ stopReason: "error", errorMessage: "Stream ended without finish_reason" })).toBe("error");
		expect(assistantOutcome({ stopReason: "error", errorMessage: "429 usage limit" })).toBe("error");
		expect(assistantOutcome({ stopReason: "stop" })).toBe("completed");
		expect(assistantOutcome({})).toBe("completed");
	});
});

describe("SessionLimits", () => {
	it("remembers a backend until its cooldown expires", () => {
		let clock = 1_000;
		const limits = new SessionLimits({ cooldownMs: 1_000, now: () => clock });
		expect(limits.isLimited("metered")).toBe(false);
		limits.mark("metered");
		expect(limits.isLimited("metered")).toBe(true);
		expect(limits.isLimited("subscription")).toBe(false);
		clock += 999;
		expect(limits.isLimited("metered")).toBe(true);
		clock += 1;
		expect(limits.isLimited("metered")).toBe(false);
	});
});

describe("resolveRoleAvoiding", () => {
	it("walks the ladder past a limited backend", () => {
		const limited = new SessionLimits();
		limited.mark("metered");
		const chosen = resolveRoleAvoiding(config, "balanced", (backend) => limited.isLimited(backend));
		// `balanced` and `quick` both live on `metered`, so the chain reaches `strong`.
		expect(chosen.ref).toEqual({ backend: "subscription", model: "leanpi-test-opus", type: "external_harness" });
		expect(chosen.from).toBe("strong");
	});

	it("keeps the role's own backend when nothing is limited", () => {
		const chosen = resolveRoleAvoiding(config, "balanced", () => false);
		expect(chosen.ref).toEqual({ backend: "metered", model: "leanpi-test-flash", type: "native" });
		expect(chosen.from).toBe("balanced");
	});

	it("falls back to the requested role when every backend is limited", () => {
		const chosen = resolveRoleAvoiding(config, "balanced", () => true);
		expect(chosen.ref).toEqual({ backend: "metered", model: "leanpi-test-flash", type: "native" });
		expect(chosen.from).toBe("balanced");
	});
});
