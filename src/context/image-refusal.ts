/**
 * Recover a session whose provider refused image input.
 *
 * OpenCode Go routes one model id to several engines, and only some take images:
 * a screenshot read on one engine is refused later by another with
 * `image input is not available on this engine`. Every image stays in context, so
 * each retry and each later prompt fails the same way and the session is dead
 * until restart (seen twice in one project on 2026-11-04). Pi does not retry a
 * 400. At settlement the images in context become a text note, durably, through
 * context edits, the failed attempt is omitted, and the request runs again.
 */
import type { AgentBeforeSettleEvent, BoundaryResult, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REFUSED = /image input is not available|does not support image|image input is not supported|image_url is not supported/i;

const NOTE = "[image removed: this model endpoint refused image input]";

export function dropRefusedImages(event: AgentBeforeSettleEvent, ctx: Pick<ExtensionContext, "sessionManager">): BoundaryResult | undefined {
	const failed = [...ctx.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
	if (failed?.type !== "message" || failed.message.role !== "assistant") return undefined;
	if (failed.message.stopReason !== "error" || !REFUSED.test(failed.message.errorMessage ?? "")) return undefined;
	const edits = event.context.contextEntries.flatMap((entry) => {
		const [message] = entry.messages;
		if (entry.messages.length !== 1 || !("content" in message) || !Array.isArray(message.content)) return [];
		const content = message.content as Array<{ type: string }>;
		if (!content.some((block) => block.type === "image")) return [];
		return [{ type: "context_edit" as const, targetId: entry.sourceEntry.id, replacement: { content: content.map((block) => (block.type === "image" ? { type: "text", text: NOTE } : block)) as never } }];
	});
	if (edits.length === 0) return undefined;
	return { entries: [...event.entries, ...edits, { type: "context_edit", targetId: failed.id, replacement: null }], continue: true };
}
