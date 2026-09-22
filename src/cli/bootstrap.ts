/**
 * What `leanpi` does before it hands over to Pi.
 *
 * Two questions have to be answered before a session is worth starting, and
 * both have answers the machine already knows:
 *
 * 1. **Which models may this run use?** A user who has logged into Claude Code
 *    or Codex has already told the machine something LeanPi can act on, so a
 *    first run writes a config from what is installed and signed in rather than
 *    failing with "no model roles configured".
 * 2. **Is the control plane there?** LeanPi's whole thesis is that a cheap
 *    semantic layer decides what a task needs (ROADMAP §4). Without a JEV
 *    credential every site falls back to a deterministic heuristic — the
 *    harness still runs, it just routes worse and spends more tokens per task.
 *    So a missing key is a warning, not a refusal: the operator gets a working
 *    session and is told what it is. `--no-jev` and `jev.mode: disabled` are
 *    deliberate opt-outs and earn no warning at all.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { detectVendors, type SubscriptionState } from "../backends/subscriptions.js";
import { allocateRoles, candidateKey, discoverInventory, ladderAllocation, VENDOR_DEFAULT, type Allocation, type DiscoveredModel, type ModelCandidate } from "./allocate.js";
import { CONFIG_FILENAME, configPathFor, loadConfig, userConfigPath } from "../core/config.js";
import { resolvePiCli } from "./launch.js";
import { MODEL_ROLES, type JevProvider, type LeanPiConfig, type ModelRole } from "../core/types.js";
import { createJevClient, type JevClient } from "../jev/client.js";
import { LEANPI_VERSION } from "../core/package-info.js";
import { describeCredential, resolveCredential, writeStoredKey } from "../jev/credentials.js";

export interface BootstrapEnv {
	cwd: string;
	env: NodeJS.ProcessEnv;
	home: string;
}

function environment(options: Partial<BootstrapEnv> = {}): BootstrapEnv {
	const env = options.env ?? process.env;
	return { cwd: options.cwd ?? process.cwd(), env, home: options.home ?? env.HOME ?? homedir() };
}

/** How the role map was decided, for the config header and the startup line. */
function describeAllocation(allocation: Allocation): string {
	if (allocation.fallbackUsed) return "the cheapest-first fallback ladder (JEV had no confident answer)";
	const undecided = MODEL_ROLES.filter((role) => !allocation.decided.includes(role));
	const source = "JEV, from published capability and price data";
	return undecided.length === 0 ? source : `${source}, ${undecided.join(" and ")} by the cheapest-first fallback`;
}

/** The vendor's own quota reality, the one thing about it that is not detectable. */
const QUOTA_CLASS: Record<string, string> = { claude: "scarce-premium", codex: "premium", opencode: "low-cost" };

/**
 * Is Pi itself able to talk to this provider? `pi auth check` answers without
 * spending a token, and it is the only way to know before writing a config
 * whether Pi's own loop — the thing that answers the user on the `--extension`
 * entry — has a model at all.
 */
export function piProviderReady(provider: string, options: { run?: (cli: string, args: readonly string[]) => string } = {}): boolean {
	try {
		const output = (options.run ?? ((cli, args) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] })))(
			resolvePiCli(),
			["auth", "check", "--provider", provider, "--json", "--no-refresh"],
		);
		return /"status"\s*:\s*"ready"/.test(output);
	} catch {
		return false;
	}
}

/**
 * The one native provider LeanPi can describe without being told: the endpoint
 * this repository's cost work is measured on, with its measured rate card and
 * the two dialect facts that decide the bill (`thinkingFormat: deepseek`, and a
 * session header the endpoint refuses requests without). It is written only
 * when Pi reports the credential is already there, and it matters because Pi's
 * own loop cannot dial a vendor CLI — without a native backend the interactive
 * entry runs on whatever provider Pi happens to find.
 */
const OPENCODE_GO_PROVIDER = "opencode-go";

function nativeOpenCodeGo(sessionId: string, env: NodeJS.ProcessEnv): string[] {
	return [
		`  ${OPENCODE_GO_PROVIDER}:`,
		"    type: native",
		"    baseUrl: https://opencode.ai/zen/go/v1",
		"    api: openai-completions",
		// Only when the variable is actually set: the evidence for writing this
		// block is `pi auth check`, which reads Pi's own credential store, and
		// naming an unset variable would hand Pi the literal string
		// `OPENCODE_API_KEY` as the key instead of letting it use that store.
		...(env.OPENCODE_API_KEY === undefined ? [] : ["    apiKey: OPENCODE_API_KEY"]),
		"    reasoning: true",
		"    # This endpoint serves the model with DeepSeek's `thinking` field rather",
		"    # than OpenAI's `reasoning_effort`; without the declaration Pi sends no",
		"    # thinking control at all and every call thinks at the server's default,",
		"    # which is ~88% of output tokens on this suite.",
		"    compat:",
		"      thinkingFormat: deepseek",
		"    # The endpoint refuses a request with no session header and keys its",
		"    # prompt cache off it, so the value must not change between requests.",
		"    # Generated once, when this file was written, and stable for as long as",
		"    # the file lives — change it to split this machine's prompt cache.",
		"    headers:",
		`      x-opencode-session: ${sessionId}`,
		"    contextWindow: 1000000",
		"    maxTokens: 32000",
		"    cost:",
		"      input: 0.15",
		"      output: 0.6",
		"      cacheRead: 0.003",
	];
}

export interface AutoConfigResult {
	path: string;
	created: boolean;
	/**
	 * What happened, because "created: false" covers two opposite situations: a
	 * config the user already has (carry on) and a machine with nothing to write
	 * one from (stop and say so).
	 */
	outcome: "existing" | "written" | "no-subscription";
	usable: SubscriptionState[];
	/**
	 * Every model this machine can see, across every vendor CLI, whether or not a
	 * role binds it and whether or not the vendor is signed in. The inventory JEV
	 * is asked to judge and `/model` can list; empty when a config already exists.
	 */
	inventory: DiscoveredModel[];
	/** One line a human can read: what was detected, and what was written. */
	summary: string;
}

function renderConfig(
	usable: readonly SubscriptionState[],
	allocation: Allocation,
	candidates: readonly ModelCandidate[],
	sessionId: string,
	env: NodeJS.ProcessEnv,
): string {
	const lines = [
		"# Written by `leanpi` on first run, from what this machine has installed and",
		"# signed in. It is an ordinary config file: edit it, or delete it to have it",
		"# written again. Credentials are never stored here — the vendor CLIs carry",
		"# their own logins, and LeanPi's JEV key comes from the environment, the",
		"# project's .env, or its own credential store.",
		"",
		"backends:",
	];
	const native = candidates.filter((candidate) => candidate.backend === OPENCODE_GO_PROVIDER);
	for (const state of usable) {
		// The OpenCode subscription is written as a native provider when Pi can
		// reach it, not as a CLI: Pi's own loop can dial a provider and cannot
		// spawn a vendor CLI, and this is the endpoint LeanPi has a rate card for.
		if (state.vendor === "opencode" && native.length > 0) continue;
		lines.push(`  ${state.vendor}:`);
		lines.push(`    type: external_harness`);
		lines.push(`    vendor: ${state.vendor}`);
		lines.push(`    quota_class: ${QUOTA_CLASS[state.vendor] ?? "premium"}`);
	}
	if (native.length > 0) lines.push(...nativeOpenCodeGo(sessionId, env));
	lines.push(
		"",
		`# Roles allocated by ${describeAllocation(allocation)},`,
		`# over the models these CLIs report: ${candidates.map((candidate) => candidateKey(candidate)).join(", ")}.`,
		`# \`${VENDOR_DEFAULT}\` means LeanPi passes no model flag and the vendor CLI's own`,
		"# configured model runs.",
		"models:",
	);
	for (const [role, candidate] of Object.entries(allocation.roles)) {
		lines.push(`  ${role}:`);
		lines.push(`    backend: ${candidate.backend ?? candidate.vendor}`);
		lines.push(`    model: ${candidate.model}`);
	}
	lines.push("", "jev:", "  mode: enabled", "");
	return lines.join("\n");
}

/** The vendor's own login command, for a readiness row that can be acted on. */
const LOGIN_COMMAND: Record<string, string> = { claude: "claude /login", codex: "codex login", opencode: "opencode auth login" };

/**
 * Providers Pi itself holds a credential for, read from its own auth store.
 *
 * A machine with no vendor CLI can still be perfectly able to run LeanPi: Pi's
 * loop is the executor on a native backend, and `pi auth login` is how that
 * credential gets there. Reporting "nothing on this machine can run a turn"
 * without mentioning it was the cold start telling a configured user they had
 * configured nothing.
 */
function piAuthenticatedProviders(home: string): string[] {
	const path = join(home, ".pi", "agent", "auth.json");
	if (!existsSync(path)) return [];
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null ? Object.keys(parsed as Record<string, unknown>) : [];
	} catch {
		// An unreadable auth store is Pi's business to report, not a reason to
		// hide the rest of the readiness block.
		return [];
	}
}

/** One line per thing that could have run this turn, and the command that would fix it. */
function readinessRows(detected: readonly SubscriptionState[], options: { env: NodeJS.ProcessEnv; home: string }): string[] {
	const rows = detected.map((state) => {
		if (!state.onPath) return `${state.vendor}: not installed (${state.evidence})`;
		if (!state.signedIn) return `${state.vendor}: installed but signed out — run \`${LOGIN_COMMAND[state.vendor] ?? `${state.command} login`}\``;
		return `${state.vendor}: ready`;
	});
	const providers = piAuthenticatedProviders(options.home);
	rows.push(
		providers.length > 0
			? `pi: authenticated for ${providers.join(", ")} — add a \`native\` backend for one of them to ${userConfigPath({ ...options.env, HOME: options.home }) ?? CONFIG_FILENAME} and LeanPi will run on it`
			: "pi: no provider credential of its own — `pi auth login` gives the loop a model without any vendor CLI",
	);
	return rows;
}

/**
 * Write a config from the machine's own subscriptions when there is none to
 * find. Never overwrites: a config that exists — project or user — is the
 * user's, and this returns it untouched.
 */
export async function autoConfigure(
	options: Partial<BootstrapEnv> & {
		client?: Parameters<typeof allocateRoles>[0];
		/** Test seam: whether Pi can dial a provider, without spawning Pi's CLI. */
		piReady?: (provider: string) => boolean;
	} = {},
): Promise<AutoConfigResult> {
	const { cwd, env, home } = environment(options);
	const path = configPathFor(cwd, env);
	if (existsSync(path)) {
		return { path, created: false, outcome: "existing", usable: [], inventory: [], summary: `configuration: ${path}` };
	}
	// `verify: true`: a first run may spend a second asking three CLIs whether
	// they are actually logged in, rather than writing a config against a vendor
	// that only *looks* signed in from its credential file.
	const detected = detectVendors({ env, home, verify: true });
	const usable = detected.filter((state) => state.onPath && state.signedIn);
	// Discovery covers every vendor the machine has, signed in or not: the
	// inventory is JEV's decision data, and a signed-out vendor's models are an
	// exclusion to state rather than a candidate to drop before the question.
	const inventory = discoverInventory({ env, home, verify: true, states: detected });
	if (usable.length === 0) {
		return {
			path,
			created: false,
			outcome: "no-subscription",
			usable,
			inventory,
			// One readiness block, not one verdict. The old line said "no vendor
			// CLI is both installed and signed in" and threw the probe results
			// away, so a user with Claude installed and signed out was told the
			// same thing as a user with nothing installed — and neither was told
			// which command fixes it.
			summary: [`no ${CONFIG_FILENAME} found, and nothing on this machine can run a turn yet:`, ...readinessRows(detected, { env, home })].join("\n  "),
		};
	}
	// The models come from the vendors, not from a table in this repository: a
	// hardcoded model id is stale the week after it is written, and on two of the
	// three vendors LeanPi does not even pass one.
	// Pi can dial a provider it has a credential for; it cannot spawn a vendor
	// CLI. Where both are available for the same subscription the provider wins,
	// because that is the one Pi's own loop can run.
	const nativeOpenCode = usable.some((state) => state.vendor === "opencode") && (options.piReady ?? piProviderReady)(OPENCODE_GO_PROVIDER);
	// One remap, applied to the inventory and the ballot together so JEV judges
	// the same execution route the config will dispatch.
	const remap = (candidate: DiscoveredModel): DiscoveredModel =>
		nativeOpenCode && candidate.vendor === "opencode"
			? {
					...candidate,
					backend: OPENCODE_GO_PROVIDER,
					model: candidate.model.replace(`${OPENCODE_GO_PROVIDER}/`, ""),
					facts: { ...candidate.facts, execution: "native" },
				}
			: candidate;
	const fullInventory = inventory.map(remap);
	const candidates: DiscoveredModel[] = fullInventory.filter((candidate) => usable.some((state) => state.vendor === candidate.vendor));
	const allocation =
		options.client === undefined
			? { roles: ladderAllocation(candidates), fallbackUsed: true, decided: [] }
			: await allocateRoles(options.client, candidates, fullInventory);
	// The same computation discovery uses, so the file written here is the file
	// found on the next line.
	const target = userConfigPath({ ...env, HOME: home }) ?? join(cwd, CONFIG_FILENAME);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, renderConfig(usable, allocation, candidates, randomUUID(), env), { mode: 0o600 });
	return {
		path: target,
		created: true,
		outcome: "written",
		usable,
		inventory: fullInventory,
		// One line, and the banner prints the resulting map immediately after, so
		// this says where the file is and who decided — not the map twice.
		summary: `no ${CONFIG_FILENAME} found — wrote ${target}; detected ${usable.map((state) => state.vendor).join(", ")}; roles by ${describeAllocation(allocation)}`,
	};
}

export interface JevCheck {
	/** How the key was found, for the startup line. */
	source: string;
	stored?: string;
	/** Which implementation will answer the registered sites (PRD-042). */
	provider: JevProvider;
}

/**
 * Resolve the control plane without demanding it.
 *
 * A LeanPi with no JEV key still runs — every site has a deterministic fallback
 * — but it is not the product the numbers describe: the classification, the
 * disclosure ranking and the proof sufficiency are all heuristics then. That is
 * worth saying, not worth refusing, so a missing key reports `not configured`
 * and the startup path warns. `--no-jev` and `jev.mode: disabled` are deliberate
 * opt-outs: the operator already answered the question, so neither warns.
 */
export function requireJev(options: Partial<BootstrapEnv> & { allowMissing?: boolean; setKey?: string } = {}): JevCheck {
	const { cwd, env, home } = environment(options);
	// The launcher's `--laya` / `--jev` is the run-scoped override; the config key
	// is the durable one. `--no-jev` is not a provider choice, so it is checked
	// before either and never warns about the one it did not pick.
	const config = bootstrapConfig({ cwd, env, home });
	const forced = env.LEANPI_LAYAY_PROVIDER;
	const provider: JevProvider = forced === "laya" || forced === "typesafe" ? forced : config.jev.provider;
	if (options.setKey !== undefined && options.setKey.length > 0) {
		const path = writeStoredKey(options.setKey, { ...env, HOME: home });
		return { source: "credential store", stored: path, provider };
	}
	// `jev.apiKey` in config, the credential store, `$JEV_API_KEY`, the project's
	// `.env` — the same order the client resolves, so the check cannot disagree
	// with the session it is about to start.
	// An operator who wrote `jev.mode: disabled` has already answered this
	// question: every site resolves by fallback, so a key would be read and never
	// used. Demanding one was a refusal to start over a credential the configured
	// session would ignore.
	if (config.jev.mode === "disabled") return { source: "disabled (jev.mode)", provider };
	if (options.allowMissing === true) return { source: "not configured (--no-jev)", provider };
	// A local provider needs no credential at all; the runtime is resolved (and
	// installed) by the session itself. Startup neither probes nor downloads.
	if (provider === "laya") return { source: "laya (local)", provider };
	const credential = resolveCredential(config, { ...env, HOME: home }, cwd);
	if (credential.key !== null) return { source: describeCredential(credential), provider };
	return { source: "not configured", provider };
}

/**
 * What to say when JEV is missing and the operator did not opt out.
 *
 * One copy of the text, read by both `bin/leanpi.js` (printed under the banner)
 * and the extension's `session_start` (a warning notification), so the two
 * surfaces cannot drift. `null` means "say nothing": a resolved key, `--no-jev`
 * or `jev.mode: disabled` are all answers, and only an unanswered question warns.
 */
export function jevWarning(source: string): string[] | null {
	if (!source.startsWith("not configured") || source.includes("--no-jev")) return null;
	return [
		"JEV not configured — LeanPi routes on heuristics and spends more tokens per task.",
		"  Get a key: https://typesafe.ai",
		"  Set it:    leanpi --jev-key <key>   |   export JEV_API_KEY=<key>   |   /jev key set <key>",
	];
}

/**
 * The config the bootstrap runs on.
 *
 * The user's own file when there is one — `jev.apiKey` is the *first* source
 * `resolveCredential` checks and `jev.endpoint`/`jev.model` are what the client
 * dials, so a stub here would refuse a configured operator at startup and send
 * the one allocation call to the public default. A config that exists but does
 * not load (mid-edit, missing roles) is not a reason to refuse a key: the
 * synthetic block covers that and the genuine first run.
 */
function bootstrapConfig(options: BootstrapEnv): Parameters<typeof createJevClient>[0]["config"] {
	const path = configPathFor(options.cwd, options.env);
	if (existsSync(path)) {
		try {
			return loadConfig(options.cwd, {}, options.env);
		} catch {
			// Fall through: the key check is not the place to report a broken config.
		}
	}
	return { jev: { mode: "enabled", apiKey: null, provider: "typesafe", laya: {} } } as Parameters<typeof createJevClient>[0]["config"];
}

/** A JEV client for the one decision made before a session exists: the role map. */
export function jevClientFor(options: Partial<BootstrapEnv> = {}): JevClient {
	const { cwd, env, home } = environment(options);
	return createJevClient({ config: bootstrapConfig({ cwd, env, home }), cwd, env: { ...env, HOME: home } });
}

/**
 * What the user sees when the harness starts: the mantra, then the three facts
 * that decide what the next turn costs — who executes, who reviews, and whether
 * the control plane is live. One screen line each, on stderr, so a piped
 * `--print` run still yields clean stdout.
 */
/** `JEV on (credential store)`, or why it is not deciding anything. */
function jevLine(check: JevCheck): string {
	const { source } = check;
	if (check.provider === "laya") {
		return source.startsWith("disabled") || source.startsWith("not configured")
			? `JEV ${source} — decisions take their built-in defaults`
			: "JEV on (laya, local — see /jev)";
	}
	if (source.startsWith("disabled") || source.startsWith("not configured")) {
		return `JEV ${source} — decisions take their built-in defaults`;
	}
	// "configured (source: credential store)" → "credential store".
	const inner = /\(source:\s*([^)]+)\)/.exec(source);
	// Not a middot: the banner already joins its facts with one, and a second
	// inside a fact makes the line read as two.
	return `JEV on (${inner ? inner[1] : source})`;
}

/** The π mark, four rows of block glyphs, sized to sit beside four facts. */
const MARK: readonly string[] = ["\u2597\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2596", " \u2590\u2588\u258c \u2590\u2588\u258c ", " \u2590\u2588\u258c \u2590\u2588\u258c ", " \u259d\u2580\u2598 \u259d\u2580\u2598 "];

/**
 * Emphasis, written the way the eye reads a masthead: one bright thing.
 *
 * The name is the only text at full weight. Everything else — the version, the
 * model, the control plane, the path — is supporting detail and is muted, so
 * the block that opens the session has a single focal point instead of four
 * lines competing at the same brightness.
 */
const MARK_COLOR = "\u001b[38;5;43m";
const NAME = "\u001b[1m";
const MUTED = "\u001b[38;5;245m";
const OFF = "\u001b[0m";

/** `/home/joao/x` → `~/x`: the home prefix is noise in a line about location. */
function tildify(cwd: string, home: string): string {
	return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

export interface BannerStyle {
	/** Emit SGR escapes. Off by default so a redirected stream stays plain text. */
	color?: boolean;
	cwd?: string;
	home?: string;
	/** Pi's own agent dir, where its `settings.json` lives. A test seam. */
	agentDir?: string;
}

/** Pi's own default model from `<agentDir>/settings.json`, or undefined when unset. */
function piDefaultModel(agentDir: string): string | undefined {
	const path = join(agentDir, "settings.json");
	if (!existsSync(path)) return undefined;
	try {
		const settings = JSON.parse(readFileSync(path, "utf8")) as { defaultModel?: unknown };
		return typeof settings.defaultModel === "string" ? settings.defaultModel : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The first screen: the mark, then what is running, beside it.
 *
 * Four facts, not a config dump. The previous banner printed every role, both
 * reviewers, the control plane and the loop — six model ids for a config that
 * names one model, which is what made the launch read as noise. Role bindings,
 * reasoning level, backend health and session cost all already have a home in
 * `/status`; this says only what a user needs before typing the first word.
 */
export function startupBanner(config: LeanPiConfig, jev: JevCheck, sessionModel?: string, style: BannerStyle = {}): string {
	const cwd = style.cwd ?? process.cwd();
	const home = style.home ?? homedir();
	const agentDir = style.agentDir || process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
	const on = style.color === true;
	const paint = (code: string, text: string): string => (on ? `${code}${text}${OFF}` : text);
	// The model that answers the prompt. The roles are the workers LeanPi spawns
	// *inside* a turn, and naming them here described something the user is not
	// about to talk to.
	const piDefault = sessionModel === undefined ? piDefaultModel(agentDir) : undefined;
	const running =
		sessionModel !== undefined
			? sessionModel.slice(sessionModel.indexOf("/") + 1)
			: piDefault === undefined
				? "pi's own model — `pi auth login` gives it one"
				: `${piDefault} (pi default)`;
	const facts = [
		// The one bright thing, and its version muted beside it.
		`${paint(NAME, "leanpi")} ${paint(MUTED, `v${LEANPI_VERSION}`)}`,
		// LeanPi picks the effort per task; naming a fixed level would be a lie.
		paint(MUTED, `${running}${sessionModel === undefined ? "" : ", effort chosen per task"}`),
		paint(MUTED, jevLine(jev)),
		paint(MUTED, tildify(cwd, home)),
	];
	return MARK.map((row, index) => `${paint(MARK_COLOR, row)}  ${facts[index] ?? ""}`.trimEnd()).join("\n");
}

/**
 * Named credentials the shell does not hold *and* Pi cannot cover.
 *
 * A missing variable is only a problem when nothing else can authenticate the
 * provider: Pi keeps its own credential store, and on a machine where `pi auth`
 * already has the provider the request succeeds and the warning is a false
 * alarm — which is exactly what it was, printed on every launch, above a
 * session that then worked perfectly.
 */
export function unusableBackendKeys(
	config: LeanPiConfig,
	env: NodeJS.ProcessEnv = process.env,
	piReady: (provider: string) => boolean = piProviderReady,
): Array<{ backend: string; variable: string }> {
	return missingBackendKeys(config, env).filter(({ backend }) => !piReady(backend));
}

/**
 * The model Pi's own loop should run, when the config names one Pi can run.
 *
 * Only a `native` backend qualifies: the extension registers those as Pi
 * providers (`pi.registerProvider`), while an `external_harness` role is a
 * vendor CLI LeanPi spawns inside the turn — Pi cannot dial it, and naming it
 * would fail model resolution at startup.
 */
export function sessionModelFor(config: LeanPiConfig): string | undefined {
	const entry = config.models.balanced ?? config.models.strong ?? config.models.quick;
	if (entry === undefined) return undefined;
	const backend = config.backends[entry.backend] as { type?: string; enabled?: boolean } | undefined;
	if (backend?.type !== "native" || backend.enabled === false) return undefined;
	// `default` means "let the vendor CLI choose" and a native provider has no
	// CLI: passed through it becomes `--model opencode-go/default`, which Pi
	// registers as a real model id and the endpoint answers with
	// `400 Model is unavailable`.
	if (entry.model === VENDOR_DEFAULT) return undefined;
	return `${entry.backend}/${entry.model}`;
}

/**
 * Backends whose credential the config names but the environment does not hold.
 *
 * `apiKey: OPENCODE_API_KEY` means "the variable of that name". When the
 * variable is missing, Pi is handed the *name* as the key — a bare name is a
 * literal in Pi 0.85 — and the provider answers
 * `401 {"type":"AuthError","message":"Invalid API key."}`, which reads like the
 * user's key is wrong rather than absent. Worse, it reads like LeanPi's *JEV*
 * key is wrong, because that is the key they just configured. Checking it here
 * costs nothing and turns a misleading 401 into the variable's name.
 */
export function missingBackendKeys(config: LeanPiConfig, env: NodeJS.ProcessEnv = process.env): Array<{ backend: string; variable: string }> {
	const missing: Array<{ backend: string; variable: string }> = [];
	for (const [name, raw] of Object.entries(config.backends)) {
		const entry = raw as { type?: string; enabled?: boolean; apiKey?: string };
		if (entry.type !== "native" || entry.enabled === false) continue;
		const declared = entry.apiKey;
		// Only a bare name is a variable reference: `$FOO`, `${FOO}` and `!command`
		// are Pi's own syntax and Pi reports their failures itself.
		if (typeof declared !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(declared)) continue;
		if (env[declared] === undefined || env[declared] === "") missing.push({ backend: name, variable: declared });
	}
	return missing;
}
