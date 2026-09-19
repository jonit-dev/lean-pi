/**
 * A stub JEV evaluation endpoint.
 *
 * The wire shape mirrors TypeSafe's real endpoint (`POST /v1/systemone`), so the
 * assertions in the JEV suite are made against the request LeanPi actually sent.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubJevRequest {
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: Record<string, unknown>;
}

export interface StubJevReply {
	status?: number;
	model?: string;
	answers?: Record<string, unknown>;
	usage?: { input_tokens: number; output_tokens: number };
}

export type StubJevResponder = (body: Record<string, unknown>, requestIndex: number) => StubJevReply;

export interface StubJev {
	url: string;
	requests: StubJevRequest[];
	/** Raw request bodies as received, before any parsing beyond JSON. */
	raw: string[];
	close(): Promise<void>;
}

type WireQuestion = { type?: string; criteria?: unknown };

/** A confident, well-typed answer for every question in the request. */
export function typedAnswers(body: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const questions = (body.questions ?? {}) as Record<string, WireQuestion>;
	const answers: Record<string, unknown> = {};
	for (const [id, question] of Object.entries(questions)) {
		switch (question.type) {
			case "choice": {
				const options = Object.keys((question.criteria ?? {}) as Record<string, unknown>);
				answers[id] = {
					type: "choice",
					choice: options[0] ?? "none",
					probabilities: Object.fromEntries(options.map((option, index) => [option, index === 0 ? 0.9 : 0.1 / Math.max(options.length - 1, 1)])),
					confidence: 0.9,
				};
				break;
			}
			case "score":
				answers[id] = { type: "score", score: 2, legend: {}, probabilities: {}, confidence: 0.9 };
				break;
			default:
				answers[id] = { type: "noul", noul: 0.92 };
		}
	}
	return { ...answers, ...overrides };
}

export async function startStubJev(responders: StubJevResponder[] = []): Promise<StubJev> {
	const requests: StubJevRequest[] = [];
	const raw: string[] = [];
	const server: Server = createServer((req, res) => {
		let text = "";
		req.on("data", (chunk) => (text += chunk));
		req.on("end", () => {
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(text) as Record<string, unknown>;
			} catch {
				body = { unparsable: text };
			}
			requests.push({ url: req.url ?? "", headers: req.headers, body });
			raw.push(text);

			const index = requests.length - 1;
			const responder = responders[Math.min(index, responders.length - 1)];
			const reply: StubJevReply = responder ? responder(body, index) : { answers: typedAnswers(body) };
			if (reply.status && (reply.status < 200 || reply.status >= 300)) {
				res.writeHead(reply.status, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "stub failure" } }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					model: reply.model ?? "jev-stub-1.0",
					answers: reply.answers ?? typedAnswers(body),
					usage: reply.usage ?? { input_tokens: 120, output_tokens: 8 },
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/v1/systemone`,
		requests,
		raw,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}
