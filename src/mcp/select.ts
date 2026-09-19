/**
 * MCP disclosure: rank → verify → load (PRD-006 Phases 3 and 4, ROADMAP §15/§17).
 *
 * The compact catalog — one line per tool, never a schema — goes to JEV: is any
 * external capability needed, which servers are relevant, which tools within
 * them. Only confirmed tools' full schemas are hydrated out of the cache and
 * into `ExecutionContract.capabilities.mcps`, capped by `mcp.maxTools`. A
 * server nobody selected contributes zero bytes and is never connected.
 *
 * With JEV off (§49) the same pipeline degrades to manually pinned plus
 * project-default servers — never the full catalog. `requestCapability()` is the
 * §17 mid-task router and the only way a schema enters context after compile;
 * it admits at most one tool and returns a typed refusal otherwise.
 */
import type { CapabilityProvider, ExecutionContract } from "../compiler/contract.js";
import { registerCapabilityProvider } from "../compiler/index.js";
import type { LeanPiConfig } from "../core/types.js";
import type { JevClient } from "../jev/client.js";
import { accept } from "../jev/confidence.js";
import { ensureSite } from "../jev/registry.js";
import type { JevQuestion, JevResult } from "../jev/types.js";
import type { TaskPacket } from "../scout/index.js";
import { buildCatalog, readSchemaCache, type CachedTool, type McpCatalog, type McpToolRecord } from "./catalog.js";

export const MCP_SITE_ID = "mcp.disclosure";
export const MCP_REQUEST_PHASE = "request";

/** A hydrated tool schema — the only MCP bytes that ever reach the executor. */
export interface SelectedMcpTool {
	server: string;
	transport: McpToolRecord["transport"];
	tool: string;
	description: string;
	inputSchema: unknown;
	/** Ranking score at admission; the eviction order of a full live set. */
	score: number;
}

export type JevSelector = Pick<JevClient, "ask" | "fallbackCount"> & Partial<Pick<JevClient, "getMode">>;

export interface McpDisclosureDecision {
	/** `server/tool` ids of the hydrated tools, in admission order. */
	selected: string[];
	/** Server names that cleared relevance, which is not the same as admitted. */
	servers: string[];
	fallbackUsed: boolean;
	reason: string;
}

export interface McpSelectionResult {
	tools: SelectedMcpTool[];
	decision: McpDisclosureDecision;
}

export interface McpSelectionInput {
	catalog: McpCatalog;
	request: string;
	config: LeanPiConfig;
	/** Project root; the schema cache lives under it. */
	cwd: string;
	client?: JevSelector;
	maxTools?: number;
	/** Test seam for the schema reader. */
	readCache?: (cwd: string) => Record<string, CachedTool[]>;
}

export function mcpToolId(server: string, tool: string): string {
	return `${server}/${tool}`;
}

/**
 * Registered once per process. The fallback answers "no external capability",
 * which is the safe direction and the row `/mcp` reports as `fallback_used`.
 */
export function registerMcpSite(): void {
	ensureSite({
		id: MCP_SITE_ID,
		// A template: the real batch carries one relevance question per server and
		// one confirmation per tool of the servers that cleared relevance.
		questions: [
			{ id: "any_mcp", kind: "Choice", text: "Does this task require any external MCP capability?", options: { yes: "yes", no: "no" } },
			{ id: "relevance", kind: "Score", text: "How relevant is this MCP server to the task?", levels: ["irrelevant", "tangential", "relevant", "essential"] },
			{ id: "tool", kind: "Choice", text: "Is this MCP tool needed for this task?", options: { yes: "yes", no: "no" } },
		],
		returnType: ["Choice", "Score", "Choice"],
		consequence: "normal",
		telemetryTag: MCP_SITE_ID,
		fallback: ({ questions }): JevResult[] =>
			questions.map((question): JevResult => {
				if (question.kind === "Choice") {
					const options = Object.keys(question.options);
					return { kind: "Choice", questionId: question.id, choice: options.find((option) => option === "none" || option === "no") ?? options[0] ?? "no", probabilities: {}, confidence: 0 };
				}
				if (question.kind === "Score") return { kind: "Score", questionId: question.id, score: 0, legend: {}, confidence: 0 };
				return { kind: "Noul", questionId: question.id, value: 0, confidence: 0 };
			}),
	});
}

const STOP_WORDS = new Set(["the", "a", "an", "to", "of", "and", "for", "with", "in", "on", "is", "it", "this", "that", "use", "using"]);

function tokens(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

/** Token overlap against tool name/summary — the §49 deterministic fallback path. */
export function lexicalSelect(records: McpToolRecord[], query: string, limit: number): Array<{ record: McpToolRecord; score: number }> {
	const wanted = new Set(tokens(query));
	const scored = records.map((record) => {
		const haystack = new Set(tokens(`${record.tool} ${record.summary}`));
		let overlap = 0;
		for (const token of haystack) if (wanted.has(token)) overlap += 1;
		const nameHit = tokens(query).some((token) => record.tool.toLowerCase().includes(token)) ? 2 : 0;
		return { record, score: overlap + nameHit };
	});
	return scored
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || mcpToolId(left.record.server, left.record.tool).localeCompare(mcpToolId(right.record.server, right.record.tool)))
		.slice(0, limit);
}

/** Hydrate only the confirmed tools' schemas; a tool with no cache entry is not admitted. */
function hydrate(cache: Record<string, CachedTool[]>, records: McpToolRecord[], scoreOf: (record: McpToolRecord) => number): SelectedMcpTool[] {
	const tools: SelectedMcpTool[] = [];
	for (const record of records) {
		const cached = cache[record.server]?.find((tool) => tool.name === record.tool);
		if (!cached) continue;
		tools.push({
			server: record.server,
			transport: record.transport,
			tool: record.tool,
			description: cached.description || record.summary,
			inputSchema: cached.inputSchema,
			score: scoreOf(record),
		});
	}
	return tools;
}

/** Manually pinned plus project-default servers; the JEV-off eligibility set (§49). */
export function fallbackServers(catalog: McpCatalog): string[] {
	return [...new Set([...catalog.pinnedServers, ...catalog.projectDefaults])];
}

const SCORE_LEVELS = ["irrelevant", "tangential", "relevant", "essential"];

function relevanceQuestions(records: McpToolRecord[]): JevQuestion[] {
	const servers = [...new Set(records.map((record) => record.server))];
	return [
		{ id: "any_mcp", kind: "Choice", text: "Does this task require any external MCP capability?", options: { yes: "yes", no: "no" } },
		...servers.map(
			(server): JevQuestion => ({
				id: `relevance:${server}`,
				kind: "Score",
				text: `How relevant is this MCP server to the task? ${server}: ${[
					...new Set(records.filter((record) => record.server === server).map((record) => record.tool)),
				]
					.slice(0, 8)
					.join(", ")}`.slice(0, 400),
				levels: SCORE_LEVELS,
			}),
		),
	];
}

function toolQuestions(records: McpToolRecord[]): JevQuestion[] {
	return records.map(
		(record): JevQuestion => ({
			id: `tool:${mcpToolId(record.server, record.tool)}`,
			kind: "Choice",
			text: `Is this MCP tool needed for this task? ${record.server}/${record.tool}: ${record.summary}`.slice(0, 400),
			options: { yes: "yes", no: "no" },
		}),
	);
}

/** The §49 branch: pinned/project-default servers' tools, never the whole catalog. */
function deterministicSelection(input: McpSelectionInput, cache: Record<string, CachedTool[]>, maxTools: number, reason: string): McpSelectionResult {
	const allowed = new Set(fallbackServers(input.catalog));
	const records = input.catalog.tools.filter((record) => allowed.has(record.server));
	const tools = hydrate(cache, records.slice(0, maxTools), () => 1);
	return {
		tools,
		decision: { selected: tools.map((tool) => mcpToolId(tool.server, tool.tool)), servers: [...allowed], fallbackUsed: true, reason },
	};
}

export async function selectMcpTools(input: McpSelectionInput): Promise<McpSelectionResult> {
	registerMcpSite();
	const maxTools = input.maxTools ?? input.catalog.maxTools;
	const readCache = input.readCache ?? readSchemaCache;
	const cache = readCache(input.cwd);
	const decision: McpDisclosureDecision = { selected: [], servers: [], fallbackUsed: false, reason: "" };
	const finish = (tools: SelectedMcpTool[], reason: string): McpSelectionResult => {
		decision.selected = tools.map((tool) => `${tool.server}/${tool.tool}`);
		decision.reason = reason;
		return { tools, decision };
	};

	if (input.catalog.tools.length === 0) return finish([], "the catalog has no rows");

	const client = input.client;
	if (!client) return deterministicSelection(input, cache, maxTools, "no JEV client");

	const before = client.fallbackCount();
	let results: JevResult[] | undefined;
	try {
		results = await client.ask(MCP_SITE_ID, relevanceQuestions(input.catalog.tools), {
			request: input.request,
			phase: "disclosure",
			catalog: input.catalog.tools.map((record) => `${mcpToolId(record.server, record.tool)}: ${record.summary.slice(0, 120)}`),
		});
	} catch {
		results = undefined;
	}
	if (results === undefined || client.fallbackCount() > before) {
		return deterministicSelection(input, cache, maxTools, client.getMode?.() === "disabled" ? "JEV disabled" : "JEV unavailable");
	}

	const anyMcp = results.find((result) => result.questionId === "any_mcp");
	if (anyMcp?.kind !== "Choice" || anyMcp.choice !== "yes" || !accept(anyMcp, "normal")) {
		return finish([], "JEV answered: no external MCP capability required");
	}

	const scores = new Map<string, number>();
	for (const result of results) {
		if (result.kind !== "Score" || !result.questionId.startsWith("relevance:")) continue;
		if (accept(result, "normal") && result.score >= 1) scores.set(result.questionId.slice("relevance:".length), result.score);
	}
	decision.servers = [...scores.keys()].sort((left, right) => (scores.get(right) ?? 0) - (scores.get(left) ?? 0) || left.localeCompare(right));
	if (decision.servers.length === 0) return finish([], "JEV scored every server irrelevant");

	// Q3: confirm the individual tools of the servers that cleared relevance.
	const candidates = input.catalog.tools.filter((record) => scores.has(record.server));
	const beforeTools = client.fallbackCount();
	let confirmation: JevResult[] | undefined;
	try {
		confirmation = await client.ask(MCP_SITE_ID, toolQuestions(candidates), { request: input.request, phase: "disclosure", servers: decision.servers });
	} catch {
		confirmation = undefined;
	}
	if (confirmation === undefined || client.fallbackCount() > beforeTools) {
		return deterministicSelection(input, cache, maxTools, "tool confirmation fell back");
	}
	const confirmed = candidates.filter((record) => {
		const answer = confirmation!.find((result) => result.questionId === `tool:${mcpToolId(record.server, record.tool)}`);
		return answer?.kind === "Choice" && answer.choice === "yes" && accept(answer, "normal");
	});
	if (confirmed.length === 0) return finish([], "JEV rejected every candidate tool");

	const ordered = confirmed
		.sort((left, right) => (scores.get(right.server) ?? 0) - (scores.get(left.server) ?? 0) || mcpToolId(left.server, left.tool).localeCompare(mcpToolId(right.server, right.tool)))
		.slice(0, maxTools);
	const tools = hydrate(cache, ordered, (record) => scores.get(record.server) ?? 0);
	return finish(tools, "JEV confirmed");
}

// ---------------------------------------------------------------------------
// The §17 mid-task capability router (Phase 4)
// ---------------------------------------------------------------------------

export interface CapabilityRefusal {
	code: "no_match" | "not_available";
	message: string;
}

export interface CapabilityRequestInput {
	query: string;
	catalog: McpCatalog;
	config: LeanPiConfig;
	cwd: string;
	/** The live tool set; the returned set is this one plus at most one admission. */
	live: SelectedMcpTool[];
	client?: JevSelector;
	maxTools?: number;
	readCache?: (cwd: string) => Record<string, CachedTool[]>;
}

export interface CapabilityAdmission {
	/** True when the request was answered — an admission or an already-present tool. */
	ok: boolean;
	admitted: SelectedMcpTool | null;
	evicted: SelectedMcpTool | null;
	/** The live tool set after the request. */
	tools: SelectedMcpTool[];
	refusal: CapabilityRefusal | null;
	fallbackUsed: boolean;
}

/** The one Choice the request phase asks: an entry, or the explicit *none*. */
export function capabilityQuestion(catalog: McpCatalog): JevQuestion {
	const options: Record<string, string | null> = { none: "no catalog entry satisfies this request" };
	for (const record of catalog.tools) options[`tool:${mcpToolId(record.server, record.tool)}`] = `${record.tool}: ${record.summary}`.slice(0, 200);
	return { id: "capability", kind: "Choice", text: "Which catalog entry, if any, satisfies this capability request?", options };
}

function refuse(code: CapabilityRefusal["code"], message: string, live: SelectedMcpTool[], fallbackUsed: boolean): CapabilityAdmission {
	return { ok: false, admitted: null, evicted: null, tools: live, refusal: { code, message }, fallbackUsed };
}

function admit(tool: SelectedMcpTool, live: SelectedMcpTool[], maxTools: number): CapabilityAdmission {
	if (live.some((entry) => entry.server === tool.server && entry.tool === tool.tool)) {
		return { ok: true, admitted: tool, evicted: null, tools: live, refusal: null, fallbackUsed: false };
	}
	if (live.length < maxTools) return { ok: true, admitted: tool, evicted: null, tools: [...live, tool], refusal: null, fallbackUsed: false };
	// Full: the lowest-scored admitted tool makes room, ties going to the earliest.
	let worst = 0;
	live.forEach((entry, index) => {
		if (entry.score < live[worst]!.score) worst = index;
	});
	const evicted = live[worst]!;
	const tools = live.filter((_, index) => index !== worst);
	return { ok: true, admitted: tool, evicted, tools: [...tools, tool], refusal: null, fallbackUsed: false };
}

export async function requestCapability(input: CapabilityRequestInput): Promise<CapabilityAdmission> {
	registerMcpSite();
	const maxTools = input.maxTools ?? input.catalog.maxTools;
	const catalog = input.catalog;
	if (catalog.tools.length === 0) return refuse("not_available", "no MCP catalog entries are available", input.live, false);
	const readCache = input.readCache ?? readSchemaCache;
	const cache = readCache(input.cwd);
	const byId = new Map(catalog.tools.map((record) => [mcpToolId(record.server, record.tool), record]));
	const client = input.client;

	if (client) {
		const before = client.fallbackCount();
		let results: JevResult[] | undefined;
		try {
			results = await client.ask(MCP_SITE_ID, [capabilityQuestion(catalog)], { request: input.query, phase: MCP_REQUEST_PHASE });
		} catch {
			results = undefined;
		}
		if (results !== undefined && client.fallbackCount() === before) {
			const answer = results.find((result) => result.questionId === "capability");
			if (answer?.kind !== "Choice") return refuse("no_match", "JEV returned no usable answer for this capability request", input.live, false);
			const record = answer.choice.startsWith("tool:") ? byId.get(answer.choice.slice("tool:".length)) : undefined;
			if (!record) return refuse("no_match", `no catalog entry satisfies "${input.query}"`, input.live, false);
			const [hydrated] = hydrate(cache, [record], () => 1);
			if (!hydrated) return refuse("not_available", `${mcpToolId(record.server, record.tool)} has no cached schema; run /mcp refresh ${record.server}`, input.live, false);
			return { ...admit(hydrated, input.live, maxTools), fallbackUsed: false };
		}
	}

	// §49 deterministic path: lexical match within pinned/project-default servers.
	const allowed = new Set(fallbackServers(catalog));
	const scoped = catalog.tools.filter((record) => allowed.has(record.server));
	const [best] = lexicalSelect(scoped, input.query, 1);
	if (!best) return refuse("no_match", `no pinned or project-default MCP tool matches "${input.query}"`, input.live, true);
	const [hydrated] = hydrate(cache, [best.record], () => best.score);
	if (!hydrated) return refuse("not_available", `${mcpToolId(best.record.server, best.record.tool)} has no cached schema; run /mcp refresh ${best.record.server}`, input.live, true);
	return { ...admit(hydrated, input.live, maxTools), fallbackUsed: true };
}

// ---------------------------------------------------------------------------
// The PRD-004 registration point
// ---------------------------------------------------------------------------

export interface McpDisclosureDeps {
	cwd: string;
	config: LeanPiConfig;
	/** `$HOME` for the user-scope config file; defaults to `os.homedir()`. */
	home?: string;
	client?: JevSelector;
	/** Rebuilt per compile so a mid-session `/mcp disable` is honoured at once. */
	catalog?: () => McpCatalog;
	maxTools?: number;
}

/** The `CapabilityProvider` that fills `ExecutionContract.capabilities.mcps`. */
export function mcpCapabilityProvider(deps: McpDisclosureDeps): CapabilityProvider {
	const catalog = deps.catalog ?? (() => buildCatalog({ cwd: deps.cwd, config: deps.config, ...(deps.home === undefined ? {} : { home: deps.home }) }));
	return {
		kind: "mcps",
		supply: async (draft: ExecutionContract, _packet: TaskPacket): Promise<SelectedMcpTool[]> => {
			const selection = await selectMcpTools({
				catalog: catalog(),
				request: draft.task.user_request,
				config: deps.config,
				cwd: deps.cwd,
				...(deps.client ? { client: deps.client } : {}),
				...(deps.maxTools === undefined ? {} : { maxTools: deps.maxTools }),
			});
			return selection.tools;
		},
	};
}

/** Called by `activate()`; PRD-004's compiler owns the registration list. */
export function registerMcpDisclosure(deps: McpDisclosureDeps): CapabilityProvider {
	const provider = mcpCapabilityProvider(deps);
	registerCapabilityProvider(provider);
	return provider;
}
