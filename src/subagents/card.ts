/**
 * What a subagent card says, captured at the call and read back at render time.
 *
 * The compact row is the only surface that names a child, and it rendered
 * `Subagent Subagent`: the tool name is the label, and the summary falls back to
 * the same humanized name, so the operator saw neither the child nor the model it
 * was routed to. These are the facts that title needs, kept out of the renderer
 * because a card re-renders on every frame and only the call knows them.
 *
 * A call the model left unnamed is a call sign in spawn order — Alpha, Bravo,
 * Charlie — reset with the session. A named call shows its own name, and an
 * external-runner agent shows what it is, since it has no Pi model to name.
 */
import { isThinkingLevel } from "../core/types.js";
import { agentRunner } from "./agents.js";

/** Pi's registry, as the `tool_call` context carries it. */
interface ModelLookup {
	find(provider: string, modelId: string): { name: string } | undefined;
}

/** The call signs, in spawn order. A named agent is never renamed, so a profile
 * called `Alpha` is only ambiguous with the first unnamed child. */
const CALL_SIGNS = [
	"Alpha",
	"Bravo",
	"Charlie",
	"Delta",
	"Echo",
	"Foxtrot",
	"Golf",
	"Hotel",
	"India",
	"Juliett",
	"Kilo",
	"Lima",
	"Mike",
	"November",
	"Oscar",
	"Papa",
	"Quebec",
	"Romeo",
	"Sierra",
	"Tango",
	"Uniform",
	"Victor",
	"Whiskey",
	"X-ray",
	"Yankee",
	"Zulu",
];

/** How many cards keep a title. A card renders many times; a session spawns more children than it shows. */
const REMEMBERED = 64;

const detailByCall = new Map<string, string>();
let unnamedSpawns = 0;

function callSign(): string {
	const index = unnamedSpawns++;
	const sign = CALL_SIGNS[index % CALL_SIGNS.length];
	return index < CALL_SIGNS.length ? sign : `${sign} ${Math.floor(index / CALL_SIGNS.length) + 1}`;
}

function titleCase(value: string): string {
	return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/** `claude-code` → `Claude Code`, the shape the compact UI humanizes a tool name to. */
function humanize(name: string): string {
	return name
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * `provider/id:level` → the registry's display name and the effort. Only a real Pi
 * thinking level is read off the end; anything else after a colon is part of the id.
 */
function routedModel(model: unknown, models: ModelLookup): { name: string; effort?: string } | undefined {
	if (typeof model !== "string" || model.length === 0) return undefined;
	const at = model.lastIndexOf(":");
	const effort = at === -1 ? "" : model.slice(at + 1);
	const ref = at === -1 ? model : model.slice(0, at);
	const slash = ref.indexOf("/");
	if (slash === -1) return undefined;
	const provider = ref.slice(0, slash);
	const id = ref.slice(slash + 1);
	return { name: models.find(provider, id)?.name ?? id, ...(isThinkingLevel(effort) ? { effort } : {}) };
}

/**
 * Record what this child is, before and after routing: the call sign is spent
 * whether or not a model was written, and the model is only known once routing
 * has decided.
 */
export async function recordSubagentCard(
	toolCallId: string,
	input: Record<string, unknown>,
	models: ModelLookup,
	cwd: string,
): Promise<void> {
	const named = typeof input.agent === "string" && input.agent.length > 0 ? input.agent : undefined;
	const name = named ?? callSign();
	const routed = routedModel(input.model, models);
	// An external runner holds no Pi model to show, so the card names the harness
	// (`claude-code` → `Claude Code`) rather than an empty colon. A profile that could
	// not be read shows the call sign: nothing here has decided the model away.
	const external = named !== undefined && (await agentRunner(cwd, named)) === "external";
	detailByCall.set(
		toolCallId,
		external
			? humanize(name)
			: routed === undefined
				? name
				: `${name}: ${routed.name}${routed.effort === undefined ? "" : ` (${titleCase(routed.effort)})`}`,
	);
	if (detailByCall.size > REMEMBERED) detailByCall.delete(detailByCall.keys().next().value as string);
}

/** The card's detail for one call, or `undefined` when the renderer must fall back. */
export function subagentCardDetail(toolCallId: string): string | undefined {
	return detailByCall.get(toolCallId);
}

/** A session switch starts the call signs again. */
export function resetSubagentCard(): void {
	unnamedSpawns = 0;
	detailByCall.clear();
}
