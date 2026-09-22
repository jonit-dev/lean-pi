#!/usr/bin/env node
/**
 * Four-way harness cost benchmark, one model held constant.
 *
 * Arms: leanpi, stock-pi, codex, claude-code — all on
 * opencode-go/deepseek-v4.1-flash, so what varies is the HARNESS, not the model.
 * Extends bench/out/codex-comparison-20260921/run-pilot.mjs (the proven 2-arm
 * driver) with the stock-Pi and Claude Code arms.
 *
 * OWNS only bench/out/four-way-20260921. Default mode is `--preflight`
 * (offline, no model calls). `--run` is the only spending mode.
 *
 * Every arm gets the same task text + constraints, the same process-group
 * ceiling with streamed logs, and the hidden golden test installed only AFTER
 * the arm has finished. No retries, no fallback, no reviewer, no subagents.
 * Parity is request-level only and is never attested here.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = "/home/joao/projects/lean-pi";
// RUN_ID isolates a run's artifacts: a build change must not append attempts to
// a directory whose earlier trials measured different code.
const OUT = join(ROOT, "bench/out", process.env.RUN_ID ?? "four-way-20260921");
const REUSE = join(ROOT, "bench/out/real-session-audit-20260921");
// The Pi arms load the repo's OWN build, not the frozen 2026-09-21 snapshot, so
// a run measures current LeanPi. `pnpm build` must be current: the run records
// the git SHA and the dist mtime it actually imported.
const SNAP = join(ROOT, "dist");
const FIXTURE = join(REUSE, "fixtures/slugify-counter-duplicate-slug");
const GOOD_WS = join(REUSE, "out/audit-slugify-leanpi-r1-1790018482366/workspaces/slugify-counter-duplicate-slug");
const GOLD = join(GOOD_WS, "test.js");
const KNOWNGOOD = join(GOOD_WS, "index.js");
const TASK_YAML = join(ROOT, "bench/suites/validated/slugify-counter-duplicate-slug/task.yaml");
const MODEL = "deepseek-v4.1-flash";
const PROVIDER = "opencode-go";
const BASE_URL = "https://opencode.ai/zen/go/v1";
const CEILING_MS = 300_000;
const SPEND_GUARD_USD = 0.25;          // per arm
const TOTAL_GUARD_USD = 1.0;           // whole run
// Off-peak rate card, https://opencode.ai/docs/go/#usage-limits (same card the
// 2-arm pilot used, so the two runs are comparable).
const RATES = { input: 0.15, cached: 0.003, output: 0.6, jev: 0.042 };
const ACCEPT = ["./node_modules/ava/entrypoints/cli.mjs", "test.js"];
const GOLD_SHA = "980861781f5c5d735d3b7b6d78eec4f49e02164ed98fecf4e96a04e2756199ea";
const FIXTURE_COMMIT = "2acf5b3cadf7faed3928536d051104502ae2b667";
const BASE_FAIL_LINE = "test.js:270";
const ALL_ARMS = ["leanpi", "stock-pi", "codex", "claude-code"];
const armsFlag = process.argv.indexOf("--arms");
const ARMS = armsFlag >= 0 ? String(process.argv[armsFlag + 1] ?? "").split(",").filter(Boolean) : ALL_ARMS;
for (const arm of ARMS) if (!ALL_ARMS.includes(arm)) throw new Error(`unknown arm "${arm}"; known: ${ALL_ARMS.join(", ")}`);
const CONSTRAINTS = [
  "Work only inside this workspace, using local tools.",
  "Do not delegate to sub-agents or call other models, and do not use the network.",
  "Do not edit test files or dependencies (leave package.json/package-lock alone).",
].join("\n");

let apiCalls = 0; // incremented only when a child is spawned; preflight asserts 0.

// .env (KEY=VALUE) so JEV_API_KEY resolves. Values are never logged or written.
if (existsSync(join(ROOT, ".env"))) {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
function apiKey() {
  const k = process.env.OPENCODE_API_KEY
    ?? (() => { try { return JSON.parse(readFileSync(join(process.env.HOME, ".local/share/opencode/auth.json"), "utf8"))["opencode-go"]?.key; } catch { return undefined; } })();
  if (!k) throw new Error("OPENCODE_API_KEY is unset and opencode auth.json has no opencode-go key");
  return k;
}

const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const shaText = (t) => createHash("sha256").update(t).digest("hex");
const copyFixture = (dest) => { rmSync(dest, { recursive: true, force: true }); mkdirSync(dest, { recursive: true }); cpSync(FIXTURE, dest, { recursive: true, verbatimSymlinks: true }); };
const { parse: parseYaml } = await import(join(ROOT, "node_modules/yaml/dist/index.js"));
const readTask = () => parseYaml(readFileSync(TASK_YAML, "utf8"));
const fullPrompt = (task) => `${task.prompt}\n\nConstraints:\n${CONSTRAINTS}`;

function assert(ok, msg) { if (!ok) throw new Error(`assert failed: ${msg}`); }

/** git SHA + dist mtime of the LeanPi build the Pi arms import. */
function buildProvenance() {
  const sha = (spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout ?? "").trim();
  const dirty = (spawnSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" }).stdout ?? "").trim().length > 0;
  const f = distIsFresh();
  return { dist: SNAP, git_sha: sha, worktree_dirty: dirty, dist_mtime: f.distMtime, newest_src_mtime: f.srcMtime, dist_fresh: f.fresh };
}

/** True when every tracked src file is older than the compiled dist entrypoint. */
function distIsFresh() {
  const entry = join(SNAP, "capabilities/skill-select.js");
  if (!existsSync(entry)) return { fresh: false, distMtime: null, srcMtime: null };
  const distMtime = statSync(entry).mtimeMs;
  let srcMtime = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.name.endsWith(".ts")) srcMtime = Math.max(srcMtime, statSync(full).mtimeMs);
    }
  };
  walk(join(ROOT, "src"));
  return { fresh: distMtime >= srcMtime, distMtime: new Date(distMtime).toISOString(), srcMtime: new Date(srcMtime).toISOString() };
}


function runAccept(ws) {
  const r = spawnSync(process.execPath, ACCEPT, { cwd: ws, encoding: "utf8", timeout: CEILING_MS, maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const p = (out.match(/(\d+)\s+tests?\s+passed/) ?? [])[1];
  const f = (out.match(/(\d+)\s+tests?\s+failed/) ?? [])[1];
  return { status: r.status, passed: p ? Number(p) : null, failed: f ? Number(f) : null, out };
}

// ---------- cost mapping ----------
// Two different usage dialects reach this file and they disagree about whether
// the cached count is INSIDE input_tokens. Getting this backwards silently
// mis-prices a whole arm, so each dialect gets its own function and its own
// self-test rather than one "clever" shared one.

/** OpenAI/Codex dialect: cached_input_tokens is a SUBSET of input_tokens. */
function costSubsetDialect(u) {
  for (const k of ["input_tokens", "cached_input_tokens", "output_tokens"]) {
    const v = u?.[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`invalid usage ${k}=${v}`);
  }
  const uncached = u.input_tokens - u.cached_input_tokens;
  if (uncached < 0) throw new Error("cached_input_tokens exceeds input_tokens");
  return (uncached * RATES.input + u.cached_input_tokens * RATES.cached + u.output_tokens * RATES.output) / 1e6;
}

/** Anthropic/Claude Code dialect: input_tokens EXCLUDES both cache counters.
 *  The rate card prices no separate cache WRITE, so writes bill at input. */
function costDisjointDialect(u) {
  for (const k of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]) {
    const v = u?.[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`invalid usage ${k}=${v}`);
  }
  return ((u.input_tokens + u.cache_creation_input_tokens) * RATES.input
    + u.cache_read_input_tokens * RATES.cached
    + u.output_tokens * RATES.output) / 1e6;
}

function jevClassCost(ws) {
  const p = join(ws, ".leanpi/decisions.jsonl");
  if (!existsSync(p)) return { tokens: 0, usd: 0, unknown: false, records: 0 };
  let tokens = 0, unknown = false, records = 0;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { unknown = true; continue; }
    records++;
    const v = d?.tokens?.inputTokens ?? d?.tokens?.input_tokens;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) unknown = true; else tokens += v;
    if (d.fallbackUsed && !(v > 0)) unknown = true;
  }
  return { tokens, usd: unknown ? null : tokens * RATES.jev / 1e6, unknown, records };
}

function selfTestCosts() {
  assert(Math.abs(costSubsetDialect({ input_tokens: 1e6, cached_input_tokens: 0, output_tokens: 0 }) - 0.15) < 1e-12, "subset input rate");
  assert(Math.abs(costSubsetDialect({ input_tokens: 1e6, cached_input_tokens: 1e6, output_tokens: 0 }) - 0.003) < 1e-12, "subset cached rate");
  assert(Math.abs(costSubsetDialect({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 1e6 }) - 0.6) < 1e-12, "subset output rate");
  assert(Math.abs(costSubsetDialect({ input_tokens: 1e6, cached_input_tokens: 400_000, output_tokens: 0 }) - (0.09 + 0.0012)) < 1e-12, "subset cached is a subset");
  for (const bad of [{ input_tokens: -1, cached_input_tokens: 0, output_tokens: 0 }, { input_tokens: 1, cached_input_tokens: 2, output_tokens: 0 }]) {
    let threw = false; try { costSubsetDialect(bad); } catch { threw = true; } assert(threw, `subset rejects ${JSON.stringify(bad)}`);
  }
  const disj = { input_tokens: 600_000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 0, output_tokens: 0 };
  assert(Math.abs(costDisjointDialect(disj) - (0.09 + 0.0012)) < 1e-12, "disjoint prices the same 1M split as the subset dialect");
  assert(Math.abs(costDisjointDialect({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1e6, output_tokens: 0 }) - 0.15) < 1e-12, "cache writes bill at input rate");
  let threw = false; try { costDisjointDialect({ input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: -1 }); } catch { threw = true; }
  assert(threw, "disjoint rejects negative output");
  assert(Math.abs((1e6 * RATES.jev) / 1e6 - 0.042) < 1e-12, "jev rate");
  assert(Math.abs(jevClassCost(GOOD_WS).usd - 0.001316322) < 1e-12, "recorded classifier usage priced once");
  assert(jevClassCost(join(REUSE, "out/audit-slugify-leanpi-r2-1790018809837/workspaces/slugify-counter-duplicate-slug")).usd === null, "zero-token fallback cost remains unknown");
}

// ---------- process-group spawn with streamed logs ----------
function spawnArm(cmd, args, { cwd, env, logPaths, timeoutMs }) {
  apiCalls++;
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "", stderr = "", settled = false;
    const outFd = openSync(logPaths.stdout, "a");
    const errFd = openSync(logPaths.stderr, "a");
    let child;
    try { child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { closeSync(outFd); closeSync(errFd); return resolve({ spawnError: String(e?.message ?? e), stdout, stderr, timedOut: false, wallMs: 0, code: null, signal: null }); }
    let timedOut = false, killer = null;
    const finish = (code, signal, spawnError) => {
      if (settled) return; settled = true;
      if (killer) clearTimeout(killer);
      try { closeSync(outFd); } catch {}
      try { closeSync(errFd); } catch {}
      resolve({ code, signal, timedOut, spawnError: spawnError ?? null, wallMs: Date.now() - started, stdout, stderr });
    };
    killer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch {} }, timeoutMs);
    child.on("error", (e) => finish(null, null, String(e?.message ?? e)));
    child.stdout.on("data", (d) => { stdout += d; try { writeSync(outFd, d); } catch {} });
    child.stderr.on("data", (d) => { stderr += d; try { writeSync(errFd, d); } catch {} });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

function parseCodex(stdout) {
  const events = stdout.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  let turns = 0, items = 0, tools = 0, invalid = false, delegation = false, completed = false;
  const errors = [];
  for (const e of events) {
    if (e.type === "turn.completed") {
      completed = true; turns++;
      const u = e.usage ?? {};
      for (const k of Object.keys(usage)) {
        const v = u[k] ?? 0;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) invalid = true; else usage[k] += v;
      }
    }
    if (e.type === "item.completed") {
      items++;
      const it = e.item ?? {};
      if (it.type === "command_execution" || it.type === "tool_call" || it.type === "function_call" || it.type === "mcp_tool_call") tools++;
      if (it.type === "error" && it.message) errors.push(String(it.message).slice(0, 200));
      const name = String(it.name ?? it.tool_name ?? it.server_label ?? "");
      if (/multi_agent|web_search/i.test(name) || /multi_agent|web_search/i.test(String(it.type ?? ""))) delegation = true;
    }
  }
  return { events, usage, turns, items, tools, errors, invalid, delegation, completed };
}

/** Claude Code `-p --output-format json` emits exactly one result object. */
function parseClaudeCode(stdout) {
  const objs = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const res = objs.filter((o) => o.type === "result").at(-1) ?? objs.at(-1) ?? null;
  if (!res) return { completed: false, invalid: false, usage: null, errors: ["no JSON result object"], turns: 0, tools: 0, delegation: false };
  const u = res.usage ?? {};
  const usage = {
    input_tokens: u.input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    reasoning_output_tokens: u.output_tokens_details?.thinking_tokens ?? 0,
  };
  const invalid = Object.entries(usage).some(([, v]) => typeof v !== "number" || !Number.isFinite(v) || v < 0)
    // A run that reports zero tokens has no usable cost signal, so it is not a
    // "cheap" arm — it is an unmeasured one.
    || (usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens === 0);
  const errors = [];
  if (res.is_error) errors.push(String(res.result ?? "is_error").slice(0, 200));
  if (res.api_error_status) errors.push(`api_error_status=${res.api_error_status}`);
  return {
    completed: !res.is_error, invalid, usage, errors,
    turns: res.num_turns ?? 0,
    tools: (res.permission_denials?.length ?? 0) >= 0 ? null : null,
    delegation: (res.subagent_stats?.spawned ?? 0) > 0,
    reported_cost_usd: res.total_cost_usd ?? null,
    terminal_reason: res.terminal_reason ?? null,
  };
}

// ---------- preflight (offline) ----------
async function preflight() {
  const t0 = Date.now();
  const task = readTask();
  const prompt = fullPrompt(task);
  const PRE = join(OUT, "preflight", "accept");
  const base = join(PRE, "base"), good = join(PRE, "good");
  copyFixture(base); cpSync(GOLD, join(base, "test.js"));
  copyFixture(good); cpSync(GOLD, join(good, "test.js")); cpSync(KNOWNGOOD, join(good, "index.js"));

  const baseRes = runAccept(base);
  const goodRes = runAccept(good);
  const goldSha = shaFile(GOLD);
  const fixtureCommit = (spawnSync("git", ["-C", FIXTURE, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout ?? "").trim();
  const baseChecks = {
    nonzero_exit: baseRes.status !== 0,
    right_test_failed: /slugifyWithCounter\(\) never returns the same slug twice/.test(baseRes.out),
    right_location: baseRes.out.includes(BASE_FAIL_LINE),
    exactly_one_failure: /1 test failed/.test(baseRes.out) && !/2 tests failed/.test(baseRes.out),
  };
  const goodChecks = { zero_exit: goodRes.status === 0, twenty_five_passed: goodRes.passed === 25 };
  const cliChecks = Object.fromEntries(["codex", "claude", "node"].map((c) => [c, spawnSync("sh", ["-c", `command -v ${c}`], { encoding: "utf8" }).status === 0]));
  cliChecks.pi_module = existsSync(join(SNAP, "bench/adapters.js"));
  // A stale dist silently benchmarks yesterday's LeanPi. Fail the preflight
  // rather than publish a number for code that is no longer in src.
  cliChecks.dist_newer_than_src = distIsFresh().fresh;
  cliChecks.api_key = (() => { try { return apiKey().length > 0; } catch { return false; } })();

  selfTestCosts();
  const report = {
    mode: "preflight", generated_at: new Date().toISOString(), model: MODEL, provider: PROVIDER, base_url: BASE_URL,
    arms: ARMS, fixture: FIXTURE, fixture_commit: fixtureCommit, fixture_commit_ok: fixtureCommit === FIXTURE_COMMIT,
    acceptance_command: `node ${ACCEPT.join(" ")}`,
    cli: cliChecks,
    hashes: {
      gold_sha256: goldSha, gold_sha256_ok: goldSha === GOLD_SHA,
      fixture_index_sha256: shaFile(join(FIXTURE, "index.js")),
      fixture_test_sha256: shaFile(join(FIXTURE, "test.js")),
      known_good_index_sha256: shaFile(KNOWNGOOD),
      prompt_sha256: shaText(prompt),
    },
    base: { status: baseRes.status, passed: baseRes.passed, failed: baseRes.failed, checks: baseChecks, tail: baseRes.out.slice(-1200) },
    good: { status: goodRes.status, passed: goodRes.passed, failed: goodRes.failed, checks: goodChecks, tail: goodRes.out.slice(-800) },
    api_calls_made: apiCalls,
    duration_ms: Date.now() - t0,
  };
  assert(goldSha === GOLD_SHA, "hidden golden sha256");
  assert(fixtureCommit === FIXTURE_COMMIT, "frozen fixture commit");
  assert(Object.values(baseChecks).every(Boolean), `base must fail the duplicate-slug assertion at ${BASE_FAIL_LINE}`);
  assert(Object.values(goodChecks).every(Boolean), "known-good source must pass exactly 25");
  assert(Object.values(cliChecks).every(Boolean), `every arm's entrypoint must be reachable: ${JSON.stringify(cliChecks)}`);
  assert(apiCalls === 0, "--preflight must make no API calls");
  mkdirSync(join(OUT, "preflight"), { recursive: true });
  writeFileSync(join(OUT, "preflight", "acceptance.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`PREFLIGHT PASS base(fail@${BASE_FAIL_LINE}) good(${goodRes.passed}/25) arms=${ARMS.join(",")} api_calls=${apiCalls}`);
  console.log(JSON.stringify({ cli: cliChecks, hashes: report.hashes }, null, 2));
}

// ---------- paid run ----------
async function runArm(arm, task, trial) {
  const dir = join(OUT, "attempts", `${arm}-r${trial}`);
  mkdirSync(dir, { recursive: true });
  assert(!existsSync(join(dir, "result.json")), `refuse to overwrite a previous paid attempt (${arm}-r${trial})`);
  const ws = join(dir, "workspace");
  copyFixture(ws);
  const startedAt = new Date().toISOString();
  const prompt = fullPrompt(task);
  const session = `${arm}-${randomUUID()}`;
  const logPaths = { stdout: join(dir, "stdout.log"), stderr: join(dir, "stderr.log") };
  const rec = {
    arm, trial, task: task.id, model: MODEL, provider: PROVIDER, session_uuid: session,
    started_at: startedAt, ceiling_ms: CEILING_MS,
    start_hashes: { fixture_index_sha256: shaFile(join(FIXTURE, "index.js")), prompt_sha256: shaText(prompt) },
    usage: null, usage_dialect: null, model_cost_usd: null, classifier_cost_usd: null, delegated_cost_usd: 0, other_cost_usd: 0,
  };
  let run, record = null;

  if (arm === "codex") {
    rec.usage_dialect = "subset";
    rec.classifier_cost_usd = 0;
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), [
      `model = "${MODEL}"`,
      `model_provider = "${PROVIDER}"`,
      `model_supports_reasoning_summaries = true`,
      `model_reasoning_effort = "medium"`,
      `project_doc_max_bytes = 0`,
      ``,
      `[model_providers.${PROVIDER}]`,
      `name = "OpenCode Go Zen"`,
      `base_url = "${BASE_URL}"`,
      `env_key = "OPENCODE_API_KEY"`,
      `wire_api = "responses"`,
      `env_http_headers = { "x-opencode-session" = "LEANPI_OPENCODE_SESSION" }`,
      `request_max_retries = 0`,
      `stream_max_retries = 0`,
      ``,
      `[skills]`,
      `include_instructions = false`,
      ``,
    ].join("\n"));
    const env = { ...process.env, OPENCODE_API_KEY: apiKey(), CODEX_HOME: codexHome, LEANPI_OPENCODE_SESSION: session };
    const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", ws,
      "-o", join(dir, "answer.txt"), "-c", `model_provider=${PROVIDER}`, "-c", "approval_policy=never", "-m", MODEL, prompt];
    run = await spawnArm("codex", args, { cwd: ws, env, logPaths, timeoutMs: CEILING_MS });
    const p = parseCodex(run.stdout);
    rec.harness = { turns: p.turns, items: p.items, tool_calls: p.tools, errors: p.errors, invalid_counts: p.invalid, delegation_suspected: p.delegation, exit: run.code, signal: run.signal, timed_out: run.timedOut, spawn_error: run.spawnError, wall_ms: run.wallMs };
    if (p.completed && !p.invalid) { rec.usage = p.usage; rec.model_cost_usd = costSubsetDialect(p.usage); }
    if (p.delegation) rec.delegated_cost_usd = null;

  } else if (arm === "claude-code") {
    rec.usage_dialect = "disjoint";
    rec.classifier_cost_usd = 0;
    const ccHome = join(dir, "cc-home");
    mkdirSync(join(ccHome, ".claude"), { recursive: true });
    // Empty settings + empty home: no user skills, hooks, MCP servers or
    // CLAUDE.md leak into the arm. Without this the arm measures the operator's
    // dotfiles instead of stock Claude Code.
    writeFileSync(join(ccHome, ".claude", "settings.json"), JSON.stringify({ includeCoAuthoredBy: false }, null, 2) + "\n");
    // Without the pre-answered onboarding AND the pre-approved key, `claude -p`
    // reports apiKeySource:"none" and blocks forever on an interactive prompt
    // that -p never renders. Approval is keyed on the last 20 chars of the key.
    const key = apiKey();
    writeFileSync(join(ccHome, ".claude.json"), JSON.stringify({
      hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, theme: "dark", autoUpdates: false,
      customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, projects: {},
    }, null, 2) + "\n");
    const env = {
      PATH: process.env.PATH, HOME: ccHome, USER: process.env.USER ?? "bench", SHELL: "/bin/sh", TERM: "dumb",
      ANTHROPIC_BASE_URL: BASE_URL.replace(/\/v1$/, ""),   // Claude Code appends /v1/messages itself
      ANTHROPIC_API_KEY: key,      // x-api-key; ANTHROPIC_AUTH_TOKEN alone is not enough
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_MODEL: MODEL,
      ANTHROPIC_SMALL_FAST_MODEL: MODEL,
      ANTHROPIC_CUSTOM_HEADERS: `x-opencode-session: ${session}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", DISABLE_ERROR_REPORTING: "1",
      MAX_THINKING_TOKENS: "8000",
    };
    const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--model", MODEL, prompt];
    run = await spawnArm("claude", args, { cwd: ws, env, logPaths, timeoutMs: CEILING_MS });
    const p = parseClaudeCode(run.stdout);
    rec.harness = { turns: p.turns, items: null, tool_calls: p.tools, errors: p.errors, invalid_counts: p.invalid, delegation_suspected: p.delegation, reported_cost_usd: p.reported_cost_usd, terminal_reason: p.terminal_reason, exit: run.code, signal: run.signal, timed_out: run.timedOut, spawn_error: run.spawnError, wall_ms: run.wallMs };
    if (p.usage && !p.invalid) { rec.usage = p.usage; rec.model_cost_usd = costDisjointDialect(p.usage); }
    if (p.delegation) rec.delegated_cost_usd = null;

  } else {
    // leanpi and stock-pi both boot Pi in-process; the worker keeps that import
    // graph out of the driver so a crashed arm cannot take the run with it.
    //
    // Pi's usage is the DISJOINT dialect (cached_input_tokens sits outside
    // input_tokens -- a run here reported 267,776 cached against 21,072 input),
    // and the two Pi adapters disagree on output: the LeanPi record's
    // output_tokens EXCLUDES reasoning_tokens while the stock Pi record's
    // INCLUDES them. Both are priced by Pi's own accounting below, never by the
    // dialect helpers, so this label is documentation and must not be used to
    // pick a helper.
    rec.usage_dialect = arm === "leanpi" ? "pi-disjoint/output-excludes-reasoning" : "pi-disjoint/output-includes-reasoning";
    const agentDir = join(dir, "agentdir");
    rmSync(agentDir, { recursive: true, force: true }); mkdirSync(agentDir, { recursive: true });
    assert(readdirSync(agentDir).length === 0, `${arm} agentDir must start empty`);
    const telemetryPath = join(dir, "telemetry.jsonl");
    const telemetryTaskId = `four-way:${task.id}:${arm}`;
    const env = { ...process.env, OPENCODE_API_KEY: apiKey(), LEANPI_OPENCODE_SESSION: session, ARM: arm, WORKSPACE: ws, AGENT_DIR: agentDir,
      TELEMETRY_PATH: telemetryPath, SESSION_ID: session, TELEMETRY_TASK_ID: telemetryTaskId,
      TASK_ID: task.id, PROMPT_B64: Buffer.from(prompt).toString("base64") };
    run = await spawnArm(process.execPath, [SELF, "--pi-worker"], { cwd: ws, env, logPaths, timeoutMs: CEILING_MS });
    const marker = run.stdout.split("\n").filter((l) => l.startsWith("PI_RESULT ")).at(-1);
    let worker = null;
    if (marker) { try { worker = JSON.parse(marker.slice("PI_RESULT ".length)); } catch {} }
    record = worker?.record ?? null;
    rec.harness = worker
      ? { errors: worker.error ? [worker.error] : [], records: worker.records, tool_calls: record?.execution?.tool_calls ?? null, invalid_counts: false, delegation_suspected: false, exit: run.code, signal: run.signal, timed_out: run.timedOut, spawn_error: run.spawnError, wall_ms: run.wallMs }
      : { errors: [run.spawnError ?? (run.timedOut ? "timed out" : "no PI_RESULT marker")], records: 0, tool_calls: null, invalid_counts: false, delegation_suspected: false, exit: run.code, signal: run.signal, timed_out: run.timedOut, spawn_error: run.spawnError, wall_ms: run.wallMs };
    const cost = record?.cost?.api_usd;
    const usage = record?.usage;
    if (typeof usage?.input_tokens === "number") rec.usage = usage;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) rec.model_cost_usd = cost;
    // Only LeanPi runs the JEV classifier; stock Pi has none, so its extra cost
    // is a measured zero rather than an assumed one.
    const jev = jevClassCost(ws);
    rec.classifier = jev;
    rec.classifier_cost_usd = jev.usd;
    rec.delegated_cost_usd = 0;
  }

  const failed = run.spawnError || run.timedOut || (record === null && rec.usage === null && arm !== "codex" && arm !== "claude-code");
  rec.protected_files_unchanged = ["test.js", "package.json"].every((name) => shaFile(join(ws, name)) === shaFile(join(FIXTURE, name)));
  if (!failed) {
    cpSync(GOLD, join(ws, "test.js"));
    const acc = runAccept(ws); // hidden golden installed only now, after the arm
    rec.external_golden = { status: acc.status, passed: acc.passed, failed: acc.failed, verified: acc.status === 0 && acc.passed === 25, tail: acc.out.slice(-800) };
  } else {
    rec.external_golden = null;
  }
  rec.status = run.spawnError ? "error" : run.timedOut ? "timeout" : rec.harness?.invalid_counts ? "invalid"
    : !rec.protected_files_unchanged ? "invalid" : rec.external_golden?.verified ? "passed" : (record || rec.usage ? "failed" : "error");
  rec.wall_ms = run.wallMs;
  rec.finished_at = new Date().toISOString();
  if (existsSync(join(ws, "index.js"))) rec.end_index_sha256 = shaFile(join(ws, "index.js"));
  writeFileSync(join(dir, "result.json"), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

const spend = (r) => (typeof r.model_cost_usd === "number" ? r.model_cost_usd : 0) + (typeof r.classifier_cost_usd === "number" ? r.classifier_cost_usd : 0);

async function runAll(trials) {
  const proof = JSON.parse(readFileSync(join(OUT, "preflight/acceptance.json"), "utf8"));
  assert(proof.hashes.gold_sha256 === shaFile(GOLD)
    && proof.hashes.fixture_index_sha256 === shaFile(join(FIXTURE, "index.js"))
    && Object.values(proof.base.checks).every(Boolean)
    && Object.values(proof.good.checks).every(Boolean), "offline acceptance preflight must still match");
  const task = readTask();
  const results = [];
  let total = 0;
  outer:
  for (let trial = 1; trial <= trials; trial++) {
    for (const arm of ARMS) {
      if (total > TOTAL_GUARD_USD) { results.push({ arm, trial, skipped: true, reason: `run spend $${total.toFixed(6)} exceeds guard $${TOTAL_GUARD_USD}` }); break outer; }
      // Already-paid attempts are reused rather than re-billed, so widening
      // --trials after a smoke run costs only the new trials.
      const done = join(OUT, "attempts", `${arm}-r${trial}`, "result.json");
      if (existsSync(done)) {
        const prev = JSON.parse(readFileSync(done, "utf8"));
        total += spend(prev); results.push(prev);
        console.log(`  ${arm} r${trial}: ${prev.status} $${spend(prev).toFixed(6)} ${(prev.wall_ms / 1000).toFixed(1)}s (reused)`);
        continue;
      }
      const r = await runArm(arm, task, trial);
      const s = spend(r);
      if (s > SPEND_GUARD_USD) { results.push(r); results.push({ arm, trial, skipped: true, reason: `arm spend $${s.toFixed(6)} exceeds per-arm guard $${SPEND_GUARD_USD}` }); break outer; }
      total += s;
      results.push(r);
      console.log(`  ${arm} r${trial}: ${r.status} $${s.toFixed(6)} ${(r.wall_ms / 1000).toFixed(1)}s`);
    }
  }
  const attempts = results.filter((r) => !r.skipped).map((r) => ({
    task: r.task, arm: r.arm, trial: r.trial, status: r.status,
    cost_usd: { model: r.model_cost_usd ?? null, classifier: r.classifier_cost_usd ?? null, delegated: r.delegated_cost_usd ?? null, other: r.other_cost_usd ?? 0 },
    seconds: r.wall_ms / 1000,
  }));
  const parity = {
    parity_verified: false,
    parity_evidence: "Same provider, same model id, same prompt bytes and same acceptance test for all four arms. Request-level reasoning settings are NOT normalised across harnesses (Codex reasoning.effort=medium; Claude Code MAX_THINKING_TOKENS=8000; LeanPi/stock Pi use their own defaults), and there is no upstream attestation that the gateway converts the OpenAI and Anthropic wire formats equivalently.",
  };
  const report = {
    generated_at: new Date().toISOString(), model: MODEL, provider: PROVIDER, base_url: BASE_URL,
    leanpi_build: buildProvenance(),
    rates_usd_per_mtok: RATES, arms: ARMS, trials,
    fixture: FIXTURE, gold_sha256: shaFile(GOLD), summarize_input: "summary-input.json",
    total_spend_usd: total, ...parity, results,
  };
  // A run that reused every paid attempt makes no new API call but still has a
  // report to write, so the guard is "there is something to report", not "this
  // invocation spent". The preflight path asserts `apiCalls === 0` separately.
  assert(attempts.length > 0, "a run must report at least one attempt");
  writeFileSync(join(OUT, "result.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(OUT, "summary-input.json"), JSON.stringify({ ...parity, attempts }, null, 2) + "\n");
  console.log(`RUN DONE attempts=${attempts.length} spend=$${total.toFixed(6)} statuses=${attempts.map((a) => `${a.arm}r${a.trial}:${a.status}`).join(" ")}`);
}

// ---------- Pi child worker (leanpi | stock-pi) ----------
/**
 * Every tool call an arm made, in order, with a one-line input summary.
 *
 * The §52 record only counts tool calls; the names live in the session's own
 * message list and are gone when the process exits. Without this trace the
 * "LeanPi takes 22.8 calls to stock Pi's 18.2" gap cannot be attributed to a
 * tool, only observed. Cheap enough to leave on: it is read from memory after
 * the turn, never sent to the model.
 */
function toolCallTrace(session) {
  const calls = [];
  for (const message of session?.messages ?? []) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "toolCall") continue;
      const input = part.input ?? part.arguments ?? {};
      calls.push({
        name: String(part.name ?? part.toolName ?? "?"),
        input: (typeof input === "string" ? input : JSON.stringify(input ?? {})).slice(0, 240),
      });
    }
  }
  return calls;
}

async function piWorker() {
  const arm = process.env.ARM;
  const ws = process.env.WORKSPACE, agentDir = process.env.AGENT_DIR, telemetryPath = process.env.TELEMETRY_PATH;
  const sessionId = process.env.SESSION_ID, telemetryTaskId = process.env.TELEMETRY_TASK_ID;
  const prompt = Buffer.from(process.env.PROMPT_B64, "base64").toString("utf8");
  process.env.LEANPI_OPENCODE_SESSION = sessionId; // must exist before loadConfig/activate resolves the header name
  const out = { error: null, record: null, records: 0 };
  try {
    const { loadConfig } = await import(pathToFileURL(join(SNAP, "core/config.js")).href);
    const config = loadConfig(ROOT, {}, process.env);
    // leanpi.config.yaml pins the `specialist` role to the `codex` backend
    // (type: external_harness, no baseUrl). Booting a session registers every
    // role, so that pin aborts both Pi arms before the task starts. The
    // benchmark measures one executor model, so drop every role that is not
    // served by a reachable native backend rather than editing repo config.
    const reachable = new Set(Object.entries(config.backends)
      .filter(([, b]) => b?.type === "native" && typeof b.baseUrl === "string")
      .map(([name]) => name));
    for (const [role, entry] of Object.entries(config.models)) {
      if (entry && typeof entry === "object" && "backend" in entry && !reachable.has(entry.backend)) delete config.models[role];
    }
    for (const name of Object.keys(config.backends)) if (!reachable.has(name)) delete config.backends[name];
    if (config.capability?.roles) {
      for (const role of Object.keys(config.capability.roles)) if (!(role in config.models)) delete config.capability.roles[role];
    }
    assert(Object.values(config.models).some((e) => e?.model === MODEL), `config must still bind ${MODEL} after pruning unreachable backends`);
    const { stockPiAttempt, leanPiAttempt } = await import(pathToFileURL(join(SNAP, "bench/adapters.js")).href);
    const row = arm === "leanpi"
      ? { id: "leanpi-flash", label: "LeanPi on DeepSeek v4.1 Flash", adapter: "leanpi", jev: "enabled", executor_model: MODEL, budget_usd: SPEND_GUARD_USD,
          features: ["jev", "context-engine", "skill-selection", "mcp-disclosure", "lsp", "verification"] }
      : { id: "stock-pi", label: "Stock Pi on DeepSeek v4.1 Flash", adapter: "stock-pi", jev: "disabled", executor_model: MODEL, budget_usd: SPEND_GUARD_USD, features: [] };
    const attempt = { task: { id: process.env.TASK_ID, prompt }, config: row, workspace: ws, session_id: `${sessionId}:${arm}`, telemetry_task_id: telemetryTaskId, telemetry_path: telemetryPath };
    // The session is held here only so the tool-call trace can be read after the
    // turn. Both factories below are byte-for-byte the adapters' own defaults;
    // the capture adds a reference, it changes nothing the model sees.
    let leanSession = null, stockSession = null;
    const executor = arm === "leanpi"
      ? leanPiAttempt({
          config, timeoutMs: CEILING_MS,
          session: async (att, cfg) => {
            const { createLeanPiSession } = await import(pathToFileURL(join(SNAP, "index.js")).href);
            const booted = await createLeanPiSession({ cwd: att.workspace, agentDir, config: cfg });
            leanSession = booted.session;
            return booted;
          },
          verdict: async () => ({ verdict: "not_run", kind: "upstream-test", adjudicator: "external", reason: "adjudicated externally after run", rubric_model: null, reviewer_model: null }),
        })
      : stockPiAttempt({ config, agentDir, env: process.env, session: async (_att, services) => {
          const { createAgentSessionFromServices, SessionManager } = await import("@earendil-works/pi-coding-agent");
          // Same resolution `stockPiAttempt` performs before its default session:
          // role bindings only, never the `specialists` map (FR-047).
          const roles = ["quick", "balanced", "strong", "specialist", "review_quick", "review_strong"];
          const bindings = Object.entries(config.models).filter(([role, entry]) => roles.includes(role) && entry !== undefined).map(([, entry]) => entry);
          const declared = bindings.find((entry) => entry.model === MODEL) ?? bindings[0];
          const model = services.modelRuntime.getModel(declared.backend, declared.model);
          stockSession = (await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(), model })).session;
          return stockSession;
        } });
    try { await executor(attempt); } catch (e) { out.error = String(e?.message ?? e).slice(0, 300); }
    try {
      const calls = toolCallTrace(arm === "leanpi" ? leanSession : stockSession);
      writeFileSync(join(dirname(telemetryPath), "toolcalls.json"), JSON.stringify({ arm, calls }, null, 2) + "\n");
    } catch (e) { out.error = out.error ?? `tool trace failed: ${String(e?.message ?? e).slice(0, 200)}`; }
    if (existsSync(telemetryPath)) {
      const rows = readFileSync(telemetryPath, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((r) => r.task_id === telemetryTaskId);
      out.records = rows.length; out.record = rows.at(-1) ?? null;
    }
  } catch (e) {
    out.error = String(e?.stack ?? e?.message ?? e).slice(0, 600);
  }
  process.stdout.write(`\nPI_RESULT ${JSON.stringify(out)}\n`);
}

// ---------- entry ----------
if (process.argv.includes("--pi-worker")) await piWorker();
else if (process.argv.includes("--run")) {
  const i = process.argv.indexOf("--trials");
  await runAll(i >= 0 ? Number(process.argv[i + 1]) : 1);
} else await preflight();
