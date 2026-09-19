/**
 * The backend pool: configuration, selection, cooldown and the fallback driver
 * (PRD-008 Phases 1 and 4, ROADMAP §25, FR-046/FR-055/FR-057).
 *
 * Selection is deterministic — enabled flag, role binding, priority order,
 * cooldown state. There is no second kill switch: `enabled: false` removes a
 * backend from selection entirely.
 */
import type { Api } from "@mariozechner/pi-ai";
import { ConfigError } from "../core/config.js";
import { BACKEND_TYPES, isModelRole, type BackendConfig, type BackendType, type LeanPiConfig, type ModelRole } from "../core/types.js";
import { HARNESS_DESCRIPTORS, isHarnessVendor, runHarness, type HarnessSpawn, type HarnessVendor } from "./harness.js";
import { runNative } from "./native.js";
import {
	isWorkerFailure,
	modelFor,
	type BackendInvocation,
	type Billing,
	type WorkerAttempt,
	type WorkerFailureKind,
	type WorkerOutcome,
	type WorkerResult,
	type WorkerTaskPacket,
	type WorkerTurnOutcome,
} from "./worker.js";

/** One backend, parsed and validated out of the `backends:` block. */
export interface RegisteredBackend {
	name: string;
	type: BackendType;
	/** External harness vendor; `null` for native backends. */
	vendor: HarnessVendor | null;
	/** Executable for an external harness; empty for native backends. */
	command: string;
	/** Pi provider binding for a native backend; empty for external harnesses. */
	provider: string;
	/** Model declared on the entry itself, used when the role map names none. */
	model: string | null;
	/** `models:` entries whose `backend` is this one, by role. */
	modelsByRole: Partial<Record<ModelRole, string>>;
	baseUrl: string | null;
	api: Api | null;
	apiKey: string | null;
	enabled: boolean;
	priority: number;
	quotaClass: string | null;
	marginalCost: number | null;
	catalogModelId: string | null;
	/** Explicit role binding; `null` means the entry serves every role. */
	roles: ModelRole[] | null;
	billing: Billing;
	displayName: string;
}

/**
 * The single billing derivation (FR-055). Telemetry and selection both read it,
 * so they cannot disagree: an external harness is a subscription, a native
 * backend with zero marginal cost is local, every other native is metered.
 */
export function billingOf(backend: Pick<RegisteredBackend, "type" | "marginalCost">): Billing {
	if (backend.type === "external_harness") return "subscription";
	return backend.marginalCost === 0 ? "local" : "metered";
}

function stringField(entry: Record<string, unknown>, key: string, path: string): string | null {
	const value = entry[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string" || value.length === 0) {
		throw new ConfigError(`${key} must be a non-empty string`, `${path}.${key}`);
	}
	return value;
}

function numberField(entry: Record<string, unknown>, key: string, path: string): number | null {
	const value = entry[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ConfigError(`${key} must be a number`, `${path}.${key}`);
	}
	return value;
}

function rolesField(entry: Record<string, unknown>, path: string): ModelRole[] | null {
	const value = entry.roles;
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value) || value.length === 0) {
		throw new ConfigError(`roles must be a non-empty list of model roles`, `${path}.roles`);
	}
	return value.map((role) => {
		if (typeof role !== "string" || !isModelRole(role)) {
			throw new ConfigError(`unknown model role ${JSON.stringify(role)}`, `${path}.roles`);
		}
		return role;
	});
}

/**
 * Parse and validate the `backends:` block. `config.loadConfig` (PRD-001) has
 * already rejected an unknown `type`; this rejects the entries that would only
 * fail later at spawn — a harness with no vendor/command, a native backend with
 * nothing to reach.
 */
export function parseBackendPool(config: LeanPiConfig): RegisteredBackend[] {
	const modelsByRole: Record<string, Partial<Record<ModelRole, string>>> = {};
	for (const [role, entry] of Object.entries(config.models)) {
		if (!entry) continue;
		const byRole = modelsByRole[entry.backend] ?? {};
		byRole[role as ModelRole] = entry.model;
		modelsByRole[entry.backend] = byRole;
	}

	const backends: RegisteredBackend[] = [];
	for (const [name, raw] of Object.entries(config.backends)) {
		const path = `backends.${name}`;
		const entry = raw as Record<string, unknown> & BackendConfig;
		if (!(BACKEND_TYPES as readonly unknown[]).includes(entry.type)) {
			throw new ConfigError(`type must be one of ${BACKEND_TYPES.join(" | ")}`, `${path}.type`);
		}
		if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
			throw new ConfigError(`enabled must be a boolean`, `${path}.enabled`);
		}
		const parsed: RegisteredBackend = {
			name,
			type: entry.type,
			vendor: null,
			command: "",
			provider: "",
			model: stringField(entry, "model", path),
			modelsByRole: modelsByRole[name] ?? {},
			baseUrl: typeof entry.baseUrl === "string" && entry.baseUrl.length > 0 ? entry.baseUrl : null,
			api: (entry.api as Api | undefined) ?? null,
			apiKey: typeof entry.apiKey === "string" ? entry.apiKey : null,
			enabled: entry.enabled !== false,
			priority: numberField(entry, "priority", path) ?? 0,
			quotaClass: stringField(entry, "quota_class", path),
			marginalCost: numberField(entry, "marginal_cost", path),
			catalogModelId: stringField(entry, "catalog_model_id", path),
			roles: rolesField(entry, path),
			billing: "metered",
			displayName: typeof entry.name === "string" && entry.name.length > 0 ? entry.name : name,
		};

		if (parsed.type === "external_harness") {
			const declared = stringField(entry, "vendor", path) ?? name;
			if (!isHarnessVendor(declared)) {
				throw new ConfigError(
					`vendor must be one of ${Object.keys(HARNESS_DESCRIPTORS).join(" | ")} (or name the backend after one)`,
					`${path}.vendor`,
				);
			}
			parsed.vendor = declared;
			// PATH lookup is the default; `command` is configuration with no absolute
			// path baked into product code.
			parsed.command = stringField(entry, "command", path) ?? HARNESS_DESCRIPTORS[declared].defaultCommand;
		} else {
			const provider = stringField(entry, "provider", path) ?? (entry.baseUrl ? name : null);
			if (provider === null) {
				throw new ConfigError(
					`native backend requires "provider" (or "baseUrl" for a Pi endpoint)`,
					`${path}.provider`,
				);
			}
			parsed.provider = provider;
		}

		parsed.billing = billingOf(parsed);
		backends.push(parsed);
	}
	return backends;
}

export interface Cooldown {
	until: number;
	reason: string;
}

export interface BackendRegistryOptions {
	onInvocation?: (record: BackendInvocation) => void;
	/** How long a limited backend stays out of selection. */
	cooldownMs?: number;
	now?: () => number;
}

const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * The configured pool plus its live state. `selectBackend(role, exclude)` is the
 * only way a worker gets chosen, and it already honours cooldowns, so a caller
 * never learns about a limit by spending another request on it (FR-058).
 */
export class BackendRegistry {
	readonly backends: RegisteredBackend[];
	readonly onInvocation: ((record: BackendInvocation) => void) | undefined;
	readonly cooldownMs: number;

	private readonly cooldowns = new Map<string, Cooldown>();
	private readonly now: () => number;
	private readonly order: Record<string, number>;

	constructor(config: LeanPiConfig, options: BackendRegistryOptions = {}) {
		this.backends = parseBackendPool(config);
		this.onInvocation = options.onInvocation;
		this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.now = options.now ?? Date.now;
		this.order = Object.fromEntries(this.backends.map((backend, index) => [backend.name, index]));
	}

	byName(name: string): RegisteredBackend | undefined {
		return this.backends.find((backend) => backend.name === name);
	}

	/**
	 * Enabled, non-cooling, non-excluded backends for the role, ordered by
	 * precedence: an entry that names the role in `roles:` (the §27 role map's
	 * explicit binding) outranks a pool-wide entry, then descending `priority`,
	 * then declaration order. Pool-wide entries serve every role, which is what
	 * makes FR-046's fallback a chain rather than a single backend.
	 */
	selectBackend(role: ModelRole, exclude: readonly string[] = []): RegisteredBackend[] {
		const skipped = new Set(exclude);
		return this.backends
			.filter(
				(backend) =>
					backend.enabled &&
					(backend.roles === null || backend.roles.includes(role)) &&
					!skipped.has(backend.name) &&
					!this.isCooling(backend.name),
			)
			.sort(
				(a, b) =>
					Number(b.roles !== null) - Number(a.roles !== null) ||
					b.priority - a.priority ||
					(this.order[a.name] ?? 0) - (this.order[b.name] ?? 0),
			);
	}

	cooldownOf(name: string): Cooldown | null {
		const cooldown = this.cooldowns.get(name);
		if (!cooldown) return null;
		if (cooldown.until <= this.now()) {
			this.cooldowns.delete(name);
			return null;
		}
		return cooldown;
	}

	isCooling(name: string): boolean {
		return this.cooldownOf(name) !== null;
	}

	/** Mark a limited backend unavailable for a cooldown; never a probe retry. */
	markLimited(name: string, reason: string, cooldownMs = this.cooldownMs): Cooldown {
		const cooldown: Cooldown = { until: this.now() + cooldownMs, reason };
		this.cooldowns.set(name, cooldown);
		return cooldown;
	}

	/** Emit one invocation record (success or failure) to the telemetry sink. */
	record(record: BackendInvocation): void {
		this.onInvocation?.(record);
	}
}

function outcomeFacts(outcome: WorkerOutcome): { exitCode: number | null; tokens: number | undefined } {
	if (isWorkerFailure(outcome)) {
		return { exitCode: outcome.exitCode ?? null, tokens: outcome.tokens };
	}
	const raw = outcome.raw as { exitCode?: number | null; tokens?: number } | undefined;
	return {
		exitCode: typeof raw?.exitCode === "number" ? raw.exitCode : 0,
		tokens: typeof raw?.tokens === "number" ? raw.tokens : undefined,
	};
}

/**
 * One verdict per outcome, so success and failure cannot drift apart: a worker
 * that reports blocked, or claims success without moving a byte of the
 * workspace, is a failure the chain falls back from.
 */
function classifyOutcome(outcome: WorkerOutcome): { ok: WorkerResult } | { failure: WorkerFailureKind; reason: string } {
	if (isWorkerFailure(outcome)) return { failure: outcome.failure, reason: outcome.reason };
	if (outcome.status === "blocked") return { failure: "blocked", reason: outcome.summary };
	if (outcome.changedFiles.length === 0) {
		return { failure: "no_change", reason: "backend reported success without changing the workspace" };
	}
	return { ok: outcome };
}

export interface RunWorkerTurnOptions {
	registry: BackendRegistry;
	cwd: string;
	agentDir?: string;
	/** Test seam for the external harness spawn. */
	spawn?: HarnessSpawn;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	now?: () => number;
}

/**
 * Walk the role's backend chain until one produces a real workspace change.
 * Every invocation emits exactly one record; every failure is reported, and an
 * exhausted chain returns `blocked` carrying all of them — never a fabricated
 * success (FR-046, AC-8).
 */
export async function runWorkerTurn(packet: WorkerTaskPacket, options: RunWorkerTurnOptions): Promise<WorkerTurnOutcome> {
	const { registry, cwd } = options;
	const now = options.now ?? Date.now;
	const exclude: string[] = [];
	const attempts: WorkerAttempt[] = [];
	let sessionId = packet.sessionId;

	for (;;) {
		const [backend] = registry.selectBackend(packet.role, exclude);
		if (!backend) return { status: "blocked", attempts };

		const resolvedModel = packet.model ?? modelFor(backend, packet.role);
		const attemptPacket: WorkerTaskPacket = {
			...packet,
			...(sessionId ? { sessionId } : {}),
			...(resolvedModel ? { model: resolvedModel } : {}),
		};
		const started = now();
		const outcome =
			backend.type === "external_harness"
				? await runHarness(backend, attemptPacket, {
						cwd,
						...(options.spawn ? { spawn: options.spawn } : {}),
						...(options.env ? { env: options.env } : {}),
						...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
					})
				: await runNative(backend, attemptPacket, { cwd, ...(options.agentDir ? { agentDir: options.agentDir } : {}) });
		const facts = outcomeFacts(outcome);
		registry.record({
			backend: backend.name,
			billing: backend.billing,
			...(backend.quotaClass ? { quotaClass: backend.quotaClass } : {}),
			...(backend.catalogModelId ? { catalogModelId: backend.catalogModelId } : {}),
			role: packet.role,
			wallMs: now() - started,
			exitCode: facts.exitCode,
			...(facts.tokens !== undefined ? { tokens: facts.tokens } : {}),
		});

		const verdict = classifyOutcome(outcome);
		if ("ok" in verdict) {
			return { status: "completed", backend: backend.name, result: verdict.ok, attempts };
		}
		if (isWorkerFailure(outcome) && outcome.sessionId && !sessionId) sessionId = outcome.sessionId;
		if (verdict.failure === "limit") registry.markLimited(backend.name, verdict.reason);
		attempts.push({ backend: backend.name, failure: verdict.failure, reason: verdict.reason });
		exclude.push(backend.name);
	}
}
