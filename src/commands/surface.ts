/**
 * The session surface PRD-016's commands read (Phase 1–4).
 *
 * Two ideas, both borrowed rather than invented:
 *
 * - **`SessionHost`** is Pi's own session API, wrapped. `/new`, `/resume`,
 *   `/tree`, `/tree fork` and `/compact` call `SessionManager`/`AgentSession`
 *   through it, so LeanPi keeps no session records of its own — no second id
 *   space, no mirrored history, nothing to keep in sync (FR-150). The host only
 *   answers "which Pi session is current", which in the interactive flow is a
 *   Pi action and in tests is a pointer.
 * - **`CommandSurface`** is the mutable session state the handlers share: the
 *   session-scoped role bindings `/model` writes, the last compiled contract
 *   `/route` renders, and the backend probe cache `/doctor` fills and `/model`
 *   reads. Nothing here recomputes a value another module already owns.
 */
import { connect } from "node:net";
import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { BackendRegistry, type RegisteredBackend } from "../backends/index.js";
import { probeVendor } from "../backends/subscriptions.js";
import type { HarnessVendor } from "../backends/harness.js";
import { resolveRole } from "../core/roles.js";
import type { BackendRef, LeanPiConfig, ModelRole } from "../core/types.js";
import type { ExecutionContract } from "../compiler/contract.js";
import type { JevClient } from "../jev/client.js";
import type { CostConfig } from "../telemetry/index.js";

/** What the dispatcher must supply for session commands: Pi's own API, wrapped. */
export interface SessionHost {
	/** Pi's session manager for the session that is current right now. */
	current(): SessionManager;
	/** Pi's live agent session, when one is bound to `current()`. */
	agent(): AgentSession | undefined;
	/** Make `manager` the current session and, when `name` is given, name it in Pi's store. */
	adopt(manager: SessionManager, name?: string): void | Promise<void>;
	/** Pi's session directory, for listing and name resolution. */
	sessionDir(): string;
}

export interface SessionHostOptions {
	cwd: string;
	manager: SessionManager;
	sessionDir?: string;
	agent?: AgentSession;
}

/** The default host: a pointer to the current Pi session, nothing more. */
export function createSessionHost(options: SessionHostOptions): SessionHost {
	let manager = options.manager;
	let agent = options.agent;
	return {
		current: () => manager,
		agent: () => agent,
		adopt(next, name) {
			manager = next;
			agent = undefined;
			if (name !== undefined && name.length > 0) next.appendSessionInfo(name);
		},
		sessionDir: () => options.sessionDir ?? manager.getSessionDir(),
	};
}

/** The session's role bindings, the contract in flight and the backend probe cache. */
export interface CommandSurface {
	readonly cwd: string;
	readonly config: LeanPiConfig;
	readonly host: SessionHost;
	readonly jev: Pick<JevClient, "getMode" | "fallbackCount" | "status" | "ask" | "test"> | undefined;
	readonly backends: BackendRegistry;
	readonly cost: CostConfig | undefined;
	readonly env: NodeJS.ProcessEnv;
	/** Role bindings `/model` overrode this session; absent means config wins. */
	readonly bindings: Map<ModelRole, BackendRef>;
	/** Backend probes, keyed by backend name; `/doctor` fills it, `/model` reads it. */
	readonly probes: Map<string, ProbeResult>;
	/** The contract of the current or next task, when a compile has happened. */
	contract: ExecutionContract | undefined;
	recordContract(contract: ExecutionContract): void;
	bindingFor(role: ModelRole): RoleBinding;
	/** Forget the session's own state: a new or resumed session starts unpinned. */
	resetSessionState(): void;
}

export interface RoleBinding {
	ref: BackendRef | null;
	source: "config" | "session" | "unresolved";
}

export interface CommandSurfaceDeps {
	cwd: string;
	config: LeanPiConfig;
	host: SessionHost;
	jev?: Pick<JevClient, "getMode" | "fallbackCount" | "status" | "ask" | "test">;
	backends?: BackendRegistry;
	cost?: CostConfig;
	env?: NodeJS.ProcessEnv;
	/** PRD-036's recap controller; read lazily, because it is created after this surface. */
	recap?: () => import("../recap/index.js").RecapController | undefined;
}

export function createCommandSurface(deps: CommandSurfaceDeps): CommandSurface {
	const bindings = new Map<ModelRole, BackendRef>();
	const surface: CommandSurface = {
		cwd: deps.cwd,
		config: deps.config,
		host: deps.host,
		jev: deps.jev,
		backends: deps.backends ?? new BackendRegistry(deps.config),
		cost: deps.cost,
		env: deps.env ?? process.env,
		bindings,
		probes: new Map<string, ProbeResult>(),
		contract: undefined,
		recordContract: (contract) => {
			surface.contract = contract;
		},
		bindingFor(role) {
			const override = bindings.get(role);
			if (override) return { ref: override, source: "session" };
			try {
				return { ref: resolveRole(deps.config, role), source: "config" };
			} catch {
				return { ref: null, source: "unresolved" };
			}
		},
		resetSessionState() {
			bindings.clear();
			surface.contract = undefined;
		},
	};
	return surface;
}

/** One probe verdict; `/doctor` rows and `/model` availability both read it. */
export interface ProbeResult {
	status: "ok" | "degraded" | "unavailable";
	reason: string;
}

const DEFAULT_PROBE_TIMEOUT_MS = 1500;

/** `undefined` when the command is not an executable file on `PATH`. */
export function whichCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (command.length === 0) return undefined;
	if (command.includes("/")) return existsSync(command) ? command : undefined;
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir.length === 0) continue;
		const candidate = join(dir, command);
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			continue;
		}
	}
	return undefined;
}

function parseEndpoint(baseUrl: string | null): { host: string; port: number } | null {
	if (!baseUrl) return null;
	try {
		const url = new URL(baseUrl);
		return { host: url.hostname, port: url.port.length > 0 ? Number(url.port) : url.protocol === "https:" ? 443 : 80 };
	} catch {
		return null;
	}
}

/** A TCP connect, never a request: a probe spends no tokens and needs no credential. */
function connectProbe(host: string, port: number, timeoutMs: number): Promise<ProbeResult> {
	// `Promise.withResolvers` is ES2024; this project's lib target is ES2022.
	return new Promise((resolve) => {
		const socket = connect({ host, port });
		const finish = (result: ProbeResult) => {
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(timeoutMs);
		socket.once("connect", () => finish({ status: "ok", reason: `reachable at ${host}:${port}` }));
		socket.once("timeout", () => finish({ status: "unavailable", reason: `connect ${host}:${port} timed out after ${timeoutMs}ms` }));
		socket.once("error", (error: Error) => finish({ status: "unavailable", reason: `connect ${host}:${port} failed: ${error.message}` }));
	});
}

/**
 * What a signed-out vendor tells the user to run. `claude` takes a slash
 * command as its prompt argument; the other two have a plain subcommand.
 */
const LOGIN_ARGS: Record<HarnessVendor, string> = {
	claude: "/login",
	codex: "login",
	opencode: "auth login",
};

/**
 * One backend, one verdict and a one-line reason. A missing executable is
 * `unavailable`; a reachable endpoint is `ok`; anything in between is
 * `degraded`. No probe mutates state, installs anything, or prints a credential.
 */
export async function probeBackend(
	backend: RegisteredBackend,
	options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; cooling?: string | null; verify?: boolean } = {},
): Promise<ProbeResult> {
	if (!backend.enabled) return { status: "unavailable", reason: "disabled in config" };
	if (options.cooling) return { status: "degraded", reason: `cooling down: ${options.cooling}` };

	if (backend.type === "external_harness") {
		const found = whichCommand(backend.command, options.env);
		if (!found) return { status: "unavailable", reason: `command "${backend.command}" is not on PATH` };
		if (!options.verify || !backend.vendor) return { status: "ok", reason: `command found at ${found}; authentication not probed` };
		// Installed is not usable: a vendor whose login expired answers every
		// invocation with "Not logged in", and reporting that as `ok` sends the
		// turn at a backend that cannot run it. The vendor's own status command
		// costs no tokens, so the diagnostic asks instead of assuming. It spawns,
		// which is why only `/doctor` opts in.
		const state = probeVendor(backend.vendor, { command: backend.command, ...(options.env ? { env: options.env } : {}), verify: true });
		return state.signedIn
			? { status: "ok", reason: `command found at ${found}; ${state.evidence}` }
			: { status: "degraded", reason: `${state.evidence} — run \`${backend.command} ${LOGIN_ARGS[backend.vendor]}\`` };
	}

	const endpoint = parseEndpoint(backend.baseUrl);
	if (!endpoint) return { status: "degraded", reason: "no baseUrl configured" };
	return connectProbe(endpoint.host, endpoint.port, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
}

/** Probe every backend concurrently: a dead harness must not hang the command. */
export async function probeBackends(surface: CommandSurface, options: { verify?: boolean } = {}): Promise<Map<string, ProbeResult>> {
	await Promise.all(
		surface.backends.backends.map(async (backend) => {
			const result = await probeBackend(backend, {
				env: surface.env,
				cooling: surface.backends.cooldownOf(backend.name)?.reason ?? null,
				...(options.verify ? { verify: true } : {}),
			});
			surface.probes.set(backend.name, result);
		}),
	);
	return surface.probes;
}

/** Token accounting: the same bytes/4 estimate PRD-005's disclosure uses, named once. */
export function estimateTextTokens(text: string): number {
	return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/** Exact money rendering, shared with `/cost`'s `$0.000000` shape. */
export function money(usd: number): string {
	return `$${usd.toFixed(6)}`;
}
