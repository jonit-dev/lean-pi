/**
 * The target agent's runner, read through pi-subagents' own discovery.
 *
 * An `external-cli` or `external-job` agent is a command, not a Pi child: it has
 * no registry to route a model into, and upstream refuses the call outright when
 * one is written (`uses runner.type='external-cli' and does not support: model
 * override`) — so routing one there failed every spawn of `claude-code`, whether
 * or not the caller had named a model. Anything else is native Pi, which is the
 * same test upstream applies, so no name list is maintained here.
 *
 * pi-subagents does not export discovery from its package map, so it is imported
 * by path, resolved through the installed package: npm's hoisted layout and
 * pnpm's symlink both work the way Node resolves a bare specifier.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

interface DiscoveredAgent {
	name: string;
	runner?: { type?: string };
}

interface AgentDiscovery {
	discoverAgents(cwd: string, scope: string): { agents: DiscoveredAgent[] };
	resolveAgentName(name: string, agents: DiscoveredAgent[]): { agent?: DiscoveredAgent };
}

/**
 * `native` is a Pi child and can carry a routed model, `external` is a command and
 * refuses one, and `unknown` is a lookup that could not answer. Only a proven
 * native child is routed: an unreadable profile is not proof, so it leaves
 * `input.model` untouched — the pre-052 path, never a crash (PRD-052 Phase 1).
 */
export type AgentRunner = "native" | "external" | "unknown";

type DiscoveryLoader = () => Promise<AgentDiscovery | undefined>;

let loader: DiscoveryLoader = loadPiSubagentsAgents;
let discovery: Promise<AgentDiscovery | undefined> | undefined;

function loadPiSubagentsAgents(): Promise<AgentDiscovery | undefined> {
	discovery ??= import(pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("pi-subagents")), "src/agents/agents.js")).href)
		.then((module) => module as AgentDiscovery)
		.catch((error: unknown) => {
			// A failed import is not an answer: drop it so the next call retries.
			discovery = undefined;
			process.stderr.write(`leanpi: subagent discovery unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
			return undefined;
		});
	return discovery;
}

/** cwd + name → this agent's runner. Cached per session, cleared on a switch. */
const runnerByAgent = new Map<string, AgentRunner>();

/** Upstream's own rule: a runner that is not one of the external ones is native Pi. */
const EXTERNAL_RUNNERS = new Set(["external-cli", "external-job"]);

/**
 * A native built-in carries no `runner` field at all, and a call that names no agent
 * resolves no profile either, so both answer `native` — the same answer upstream
 * reaches by refusing a model override on its external runners only.
 */
export async function agentRunner(cwd: string, name: string): Promise<AgentRunner> {
	const key = `${cwd}\u0000${name}`;
	const cached = runnerByAgent.get(key);
	if (cached !== undefined) return cached;
	let runner: AgentRunner;
	try {
		const api = await loader();
		if (api === undefined) runner = "unknown";
		else {
			const type = api.resolveAgentName(name, api.discoverAgents(cwd, "both").agents).agent?.runner?.type;
			runner = type !== undefined && EXTERNAL_RUNNERS.has(type) ? "external" : "native";
		}
	} catch (error) {
		process.stderr.write(`leanpi: subagent runner lookup failed: ${error instanceof Error ? error.message : String(error)}\n`);
		runner = "unknown";
	}
	// Only a real answer is worth keeping; an uncertain one is re-read, never remembered.
	if (runner !== "unknown") runnerByAgent.set(key, runner);
	return runner;
}

/** A session switch re-reads the agent profiles; a `/new` must not inherit the last one's. */
export function resetAgentRunners(): void {
	runnerByAgent.clear();
}

/** Read the agent profiles from somewhere else: the specs drive a controlled lookup through it. */
export function setAgentDiscovery(use: DiscoveryLoader | undefined): void {
	loader = use ?? loadPiSubagentsAgents;
	runnerByAgent.clear();
}
