/**
 * Drops `pi-claude-code-ui`'s render cache for a folded reasoning block.
 *
 * The compact UI memoises an assistant message's rendered lines per width and
 * invalidates that cache from its own `updateContent` — its comment states the
 * invariant plainly: "rebuilds children only via `updateContent()`, which clears
 * the cache". `@99percentpeople/pi-thinking-fold` breaks it. Its timer and its
 * Ctrl+T toggle rebuild the children by calling the `updateContent` it captured
 * at load, which sits *under* the compact UI's, so the compact UI never learns
 * the content changed and keeps serving the stale lines for that width.
 *
 * Streaming is unaffected — those updates come from Pi through the whole chain —
 * which is why folding looked right and only Ctrl+T did nothing under
 * `--ui compact` while working under `--ui plain`.
 *
 * ponytail: this costs the cache on messages that carry reasoning, because
 * clearing before the render is the only hook both vendors agree on. Reasoning
 * messages are a small share of a transcript and a folded one is a few lines, so
 * the re-render is cheap. If the fold ever routes its own updates through the
 * prototype's current method, delete this file.
 *
 * TypeScript for the same reason as `spinner.ts`: Pi routes a `.ts` extension
 * through jiti's virtual-module map, and a `.js` one lands on a second copy of
 * the class that nothing renders with.
 */
import { AssistantMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The compact UI's own cache key, from the global registry. */
const MESSAGE_RENDER_CACHE = Symbol.for("pi-claude-style-tools:message-render-cache");

/** Ours, so a second `session_start` does not wrap the wrapper. */
const INSTALLED = Symbol.for("leanpi:fold-cache-invalidation");

function carriesReasoning(component: { lastMessage?: { content?: unknown } }): boolean {
	const content = component.lastMessage?.content;
	return Array.isArray(content) && content.some((block: { type?: unknown }) => block?.type === "thinking");
}

/**
 * Session start, not module load: the wrapper has to sit outside the compact
 * UI's own `render` patch, and that is the first point at which every extension
 * has been loaded.
 */
export function installFoldCacheInvalidation(): boolean {
	const proto = AssistantMessageComponent.prototype as unknown as Record<string | symbol, unknown>;
	if (proto[INSTALLED] === true) return false;
	const inner = proto.render;
	if (typeof inner !== "function") return false;
	proto.render = function patchedRender(this: Record<string | symbol, unknown>, ...args: unknown[]): unknown {
		if (carriesReasoning(this as never)) this[MESSAGE_RENDER_CACHE] = undefined;
		return (inner as (...rest: unknown[]) => unknown).apply(this, args);
	};
	proto[INSTALLED] = true;
	return true;
}

/** The entry Pi attaches. */
export default function registerFoldCacheInvalidation(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		installFoldCacheInvalidation();
	});
}
