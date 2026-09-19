/**
 * The JEV client (PRD-002 Phases 1, 4 and 5).
 *
 * One function, `ask(siteId, questions, state)`: the site id is the first
 * positional argument and is load-bearing, not a label — `ask()` looks the row
 * up before it serializes anything, and the row supplies the fallback, the
 * consequence class and the telemetry tag. There is no two-argument form, which
 * is why §49's fallback guarantee and FR-020's log row are structural rather
 * than conventional.
 *
 * JEV is constructed during `activate()` and handed to lanes by reference. It is
 * never registered as a tool, so no executor model can reach it (FR-010).
 */
import type { LeanPiConfig, JevMode } from "../core/types.js";
import { accept } from "./confidence.js";
import { resolveCredential, type CredentialEnv, type CredentialSource } from "./credentials.js";
import { createDecisionLog, type DecisionLog, type DecisionRow } from "./log.js";
import { applyPrivacy, redactSecrets, serializeBody } from "./privacy.js";
import { emptyUsage, getSite, listSites, type DecisionSite } from "./registry.js";
import { answerValue, decisiveness, type JevQuestion, type JevResult, type JevUsage, type QuestionKind } from "./types.js";

export const JEV_ENDPOINT_DEFAULT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL_DEFAULT = "jev-latest";
/** ROADMAP §5: $0.042 per million input tokens, output free. */
export const JEV_INPUT_COST_PER_MILLION = 0.042;

export interface JevTransportRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

export interface JevTransportResponse {
	status: number;
	text: string;
}

export type JevTransport = (request: JevTransportRequest) => Promise<JevTransportResponse>;

export interface JevStatus {
	configured: boolean;
	source: CredentialSource;
	mode: JevMode;
	modelVersion: string;
	fallbackCount: number;
	reachable: boolean;
	/** Capabilities that are degraded while no key is configured. */
	degraded: string[];
}

export interface JevTestResult {
	ok: boolean;
	modelVersion: string;
	latencyMs: number;
	costUsd: number;
	answer?: JevResult;
	error?: string;
}

export interface JevClient {
	/** One request per decision point, never one per question (FR-011). */
	ask(siteId: string, questions: JevQuestion[], state: unknown): Promise<JevResult[]>;
	sites(): DecisionSite[];
	getMode(): JevMode;
	setMode(mode: JevMode): void;
	fallbackCount(): number;
	credentialSource(): CredentialSource;
	status(): Promise<JevStatus>;
	/** Exactly one validation attempt — an invalid key yields one error, not a retry loop. */
	validateKey(key: string): Promise<JevTestResult>;
	test(): Promise<JevTestResult>;
}

export interface JevClientOptions {
	config: LeanPiConfig;
	cwd: string;
	transport?: JevTransport;
	log?: DecisionLog;
	endpoint?: string;
	model?: string;
	env?: CredentialEnv;
	now?: () => Date;
	salt?: string;
	/** Overrides credential resolution, e.g. to persist a key captured at first run. */
	credential?: () => { key: string | null; source: CredentialSource };
}

interface WireAnswer {
	type?: string;
	choice?: string;
	probabilities?: Record<string, number>;
	confidence?: number;
	score?: number;
	legend?: Record<string, string>;
	noul?: number;
}

class JevResponseError extends Error {}

function defaultTransport({ url, headers, body }: JevTransportRequest): Promise<JevTransportResponse> {
	return fetch(url, { method: "POST", headers, body }).then(async (response) => ({
		status: response.status,
		text: await response.text(),
	}));
}

function wireQuestion(question: JevQuestion): Record<string, unknown> {
	switch (question.kind) {
		case "Choice":
			return { type: "choice", instructions: question.text, criteria: question.options };
		case "Score":
			return { type: "score", instructions: question.text, criteria: question.levels };
		case "Noul":
			return { type: "noul", instructions: question.text, ...(question.criteria ? { criteria: question.criteria } : {}) };
	}
}

function mapAnswer(question: JevQuestion, answer: WireAnswer | undefined): JevResult {
	if (!answer || typeof answer.type !== "string") {
		throw new JevResponseError(`question "${question.id}" has no answer`);
	}
	const kind = answer.type.toLowerCase();
	if (kind !== question.kind.toLowerCase()) {
		// A mismatch between the declared and returned kind is an error, never a silent cast.
		throw new JevResponseError(`question "${question.id}" declared ${question.kind} but the service answered ${answer.type}`);
	}
	switch (question.kind) {
		case "Choice": {
			if (typeof answer.choice !== "string") throw new JevResponseError(`choice answer for "${question.id}" is missing "choice"`);
			return {
				kind: "Choice",
				questionId: question.id,
				choice: answer.choice,
				probabilities: answer.probabilities ?? {},
				confidence: answer.confidence ?? 0,
			};
		}
		case "Score": {
			if (typeof answer.score !== "number") throw new JevResponseError(`score answer for "${question.id}" is missing "score"`);
			return {
				kind: "Score",
				questionId: question.id,
				score: answer.score,
				legend: answer.legend ?? {},
				confidence: answer.confidence ?? 0,
			};
		}
		case "Noul": {
			if (typeof answer.noul !== "number") throw new JevResponseError(`noul answer for "${question.id}" is missing "noul"`);
			return { kind: "Noul", questionId: question.id, value: answer.noul, confidence: decisiveness(answer.noul) };
		}
	}
}

export function createJevClient(options: JevClientOptions): JevClient {
	const { config, cwd } = options;
	const transport = options.transport ?? defaultTransport;
	const log = options.log ?? createDecisionLog(`${cwd}/.leanpi/decisions.jsonl`);
	const endpoint = options.endpoint ?? config.jev.endpoint ?? JEV_ENDPOINT_DEFAULT;
	const model = options.model ?? config.jev.model ?? JEV_MODEL_DEFAULT;
	const env = options.env ?? process.env;
	// The salt keeps `metadata-only` path hashes stable within a project while
	// staying useless outside it.
	const salt = options.salt ?? `${options.now?.().toISOString().slice(0, 10) ?? ""}:${cwd}`;
	const now = options.now ?? (() => new Date());
	const currentCredential = options.credential ?? (() => resolveCredential(config, env));

	let mode: JevMode = config.jev.mode;
	let fallbackCount = 0;
	let reachable = false;
	let modelVersion = model;

	function rowFor(site: DecisionSite, results: JevResult[], usage: JevUsage, reason?: string): DecisionRow {
		const confidences = results.map((result) => result.confidence);
		return {
			timestamp: now().toISOString(),
			siteId: site.id,
			telemetryTag: site.telemetryTag,
			modelVersion,
			fallbackUsed: reason !== undefined,
			...(reason === undefined ? {} : { reason }),
			confidence: confidences.length > 0 ? Math.min(...confidences) : null,
			answers: results.map((result) => ({
				questionId: result.questionId,
				kind: result.kind,
				value: answerValue(result),
				confidence: result.confidence,
			})),
			tokens: usage,
		};
	}

	function resolveByFallback(site: DecisionSite, questions: JevQuestion[], state: unknown, reason: string): JevResult[] {
		const results = site.fallback({ siteId: site.id, reason, state, questions });
		if (!Array.isArray(results) || results.length !== questions.length) {
			throw new Error(`Fallback for site "${site.id}" returned ${Array.isArray(results) ? results.length : 0} results for ${questions.length} questions.`);
		}
		fallbackCount += 1;
		log.append(rowFor(site, results, emptyUsage(), reason));
		return results;
	}

	async function send(key: string, questions: JevQuestion[], state: unknown): Promise<{ answers: Record<string, WireAnswer>; usage: JevUsage; model: string }> {
		const body = applyPrivacy(
			mode,
			{
				state,
				model,
				questions: Object.fromEntries(questions.map((question) => [question.id, wireQuestion(question)])),
			},
			salt,
		);
		const response = await transport({
			url: endpoint,
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: serializeBody(body),
		});
		reachable = response.status >= 200 && response.status < 300;
		if (!reachable) {
			// The status alone is not actionable; the body is redacted through the
			// same choke point so a service echo cannot leak a credential.
			throw new Error(`JEV responded ${response.status}: ${redactSecrets(response.text).slice(0, 200)}`);
		}
		const parsed = JSON.parse(response.text) as {
			model?: string;
			answers?: Record<string, WireAnswer>;
			usage?: { input_tokens?: number; output_tokens?: number };
		};
		return {
			answers: parsed.answers ?? {},
			usage: { inputTokens: parsed.usage?.input_tokens ?? 0, outputTokens: parsed.usage?.output_tokens ?? 0 },
			model: parsed.model ?? model,
		};
	}

	return {
		async ask(siteId, questions, state) {
			const site = getSite(siteId);
			const declared: QuestionKind[] = site.questions.map((question) => question.kind);
			if (questions.length !== declared.length) {
				throw new Error(`Site "${siteId}" declares ${declared.length} questions but ${questions.length} were asked.`);
			}

			if (mode === "disabled") return resolveByFallback(site, questions, state, "privacy-mode-disabled");
			const credential = currentCredential();
			if (!credential.key) return resolveByFallback(site, questions, state, "no-credential");

			let response: { answers: Record<string, WireAnswer>; usage: JevUsage; model: string };
			try {
				response = await send(credential.key, questions, state);
			} catch (error) {
				return resolveByFallback(site, questions, state, error instanceof Error ? error.message : "transport-error");
			}

			let results: JevResult[];
			try {
				results = questions.map((question) => mapAnswer(question, response.answers[question.id]));
			} catch (error) {
				return resolveByFallback(site, questions, state, error instanceof Error ? error.message : "answer-mapping-error");
			}

			modelVersion = response.model;
			if (!results.every((result) => accept(result, site.consequence))) {
				return resolveByFallback(site, questions, state, "below-threshold");
			}
			log.append(rowFor(site, results, response.usage));
			return results;
		},

		sites: () => listSites(),
		getMode: () => mode,
		setMode(next) {
			mode = next;
		},
		fallbackCount: () => fallbackCount,
		credentialSource: () => currentCredential().source,
		async status() {
			const credential = currentCredential();
			return {
				configured: credential.key !== null,
				source: credential.source,
				mode,
				modelVersion,
				fallbackCount,
				reachable,
				degraded: credential.key === null ? ["planning gate", "complexity classification", "skill disclosure", "proof sufficiency"] : [],
			};
		},

		async validateKey(key) {
			const started = now().getTime();
			try {
				const response = await send(key, [{ id: "jev_check", kind: "Noul", text: "Is this a valid request?" }], { probe: true });
				const answer = mapAnswer({ id: "jev_check", kind: "Noul", text: "Is this a valid request?" }, response.answers.jev_check);
				modelVersion = response.model;
				return {
					ok: true,
					modelVersion: response.model,
					latencyMs: now().getTime() - started,
					costUsd: (response.usage.inputTokens / 1_000_000) * JEV_INPUT_COST_PER_MILLION,
					answer,
				};
			} catch (error) {
				return {
					ok: false,
					modelVersion,
					latencyMs: now().getTime() - started,
					costUsd: 0,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},

		async test() {
			const credential = currentCredential();
			if (!credential.key) {
				return { ok: false, modelVersion, latencyMs: 0, costUsd: 0, error: "no JEV credential configured" };
			}
			return this.validateKey(credential.key);
		},
	};
}
