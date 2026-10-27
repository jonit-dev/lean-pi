/**
 * Privacy modes and the single secret redactor (PRD-002 Phase 4, ROADMAP §48).
 *
 * One function transforms the payload by mode before transmission, and the same
 * redactor is applied to decision-log rows, so there is exactly one definition
 * of "secret" in LeanPi rather than two that can drift.
 */
import type { JevMode } from "../core/types.js";
import { pathHash } from "./registry.js";
import type { JevQuestion, QuestionKind } from "./types.js";

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

/** A static instruction for a kind whose site declared no template to borrow one from. */
const GENERIC_QUESTION_TEXT: Record<QuestionKind, string> = {
	Choice: "Choose the option the state supports.",
	Score: "Score the state against the levels.",
	Noul: "Does the state satisfy the condition?",
};

export interface QuestionProjection {
	/** The questions as they go on the wire: opaque ids and choice keys, template wording. */
	questions: JevQuestion[];
	/** Answers keyed by opaque id, back under the caller's ids and choice keys. */
	restore(answers: Record<string, unknown>): Record<string, unknown>;
}

/** The site's declared question of the same kind; it is the only static surface available. */
function templateFor(question: JevQuestion, templates: readonly JevQuestion[]): JevQuestion | undefined {
	return templates.find((template) => template.kind === question.kind);
}

/**
 * `metadata-only`'s question projection. The state is summarised, but a question
 * carries the same user content in its text, its option keys and even its id (an
 * exploration id names a path). So the request keeps each question's *kind* and
 * answer cardinality, borrows the site's static template for the wording, and
 * maps every identifier to an opaque index. `restore` puts the answer back where
 * the caller expects it, which is why an opaque request can still be answered.
 */
export function staticQuestionProjection(questions: readonly JevQuestion[], templates: readonly JevQuestion[] = []): QuestionProjection {
	const projectedById = new Map<string, { question: JevQuestion; choices: string[] }>();
	const projected = questions.map((question, index): JevQuestion => {
		const id = `q${index}`;
		const template = templateFor(question, templates);
		const text = template?.text ?? GENERIC_QUESTION_TEXT[question.kind];
		switch (question.kind) {
			case "Choice": {
				const choices = Object.keys(question.options);
				const descriptions = template?.kind === "Choice" ? Object.values(template.options) : [];
				projectedById.set(id, { question, choices });
				return {
					id,
					kind: "Choice",
					text,
					options: Object.fromEntries(choices.map((_, choice) => [`o${choice}`, descriptions[choice] ?? null])),
				};
			}
			case "Score": {
				projectedById.set(id, { question, choices: [] });
				return {
					id,
					kind: "Score",
					text,
					levels: question.levels.map((_, level) => (template?.kind === "Score" ? (template.levels[level] ?? `level ${level}`) : `level ${level}`)),
				};
			}
			case "Noul": {
				projectedById.set(id, { question, choices: [] });
				return { id, kind: "Noul", text, ...(template?.kind === "Noul" && template.criteria ? { criteria: template.criteria } : {}) };
			}
		}
	});

	return {
		questions: projected,
		restore(answers) {
			const restored: Record<string, unknown> = {};
			for (const [id, raw] of Object.entries(answers)) {
				const entry = projectedById.get(id);
				if (!entry || raw === null || typeof raw !== "object") {
					restored[id] = raw;
					continue;
				}
				const answer = { ...(raw as Record<string, unknown>) };
				const choiceOf = (key: unknown): unknown =>
					typeof key === "string" && /^o\d+$/.test(key) ? (entry.choices[Number.parseInt(key.slice(1), 10)] ?? key) : key;
				if (answer.choice !== undefined) answer.choice = choiceOf(answer.choice);
				// `probabilities` is keyed by the same choice keys; leave any other shape alone.
				const probabilities = answer.probabilities;
				if (entry.question.kind === "Choice" && probabilities !== null && typeof probabilities === "object") {
					answer.probabilities = Object.fromEntries(
						Object.entries(probabilities as Record<string, unknown>).map(([key, value]) => [String(choiceOf(key)), value]),
					);
				}
				restored[entry.question.id] = answer;
			}
			return restored;
		},
	};
}
