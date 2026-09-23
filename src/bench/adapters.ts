/**
 * The three attempt adapters (PRD-021 Phases 1–2).
 *
 * Every adapter has the same shape — `runAttempt(attempt) -> attemptResult` —
 * and every adapter's *numbers* come from a §52 record in PRD-015's store: the
 * runner reads that record back and the ledger's `reported_success` is the
 * record's `result.success`, never the adapter's word.
 *
 * - `leanpi`: one real LeanPi turn in the task's workspace, with the record
 *   written by PRD-015's `emitRunTelemetry`. The §8 ladder's verdict
 *   (PRD-007/009/010) is a seam: with none supplied the attempt runs PRD-009's
 *   verifier set for real and claims nothing (`success: false`) rather than
 *   inventing a pass.
 * - `stock-pi`: Pi's own agent session with **no** LeanPi extension loaded, a
 *   local model registered through Pi's own `models.json` custom-provider path
 *   and no subscription. The row's loaded-extension list is read back from Pi's
 *   resource loader, which is what makes "no LeanPi" auditable.
 * - `external`: PRD-008's Claude Code / Codex workers, driven through
 *   `runHarness()` with LeanPi's routing disabled. This PRD owns no CLI
 *   plumbing; it calls the workers that already exist. Those rows consume joao's
 *   own subscription logins, so they are gated behind an explicit environment
 *   flag and refuse to run without it.
 *
 * Nothing here imports `src/index.ts`: the session LeanPi runs through is the
 * lane entry's (`bench/cli.ts`, which may import the package entry) so the bench
 * module itself stays free of the barrel.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	SessionManager,
	type AgentSession,
	type AgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { billingOf, HARNESS_DESCRIPTORS, parseBackendPool, runHarness, type HarnessSpawn, type RegisteredBackend } from "../backends/index.js";
import { runTurn, type TurnContext } from "../commands/session.js";
import { isModelRole, type LeanPiConfig } from "../core/types.js";
import { readDecisions } from "../jev/log.js";
import {
	appendRun,
	callsFromMessages,
	createRunCollector,
	emitRunTelemetry,
	priceRun,
	resolveCostConfig,
	type BackendCall,
	type CostConfig,
	type RunResult,
	type RunTelemetry,
	type RunUsage,
} from "../telemetry/index.js";
import { verifyTask } from "../verify/index.js";
import { BenchError, type AttemptHooks, type BenchAttempt, type BenchAttemptExecutor, type BenchAttemptResult, type BenchConfigRow } from "./types.js";

/** Explicit owner gate for the subscription baselines (AC-4): unset means they refuse to run. */
export const EXTERNAL_BASELINES_FLAG = "LEANPI_BENCH_EXTERNAL_BASELINES";

export function externalBaselinesEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env[EXTERNAL_BASELINES_FLAG] === "1";
}

/** The `bench:` keys this PRD reads structurally, each with its documented default. */
function benchSetting(config: LeanPiConfig, key: string): unknown {
	return (config.bench as unknown as Record<string, unknown> | undefined)?.[key];
}

function timeoutOf(config: LeanPiConfig, key: string, fallback: number): number {
	const declared = benchSetting(config, key);
	return typeof declared === "number" && declared > 0 ? declared : fallback;
}

/**
 * The configuration one row runs under: its executor model becomes the
 * `balanced` role's model and its JEV mode is applied. No new config key is
 * introduced — the row selects among the settings PRD-001 already parses.
 */
export function configForRow(config: LeanPiConfig, row: BenchConfigRow): LeanPiConfig {
	const existing = config.models.balanced;
	return {
		...config,
		models: {
			...config.models,
			...(existing ? { balanced: { backend: existing.backend, model: row.executor_model } } : {}),
		},
		jev: { ...config.jev, mode: row.jev, apiKey: row.jev === "disabled" ? null : config.jev.apiKey },
	};
}

/** A record composer for a row that is not a LeanPi run (there is no contract to emit from). */
function appendedRecord(
	attempt: BenchAttempt,
	config: LeanPiConfig,
	numbers: {
		backend: string;
		model: string;
		calls: number;
		usage: RunUsage;
		wallMs: number;
		toolCalls: number;
		result: RunResult;
	},
): RunTelemetry {
	const cost: CostConfig = { ...resolveCostConfig(config), telemetry_path: attempt.telemetry_path };
	const type = config.backends[numbers.backend]?.type ?? "native";
	const calls: BackendCall[] = numbers.calls > 0
		? [
				{
					backend: numbers.backend,
					model: numbers.model,
					type,
					role: "balanced",
					billing: billingOf({ type, marginalCost: 1 }),
					usage: {
						inputTokens: numbers.usage.input_tokens,
						cachedInputTokens: numbers.usage.cached_input_tokens,
						// Pi's `Usage.output` already includes `reasoning` (pi-ai
						// `Usage.reasoning` is documented as a subset of `output`), while
						// `priceCall` adds `reasoningTokens` on top of `outputTokens`.
						// Hand it the non-reasoning remainder so the single synthetic call
						// is not double-charged.
						outputTokens: Math.max(0, numbers.usage.output_tokens - numbers.usage.reasoning_tokens),
						reasoningTokens: numbers.usage.reasoning_tokens,
					},
				},
			]
		: [];
	const record: RunTelemetry = {
		task_id: attempt.telemetry_task_id,
		session_id: attempt.session_id,
		route: { complexity: "MEDIUM", executor_class: "balanced", reviewer_class: "none", reasoning: "medium" },
		prd_used: null,
		executor_backend: numbers.backend,
		executor_model: numbers.model,
		reviewer_backend: null,
		reviewer_model: null,
		usage: numbers.usage,
		cost: priceRun({ calls, usage: numbers.usage, wallMs: numbers.wallMs }, cost),
		execution: {
			wall_ms: numbers.wallMs,
			tool_calls: numbers.toolCalls,
			file_reads: 0,
			repeated_reads: 0,
			retries: 0,
			escalations: 0,
			compactions: 0,
		},
		result: numbers.result,
		capabilities: { skills_disclosed: [], skills_used: [], mcps_disclosed: [], mcps_used: [] },
		jev_decisions: [],
		calls: [],
	};
	appendRun(attempt.workspace, record, cost);
	return record;
}

// ---------------------------------------------------------------------------
// LeanPi
// ---------------------------------------------------------------------------

/** A booted LeanPi session, as the package entry's `createLeanPiSession()` returns one. */
export interface BenchTurnSession {
	session: AgentSession;
}

export interface LeanPiAttemptOptions {
	config: LeanPiConfig;
	/** Boots the session in the attempt's workspace. `bench/cli.ts` passes the package entry's factory. */
	session: (attempt: BenchAttempt, config: LeanPiConfig) => Promise<BenchTurnSession>;
	/** The §8 ladder's verdicts (PRD-007/009/010). Absent, the attempt claims nothing. */
	verdict?: (context: TurnContext, attempt: BenchAttempt) => Promise<RunResult>;
	/** Per-attempt ceiling for one LeanPi turn; `bench.leanpiTimeoutMs` overrides it. */
	timeoutMs?: number;
}

/**
 * The verdict when the caller supplies none: PRD-009's verifier set runs for
 * real against the sealed workspace and the proof gate is recorded as `not_run`,
 * so the attempt's own claim stays `false`. The bench never converts "the turn
 * returned" into "the task is done".
 */
async function verdictFromVerification(context: TurnContext, attempt: BenchAttempt): Promise<RunResult> {
	if (!context.contract) return { verification: "not_run", proof_gate: "not_run", reviewer: "not_run", success: false };
	const result = await verifyTask(context.contract, attempt.workspace);
	return { verification: result.status, proof_gate: "not_run", reviewer: "not_run", success: false };
}

export function leanPiAttempt(options: LeanPiAttemptOptions): BenchAttemptExecutor {
	return async (attempt: BenchAttempt, hooks?: AttemptHooks): Promise<BenchAttemptResult> => {
		const config = configForRow(options.config, attempt.config);
		const booted = await options.session(attempt, config);
		const collector = createRunCollector({ taskId: attempt.telemetry_task_id, sessionId: attempt.session_id });
		const ceilingMs = options.timeoutMs ?? timeoutOf(options.config, "leanpiTimeoutMs", LEANPI_TIMEOUT_MS_DEFAULT);
		const started = Date.now();
		// What the session has spent so far, from the session's own counters: the
		// record an attempt needs when it produced no contract, and the one an
		// interrupted or ceiling-killed attempt writes before it stops existing.
		const spentNumbers = (backend: string, model: string) => {
			const tokens = messageTokens(booted.session);
			return {
				backend,
				model,
				calls: tokens.input + tokens.output > 0 ? 1 : 0,
				usage: {
					input_tokens: tokens.input,
					cached_input_tokens: tokens.cached,
					output_tokens: tokens.output,
					reasoning_tokens: tokens.reasoning,
					jev_tokens: 0,
					local_gpu_seconds: 0,
					external_harness_calls: 0,
					subscription_usage: 0,
				},
				wallMs: Date.now() - started,
				toolCalls: tokens.toolCalls,
				result: { verification: "not_run" as const, proof_gate: "not_run" as const, reviewer: "not_run" as const, success: false },
			};
		};
		const configuredBackend = config.models.balanced?.backend ?? Object.keys(config.backends)[0] ?? "leanpi";
		const configuredModel = config.models.balanced?.model ?? "unknown";
		hooks?.onInterrupt(() => appendedRecord(attempt, config, spentNumbers(configuredBackend, configuredModel)));
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			booted.session.agent.abort();
		}, ceilingMs);
		const context = await runTurn(
			{ text: attempt.task.prompt },
			{
				config,
				cwd: attempt.workspace,
				session: booted.session,
				runtime: booted.session.modelRuntime,
				// The ceiling is absolute, so it also covers the lanes: a turn whose
				// compilation overran it must not start a request at all.
				deadlineMs: started + ceilingMs,
			},
		).finally(() => clearTimeout(timer));
		hooks?.onInterrupt(null);
		const ceilingNote = `the turn was killed at the ${Math.round(ceilingMs / 60_000)}-minute attempt ceiling`;
		if (!context.contract) {
			// PRD-007's ownership rule: with native executor roles Pi's own agent
			// loop is the executor, so no lane compiles a contract. The turn still
			// ran under LeanPi's prefix, tool surface and permission guard, so the
			// attempt is recorded from what the session did — and claims nothing,
			// exactly as the contract path does without a §8 ladder verdict.
			appendedRecord(attempt, config, spentNumbers(context.modelRef.backend, context.modelRef.model));
			return {
				extensions: ["leanpi"],
				operator: "leanpi",
				subscription_usage: 0,
				note: `native executor roles: Pi's loop ran the turn under LeanPi's prefix and tools, so no contract was compiled and no success is claimed${killed ? `; ${ceilingNote}` : ""}`,
			};
		}
		const verdict = await (options.verdict ?? verdictFromVerification)(context, attempt);
		// Pi's own loop was the executor, so nothing fed the collector while the turn
		// ran: the session's own message usage is what the record reports, one call
		// per assistant message. Without this the row is all zeros — the numbers the
		// accounting exists to carry.
		const spend = callsFromMessages(booted.session.messages ?? [], { backend: context.modelRef.backend, model: context.modelRef.model });
		for (const call of spend.calls) collector.add(call);
		collector.noteToolCall(spend.toolCalls);
		// The same measurement the extension's own sink makes: without it the two
		// counters the fat question reads are structurally always zero.
		for (const path of spend.fileReads) collector.noteFileRead(path);
		collector.addWallMs(Date.now() - started);
		// JEV's own spend, read back from the run's decision log: the compiler asks
		// five sites per turn on this path, and their tokens are money on the same
		// account as the model's. A row that omits them flatters the control plane.
		for (const row of readDecisions(attempt.workspace)) collector.recordJevDecision(row);
		emitRunTelemetry(collector, context.contract, verdict, {
			cwd: attempt.workspace,
			// The run's store, not the workspace's: attempts run in throwaway checkouts
			// and the metrics join them from one place.
			cost: { ...resolveCostConfig(config), telemetry_path: attempt.telemetry_path },
		});
		return {
			extensions: ["leanpi"],
			operator: "leanpi",
			subscription_usage: attempt.config.subscription ? 1 : 0,
			note: killed
				? ceilingNote
				: options.verdict
					? null
					: "no §8 ladder verdict supplied: the attempt records its verifier status and claims no success",
		};
	};
}

// ---------------------------------------------------------------------------
// Stock Pi (no LeanPi extension)
// ---------------------------------------------------------------------------

/**
 * Pi's own view of the workspace: extensions loaded from disk with **no**
 * factory injected. LeanPi is loaded as an extension, so its absence here is the
 * auditable form of "no LeanPi".
 */
export async function stockPiExtensions(cwd: string, agentDir: string): Promise<{ extensions: string[]; errors: string[] }> {
	const services = await createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions: { extensionFactories: [] } });
	const loaded = services.resourceLoader.getExtensions();
	return {
		extensions: loaded.extensions.map((extension) => extension.path),
		errors: loaded.errors.map((failure) => `${failure.path}: ${failure.error}`),
	};
}

/**
 * Pi's documented custom-provider path: a `models.json` beside the agent dir.
 * Stock Pi reaches a local model exactly this way — no credential, no
 * subscription, no LeanPi provider registration.
 */
export function writeStockPiModels(config: LeanPiConfig, agentDir: string, options: { includeCost?: boolean } = {}): void {
	const includeCost = options.includeCost ?? true;
	const providers: Record<string, unknown> = {};
	for (const [name, backend] of Object.entries(config.backends)) {
		if (backend.type !== "native" || typeof backend.baseUrl !== "string") continue;
		// `models.specialists` (FR-047) is a language/task-type map, not a role
		// binding, so only the role keys name a model this provider serves.
		const models = Object.entries(config.models)
			.filter(([role, entry]) => isModelRole(role) && entry?.backend === name)
			// Pi needs the full model descriptor, `cost` included: without it the
			// model still registers but every request resolves to an empty
			// assistant turn with zero tokens, which the bench then records as a
			// successful attempt that measured nothing.
			.map(([, entry]) => ({
				id: entry!.model,
				...(backend.reasoning === undefined ? {} : { reasoning: backend.reasoning }),
				...(backend.contextWindow === undefined ? {} : { contextWindow: backend.contextWindow }),
				...(backend.maxTokens === undefined ? {} : { maxTokens: backend.maxTokens }),
				...(backend.cost === undefined || !includeCost ? {} : { cost: backend.cost }),
			}));
		if (models.length === 0) continue;
		providers[name] = {
			baseUrl: backend.baseUrl,
			api: backend.api ?? "openai-completions",
			apiKey: typeof backend.apiKey === "string" ? backend.apiKey : "local",
			// A backend that authenticates or shapes requests per call is
			// unreachable without these: opencode-go rejects a header-less request
			// with 400 MissingSessionID, which stock Pi reports as a 260ms
			// zero-token "success" — an arm that silently measures nothing.
			...(backend.headers === undefined ? {} : { headers: backend.headers }),
			...(backend.compat === undefined ? {} : { compat: backend.compat }),
			models,
		};
	}
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({ providers }, null, 2)}\n`);
}

/** The tokens and tool calls Pi's own message list reports for the turn. */
function messageTokens(session: AgentSession): { input: number; cached: number; output: number; reasoning: number; toolCalls: number } {
	let input = 0;
	let cached = 0;
	let output = 0;
	let reasoning = 0;
	let toolCalls = 0;
	for (const message of session.messages) {
		const usage = (message as { usage?: { input?: number; cacheRead?: number; output?: number; reasoning?: number } }).usage;
		if (usage) {
			input += usage.input ?? 0;
			cached += usage.cacheRead ?? 0;
			output += usage.output ?? 0;
			reasoning += usage.reasoning ?? 0;
		}
		const content = (message as { content?: unknown }).content;
		if (Array.isArray(content)) {
			for (const part of content) if ((part as { type?: string }).type === "toolCall") toolCalls += 1;
		}
	}
	return { input, cached, output, reasoning, toolCalls };
}

export interface StockPiAttemptOptions {
	config: LeanPiConfig;
	agentDir?: string;
	env?: NodeJS.ProcessEnv;
	/** Test seam: a session the caller booted instead of one booted here. */
	session?: (attempt: BenchAttempt, services: AgentSessionServices) => Promise<AgentSession>;
}

export function stockPiAttempt(options: StockPiAttemptOptions): BenchAttemptExecutor {
	return async (attempt: BenchAttempt): Promise<BenchAttemptResult> => {
		const config = configForRow(options.config, attempt.config);
		const agentDir = options.agentDir ?? join(attempt.workspace, ".bench-agent");
		const loaded = await stockPiExtensions(attempt.workspace, agentDir);
		const boot = async (includeCost: boolean): Promise<AgentSessionServices> => {
			writeStockPiModels(config, agentDir, { includeCost });
			return createAgentSessionServices({ cwd: attempt.workspace, agentDir, resourceLoaderOptions: { extensionFactories: [] } });
		};
		let services = await boot(true);
		// Role bindings only: falling back to the first `models:` value would pick
		// the `specialists` map (FR-047) and dispatch an undefined model id.
		const bindings = Object.entries(config.models)
			.filter(([role, entry]) => isModelRole(role) && entry !== undefined)
			.map(([, entry]) => entry!);
		const declared = bindings.find((entry) => entry.model === attempt.config.executor_model) ?? bindings[0];
		if (!declared) throw new BenchError(`config "${attempt.config.id}" declares no model for a stock Pi session`, "config");
		// Pi keeps the rate card only for providers its own catalog knows; on any
		// other provider a model entry carrying `cost` is dropped outright. The
		// card is worth one retry rather than a hard failure: a backend that needs
		// it (opencode-go returns an empty assistant turn without it) keeps it, and
		// a bespoke provider still boots. Pricing lives in the ledger either way.
		let model = services.modelRuntime.getModel(declared.backend, declared.model);
		if (!model) {
			services = await boot(false);
			model = services.modelRuntime.getModel(declared.backend, declared.model);
		}
		if (!model) {
			throw new BenchError(`stock Pi cannot reach ${declared.backend}/${declared.model}: write a baseUrl for that backend in leanpi.config.yaml`, "config");
		}
		const session = options.session
			? await options.session(attempt, services)
			: (await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(), model })).session;
		const started = Date.now();
		await session.prompt(attempt.task.prompt);
		const wallMs = Date.now() - started;
		const tokens = messageTokens(session);
		const usage: RunUsage = {
			input_tokens: tokens.input,
			cached_input_tokens: tokens.cached,
			output_tokens: tokens.output,
			reasoning_tokens: tokens.reasoning,
			jev_tokens: 0,
			local_gpu_seconds: 0,
			external_harness_calls: 0,
			subscription_usage: 0,
		};
		appendedRecord(attempt, config, {
			backend: declared.backend,
			model: declared.model,
			calls: tokens.input + tokens.output > 0 ? 1 : 0,
			usage,
			wallMs,
			toolCalls: tokens.toolCalls,
			// Stock Pi makes no verification or proof claim; its "done" is that the turn
			// returned, which is exactly what the independent adjudicator then checks.
			result: { verification: "not_run", proof_gate: "not_run", reviewer: "not_run", success: true },
		});
		return {
			extensions: loaded.extensions,
			operator: "stock-pi",
			subscription_usage: 0,
			note: loaded.errors.length > 0 ? `Pi's resource loader reported ${loaded.errors.length} error(s)` : null,
		};
	};
}

// ---------------------------------------------------------------------------
// External subscription baselines (owner-gated)
// ---------------------------------------------------------------------------

export interface ExternalAttemptOptions {
	config: LeanPiConfig;
	env?: Record<string, string | undefined>;
	/** Test seam: the vendor CLI's spawn. */
	spawn?: HarnessSpawn;
	timeoutMs?: number;
}

export function externalAttempt(options: ExternalAttemptOptions): BenchAttemptExecutor {
	return async (attempt: BenchAttempt): Promise<BenchAttemptResult> => {
		const vendor = attempt.config.vendor;
		if (vendor === null) throw new BenchError(`config "${attempt.config.id}" is not bound to a vendor`, "config");
		const env = options.env ?? process.env;
		if (!externalBaselinesEnabled(env)) {
			throw new BenchError(
				`config "${attempt.config.id}" runs ${vendor}'s own CLI under joao's subscription; set ${EXTERNAL_BASELINES_FLAG}=1 to run it`,
				"owner-gate",
			);
		}
		const backend: RegisteredBackend | undefined = parseBackendPool(options.config).find((candidate) => candidate.vendor === vendor);
		if (!backend) {
			throw new BenchError(`config "${attempt.config.id}" needs a backends.<name> entry with type: external_harness and vendor: ${vendor}`, "config");
		}
		const outcome = await runHarness(
			backend,
			{ objective: attempt.task.prompt, role: "balanced", prompt: attempt.task.prompt },
			{
				cwd: attempt.workspace,
				env: env as NodeJS.ProcessEnv,
				timeoutMs: options.timeoutMs ?? timeoutOf(options.config, "externalTimeoutMs", 1_800_000),
				...(options.spawn ? { spawn: options.spawn } : {}),
			},
		);
		if (outcome.status === "failed" && outcome.failure === "spawn") {
			throw new BenchError(
				`the ${vendor} baseline could not start: ${outcome.reason}. Install it and log in, then re-run — an empty row would hide the missing baseline.`,
				"adapter",
			);
		}
		if (outcome.status === "failed" && outcome.failure === "limit") {
			throw new BenchError(`the ${vendor} baseline hit a usage limit: ${outcome.reason} — quota is recorded, never circumvented (§58)`, "adapter");
		}
		const returned = outcome.status === "ok";
		appendedRecord(attempt, options.config, {
			backend: backend.name,
			model: backend.model ?? attempt.config.executor_model,
			calls: 1,
			usage: {
				input_tokens: 0,
				cached_input_tokens: 0,
				output_tokens: 0,
				reasoning_tokens: 0,
				jev_tokens: 0,
				local_gpu_seconds: 0,
				external_harness_calls: 1,
				// One subscription draw per dispatch: the worker's own quota consumption,
				// recorded rather than circumvented.
				subscription_usage: 1,
			},
			wallMs: 0,
			toolCalls: 0,
			result: { verification: returned ? "external-harness" : "failed", proof_gate: "not_run", reviewer: "not_run", success: returned },
		});
		return {
			extensions: [],
			operator: vendor,
			subscription_usage: 1,
			note: returned ? null : `the ${vendor} worker reported: ${outcome.status === "failed" ? outcome.reason : ""}`,
		};
	};
}

// ---------------------------------------------------------------------------
// omp (oh-my-pi) — the harness LeanPi is measured against
// ---------------------------------------------------------------------------

/** The omp CLI, driven non-interactively. */
export const OMP_COMMAND_DEFAULT = "omp";
/** Per-attempt ceiling for one omp turn; `bench.ompTimeoutMs` overrides it. */
export const OMP_TIMEOUT_MS_DEFAULT = 2_700_000;
/**
 * Per-attempt ceiling for one LeanPi turn; `bench.leanpiTimeoutMs` overrides it.
 * The omp row's ceiling, so neither arm of a comparison runs unbounded.
 */
export const LEANPI_TIMEOUT_MS_DEFAULT = OMP_TIMEOUT_MS_DEFAULT;

/** What omp's `--mode json` stream reports about a finished turn. */
export interface OmpTurn {
	input: number;
	cached: number;
	output: number;
	toolCalls: number;
	/** omp's own priced cost, kept for the cross-check against this harness's rate card. */
	reportedCost: number;
	assistantMessages: number;
	/** `true` when the stream carried omp's terminal `agent_end`; `false` for a killed turn. */
	terminal: boolean;
}

/** A JSON value that is an object, or null. The one narrowing this parser needs. */
function objectOf(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberAt(record: Record<string, unknown>, key: string): number {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Fold omp's newline-delimited JSON stream into one turn's numbers.
 *
 * The terminal `agent_end` event carries the whole message list and is used
 * when present. A turn killed at the attempt ceiling never emits it, so the
 * fallback is the streamed `message_end` events — one per completed message,
 * each carrying that message's final usage. The `message_start` events are
 * always skipped: they repeat the same message with a zeroed usage block.
 */
export function parseOmpStream(stdout: string): OmpTurn | null {
	let finalMessages: unknown[] | null = null;
	const streamed: unknown[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const event = objectOf(parsed);
		if (event === null) continue;
		if (event.type === "agent_end" && Array.isArray(event.messages)) finalMessages = event.messages;
		else if (event.type === "message_end" && event.message !== undefined) streamed.push(event.message);
	}
	const turn: OmpTurn = { input: 0, cached: 0, output: 0, toolCalls: 0, reportedCost: 0, assistantMessages: 0, terminal: finalMessages !== null };
	for (const entry of finalMessages ?? streamed) {
		const message = objectOf(entry);
		if (message === null || message.role !== "assistant") continue;
		turn.assistantMessages += 1;
		const usage = objectOf(message.usage);
		if (usage !== null) {
			turn.input += numberAt(usage, "input");
			turn.output += numberAt(usage, "output");
			turn.cached += numberAt(usage, "cacheRead");
			const cost = objectOf(usage.cost);
			if (cost !== null) turn.reportedCost += numberAt(cost, "total");
		}
		if (Array.isArray(message.content)) {
			for (const part of message.content) {
				const content = objectOf(part);
				if (content !== null && content.type === "toolCall") turn.toolCalls += 1;
			}
		}
	}
	return turn.terminal || turn.assistantMessages > 0 ? turn : null;
}

export interface OmpAttemptOptions {
	config: LeanPiConfig;
	env?: NodeJS.ProcessEnv;
	/** Test seam / override for the CLI name. */
	command?: string;
	timeoutMs?: number;
}

/**
 * One omp turn in the task's workspace, priced from the *same* rate card the
 * LeanPi row bills against so the two arms are comparable: omp's own priced
 * cost is recorded alongside as the cross-check, never as the measured value.
 *
 * `--auto-approve` is omp's equivalent of the permissive permission profile the
 * LeanPi row runs under; without it a headless turn cannot edit a file and the
 * comparison would measure approval prompts rather than harnesses.
 */
export function ompAttempt(options: OmpAttemptOptions): BenchAttemptExecutor {
	return async (attempt: BenchAttempt): Promise<BenchAttemptResult> => {
		const command = options.command ?? OMP_COMMAND_DEFAULT;
		const backend = options.config.models.balanced?.backend ?? Object.keys(options.config.backends)[0];
		if (backend === undefined) {
			throw new BenchError(`config "${attempt.config.id}" needs a backend in leanpi.config.yaml to price omp's tokens against`, "config");
		}
		const started = Date.now();
		const run = spawnSync(
			command,
			[
				"--print",
				"--mode",
				"json",
				"--no-session",
				"--auto-approve",
				"--model",
				attempt.config.executor_model,
				"--cwd",
				attempt.workspace,
				attempt.task.prompt,
			],
			{
				cwd: attempt.workspace,
				encoding: "utf8",
				env: options.env ?? process.env,
				timeout: options.timeoutMs ?? timeoutOf(options.config, "ompTimeoutMs", OMP_TIMEOUT_MS_DEFAULT),
				maxBuffer: 256 * 1024 * 1024,
			},
		);
		const wallMs = Date.now() - started;
		if (run.error && "code" in run.error && run.error.code === "ENOENT") {
			throw new BenchError(`the omp baseline could not start: "${command}" is not on PATH. Install it before running this row.`, "adapter");
		}
		const turn = parseOmpStream(run.stdout ?? "");
		if (turn === null) {
			const tail = `${run.stderr ?? ""}`.trim().split("\n").slice(-3).join(" ");
			throw new BenchError(
				`omp produced no message at all for task "${attempt.task.id}" (exit ${run.status ?? "signal"}): ${tail || "no diagnostic"}`,
				"adapter",
			);
		}
		// A turn killed at the ceiling is an attempt, not a broken run: its tokens
		// are spent and its workspace is judged by the held-out golden like any
		// other. Only a turn that never produced a message is an adapter failure.
		const returned = run.status === 0 && turn.terminal;
		appendedRecord(attempt, options.config, {
			backend,
			model: attempt.config.executor_model,
			calls: turn.assistantMessages,
			usage: {
				input_tokens: turn.input,
				cached_input_tokens: turn.cached,
				output_tokens: turn.output,
				reasoning_tokens: 0,
				jev_tokens: 0,
				local_gpu_seconds: 0,
				external_harness_calls: 0,
				subscription_usage: 0,
			},
			wallMs,
			toolCalls: turn.toolCalls,
			// omp claims nothing beyond "the turn returned"; the held-out golden decides.
			result: { verification: "not_run", proof_gate: "not_run", reviewer: "not_run", success: returned },
		});
		return {
			extensions: ["omp"],
			operator: "omp",
			subscription_usage: 0,
			note: `omp priced this turn at $${turn.reportedCost.toFixed(6)} over ${turn.assistantMessages} assistant message(s)${
				turn.terminal ? "" : `; the turn was killed at the ${Math.round((options.timeoutMs ?? timeoutOf(options.config, "ompTimeoutMs", OMP_TIMEOUT_MS_DEFAULT)) / 60_000)}-minute attempt ceiling`
			}${returned || !turn.terminal ? "" : `; the CLI exited ${run.status ?? "on a signal"}`}`,
		};
	};
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface AdapterDeps {
	config: LeanPiConfig;
	env?: NodeJS.ProcessEnv;
	agentDir?: string;
	spawn?: HarnessSpawn;
	/** The LeanPi session factory; `bench/cli.ts` supplies the package entry's. */
	session?: LeanPiAttemptOptions["session"];
}

/** The executor a row runs under. One function per adapter, no registry. */
export function attemptExecutorFor(row: BenchConfigRow, deps: AdapterDeps): BenchAttemptExecutor {
	if (row.adapter === "leanpi") {
		if (!deps.session) {
			throw new BenchError(
				`config "${row.id}" needs a LeanPi session factory: bench/cli.ts passes createLeanPiSession(), tests pass a scripted session`,
				"adapter",
			);
		}
		return leanPiAttempt({
			config: deps.config,
			session: deps.session,
			timeoutMs: timeoutOf(deps.config, "leanpiTimeoutMs", LEANPI_TIMEOUT_MS_DEFAULT),
		});
	}
	if (row.adapter === "stock-pi") return stockPiAttempt({ config: deps.config, env: deps.env, agentDir: deps.agentDir });
	if (row.adapter === "omp") return ompAttempt({ config: deps.config, env: deps.env });
	return externalAttempt({ config: deps.config, env: deps.env, ...(deps.spawn ? { spawn: deps.spawn } : {}) });
}

/** The vendor CLI a row needs, for the pre-flight error that names the missing baseline. */
export function vendorCommand(row: BenchConfigRow): string | null {
	return row.vendor === null ? null : HARNESS_DESCRIPTORS[row.vendor].defaultCommand;
}

/** Whether the vendor CLI is on PATH; `null` when the row is not external. */
export function vendorAvailable(row: BenchConfigRow, env: Record<string, string | undefined> = process.env): boolean | null {
	const command = vendorCommand(row);
	if (command === null) return null;
	const path = env.PATH ?? "";
	return path.split(":").some((dir) => dir.length > 0 && existsSync(join(dir, command)));
}
