/**
 * A provider that refuses image input must not kill the session.
 *
 * OpenCode Go routes one model id to several engines and only some accept images.
 * Once a screenshot was in context, every request failed with `image input is not
 * available on this engine` until the user restarted (two sessions, 2026-11-04).
 * Drives a real Pi session against a stub that refuses any request carrying an
 * image: the turn must recover once, with the image replaced by a note.
 */
import { describe, expect, it } from "vitest";
import { bootSession, headlessUIContext, nativeBackend, tempDir, writeConfig } from "./helpers/fixtures.js";
import { startStubBackend } from "./helpers/stub-backend.js";

const REFUSAL = '{"param":null,"type":"invalid_request_error","code":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] image input is not available on this engine (request_id: gw-test)"}';
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const hasImage = (body: Record<string, unknown>): boolean => JSON.stringify(body.messages).includes("image_url");

describe("a provider that refuses image input", () => {
	it("drops the images from context and retries the turn once", async () => {
		const stub = await startStubBackend([], { respond: (body) => (hasImage(body) ? { status: 400, body: REFUSAL } : { text: "read it as text" }) });
		const cwd = tempDir("leanpi-image-refusal-");
		writeConfig(cwd, {
			backends: { local: nativeBackend(stub.baseUrl, { input: ["text", "image"] }) },
			models: { quick: { backend: "local", model: "vision-flaky" }, balanced: { backend: "local", model: "vision-flaky" } },
			lsp: { mode: "off" }, jev: { mode: "disabled" },
		});
		const app = await bootSession({ cwd });
		await app.session.bindExtensions({ uiContext: headlessUIContext() });
		try {
			await app.session.prompt("what is in this screenshot?", { images: [{ type: "image", data: PIXEL, mimeType: "image/png" }] });
			expect(app.session.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			// Pi's own auto-retry resends the refused request first; settlement then drops the image.
			const sent = stub.requests.map((request) => hasImage(request.body));
			expect(sent.at(-1)).toBe(false);
			expect(sent.slice(0, -1).every(Boolean)).toBe(true);
			expect(JSON.stringify(stub.requests.at(-1)!.body.messages)).toContain("refused image input");
			// The next prompt goes out without the image too: the edit is durable.
			const before = stub.requests.length;
			await app.session.prompt("and now?");
			expect(stub.requests).toHaveLength(before + 1);
			expect(hasImage(stub.requests.at(-1)!.body)).toBe(false);
		} finally {
			app.session.dispose();
			await stub.close();
		}
	});
});
