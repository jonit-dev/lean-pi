/**
 * Privacy modes and the single secret redactor (PRD-002 Phase 4, ROADMAP §48).
 *
 * One function transforms the payload by mode before transmission, and the same
 * redactor is applied to decision-log rows, so there is exactly one definition
 * of "secret" in LeanPi rather than two that can drift.
 */
import type { JevMode } from "../core/types.js";
import { pathHash } from "./registry.js";

/**
 * Secret-shaped tokens. Deliberately shape-based: LeanPi redacts by what a
 * secret looks like, not by which vendor issued it.
 */
const SECRET_PATTERNS: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g,
	/\bapikey_[A-Za-z0-9_-]{16,}\b/g,
	/\b(?:gho|ghp|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	/\b(?:Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/g,
	// `.env` assignment values, matched per line so prose is untouched.
	/^[ \t]*(?:export[ \t]+)?[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*[ \t]*=[ \t]*\S.*$/gm,
];

export const REDACTED = "[REDACTED]";

/** Apply every secret shape once; used for both outbound payloads and log rows. */
export function redactSecrets(text: string): string {
	let output = text;
	for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, REDACTED);
	return output;
}

function redactValue(value: unknown): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (Array.isArray(value)) return value.map(redactValue);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactValue(entry)]));
	}
	return value;
}

const PATHISH = /[\\/]|\.(?:ts|tsx|js|jsx|json|md|py|rs|go|java|c|cpp|h|hpp|yml|yaml|toml|lock)$/;

/** A path is a single whitespace-free token; anything with prose or arguments is text. */
function looksLikePath(value: string): boolean {
	return !/\s/.test(value) && value.length > 0 && PATHISH.test(value);
}

/**
 * `metadata-only` replaces every content string with counts, kinds, extensions
 * and salted path hashes, so a file body or a command's output cannot leave the
 * machine even though the classification still happens.
 */
export function metadataSummary(value: unknown, salt: string): unknown {
	if (typeof value === "string") {
		const lines = value.length === 0 ? 0 : value.split("\n").length;
		const isPath = looksLikePath(value);
		const extension = isPath ? (/\.[A-Za-z0-9]+$/.exec(value)?.[0] ?? null) : null;
		return {
			kind: isPath ? "path" : "text",
			chars: value.length,
			lines,
			ext: extension,
			pathHash: isPath ? pathHash(value, salt) : undefined,
		};
	}
	if (Array.isArray(value)) return value.map((entry) => metadataSummary(entry, salt));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, metadataSummary(entry, salt)]));
	}
	return value;
}

export interface OutboundBody {
	state: unknown;
	questions: unknown;
	[key: string]: unknown;
}

/**
 * The one choke point every `ask()` passes through. `disabled` is handled by the
 * caller (no socket is opened); `enabled` is byte-for-byte unchanged.
 */
export function applyPrivacy(mode: JevMode, body: OutboundBody, salt: string): OutboundBody {
	switch (mode) {
		case "enabled":
			return body;
		case "metadata-only":
			return { ...body, state: metadataSummary(body.state, salt) };
		case "redacted":
			return redactValue(body) as OutboundBody;
		case "disabled":
			return body;
	}
}

export function serializeBody(body: OutboundBody): string {
	return JSON.stringify(body);
}
