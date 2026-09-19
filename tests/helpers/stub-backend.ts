/**
 * A stub OpenAI-compatible backend.
 *
 * LeanPi's tests never mock Pi's provider plumbing: they register a real
 * provider pointing at this server and assert on the requests it actually
 * received, so the payload under assertion is the payload Pi would have sent.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubToolCall {
	id?: string;
	name: string;
	args: unknown;
}

export type StubStep = { text: string } | { toolCalls: StubToolCall[] } | { status: number; body?: string };

export interface CapturedRequest {
	url: string;
	model: string;
	body: Record<string, unknown>;
	headers: Record<string, string | string[] | undefined>;
}

export interface StubBackend {
	baseUrl: string;
	requests: CapturedRequest[];
	/** Response script; the last step repeats once the queue is exhausted. */
	steps: StubStep[];
	close(): Promise<void>;
}

function sseLine(model: string, delta: Record<string, unknown>, finishReason: string | null): string {
	const payload = {
		id: "chatcmpl-stub",
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function startStubBackend(steps: StubStep[] = [{ text: "ok" }]): Promise<StubBackend> {
	const requests: CapturedRequest[] = [];
	const server: Server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			let body: Record<string, unknown> = {};
			try {
				body = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				body = { unparsable: raw };
			}
			requests.push({
				url: req.url ?? "",
				model: String(body.model ?? ""),
				body,
				headers: req.headers,
			});

			const step = steps[Math.min(requests.length - 1, steps.length - 1)] as StubStep;
			if ("status" in step) {
				res.writeHead(step.status, { "content-type": "application/json" });
				res.end(step.body ?? JSON.stringify({ error: { message: "stub failure" } }));
				return;
			}

			const model = String(body.model ?? "stub");
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			if ("text" in step) {
				res.write(sseLine(model, { role: "assistant", content: step.text }, null));
				res.write(sseLine(model, {}, "stop"));
			} else {
				res.write(
					sseLine(
						model,
						{
							role: "assistant",
							content: null,
							tool_calls: step.toolCalls.map((call, index) => ({
								index,
								id: call.id ?? `call_${index}`,
								type: "function",
								function: { name: call.name, arguments: JSON.stringify(call.args) },
							})),
						},
						null,
					),
				);
				res.write(sseLine(model, {}, "tool_calls"));
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		steps,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
	};
}
