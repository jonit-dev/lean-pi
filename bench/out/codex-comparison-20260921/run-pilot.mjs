#!/usr/bin/env node
/**
 * Bounded pilot driver: Codex CLI vs LeanPI on opencode-go/deepseek-v4.1-flash.
 *
 * OWNS only bench/out/codex-comparison-20260921. Default mode is `--preflight`
 * (offline, no model calls). `--run` is the only spending mode and runs exactly
 * one pair, codex then leanpi; it is never launched without review.
 *
 * Both arms get the same task text + constraints, a 180s process-group ceiling
 * with stdout/stderr streamed to files (partial logs survive a kill), and an
 * external golden evaluation after the arm. No retries, no fallback, no
 * reviewer, no subagents. Parity is request-level only and never attested here.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = "/home/joao/projects/lean-pi";
const OUT = join(ROOT, "bench/out/codex-comparison-20260921");
const REUSE = join(ROOT, "bench/out/real-session-audit-20260921");
const SNAP = join(REUSE, "runtime/dist");
const FIXTURE = join(REUSE, "fixtures/slugify-counter-duplicate-slug");
const GOOD_WS = join(REUSE, "out/audit-slugify-leanpi-r1-1790018482366/workspaces/slugify-counter-duplicate-slug");
const GOLD = join(GOOD_WS, "test.js");
const KNOWNGOOD = join(GOOD_WS, "index.js");
const TASK_YAML = join(ROOT, "bench/suites/validated/slugify-counter-duplicate-slug/task.yaml");
const CODEX_HOME = join(OUT, "codex-home");
const MODEL = "deepseek-v4.1-flash";
const PROVIDER = "opencode-go";
const CEILING_MS = 180_000;
const SPEND_GUARD_USD = 0.25;
// Off-peak rate card verified by the parent at https://opencode.ai/docs/go/#usage-limits.
const RATES = { input: 0.15, cached: 0.003, output: 0.6, jev: 0.042 };
const ACCEPT = ["./node_modules/ava/entrypoints/cli.mjs", "test.js"];
const GOLD_SHA = "980861781f5c5d735d3b7b6d78eec4f49e02164ed98fecf4e96a04e2756199ea";
const FIXTURE_COMMIT = "2acf5b3cadf7faed3928536d051104502ae2b667";
const BASE_FAIL_LINE = "test.js:270";
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

const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const shaText = (t) => createHash("sha256").update(t).digest("hex");
const copyFixture = (dest) => { rmSync(dest, { recursive: true, force: true }); mkdirSync(dest, { recursive: true }); cpSync(FIXTURE, dest, { recursive: true, verbatimSymlinks: true }); };
const { parse: parseYaml } = await import(join(ROOT, "node_modules/yaml/dist/index.js"));
const readTask = () => parseYaml(readFileSync(TASK_YAML, "utf8"));
const fullPrompt = (task) => `${task.prompt}\n\nConstraints:\n${CONSTRAINTS}`;

function assert(ok, msg) { if (!ok) throw new Error(`assert failed: ${msg}`); }

function runAccept(ws) {
  const r = spawnSync(process.execPath, ACCEPT, { cwd: ws, encoding: "utf8", timeout: CEILING_MS, maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const p = (out.match(/(\d+)\s+tests?\s+passed/) ?? [])[1];
  const f = (out.match(/(\d+)\s+tests?\s+failed/) ?? [])[1];
  return { status: r.status, passed: p ? Number(p) : null, failed: f ? Number(f) : null, out };
}

// ---------- cost mapping (asserted offline) ----------
function codexCost(u) {
  for (const k of ["input_tokens", "cached_input_tokens", "output_tokens"]) {
    const v = u?.[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`invalid usage ${k}=${v}`);
  }
  const uncached = u.input_tokens - u.cached_input_tokens;
  if (uncached < 0) throw new Error("cached_input_tokens exceeds input_tokens");
  return (uncached * RATES.input + u.cached_input_tokens * RATES.cached + u.output_tokens * RATES.output) / 1e6;
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
  assert(Math.abs(codexCost({ input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 0 }) - 0.15) < 1e-12, "codex input rate");
  assert(Math.abs(codexCost({ input_tokens: 1_000_000, cached_input_tokens: 1_000_000, output_tokens: 0 }) - 0.003) < 1e-12, "codex cached rate");
  assert(Math.abs(codexCost({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 1_000_000 }) - 0.6) < 1e-12, "codex output rate");
  // cached is a subset: 400k cached of 1M input -> 600k*.15 + 400k*.003
  assert(Math.abs(codexCost({ input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 0 }) - (0.09 + 0.0012)) < 1e-12, "codex cached subset");
  for (const bad of [{ input_tokens: -1, cached_input_tokens: 0, output_tokens: 0 }, { input_tokens: 1, cached_input_tokens: 2, output_tokens: 0 }]) {
    let threw = false; try { codexCost(bad); } catch { threw = true; } assert(threw, `codex rejects ${JSON.stringify(bad)}`);
  }
  assert(Math.abs((1_000_000 * RATES.jev) / 1e6 - 0.042) < 1e-12, "jev rate");
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

  selfTestCosts();
  const report = {
    mode: "preflight", generated_at: new Date().toISOString(), model: MODEL, provider: PROVIDER,
    fixture: FIXTURE, fixture_commit: fixtureCommit, fixture_commit_ok: fixtureCommit === FIXTURE_COMMIT,
    acceptance_command: `node ${ACCEPT.join(" ")}`,
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
  assert(Object.values(baseChecks).every(Boolean), "base must fail the duplicate-slug assertion at test.js:270");
  assert(Object.values(goodChecks).every(Boolean), "known-good source must pass exactly 25");
  assert(apiCalls === 0, "--preflight must make no API calls");
  mkdirSync(join(OUT, "preflight"), { recursive: true });
  writeFileSync(join(OUT, "preflight", "acceptance.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`PREFLIGHT PASS base(fail@${BASE_FAIL_LINE}) good(${goodRes.passed}/25) api_calls=${apiCalls}`);
  console.log(JSON.stringify(report.hashes, null, 2));
}

// ---------- paid run (one pair; never invoked by the repair) ----------
async function runArm(arm, task) {
  const dir = join(OUT, "attempts", arm);
  mkdirSync(dir, { recursive: true });
  assert(!existsSync(join(dir, "result.json")), "refuse to overwrite a previous paid attempt");
  const ws = join(dir, "workspace");
  copyFixture(ws);
  const startedAt = new Date().toISOString();
  const prompt = fullPrompt(task);
  const session = `${arm}-${randomUUID()}`;
  const logPaths = { stdout: join(dir, "stdout.log"), stderr: join(dir, "stderr.log") };
  const rec = {
    arm, task: task.id, model: MODEL, provider: PROVIDER, session_uuid: session,
    started_at: startedAt, ceiling_ms: CEILING_MS,
    start_hashes: { fixture_index_sha256: shaFile(join(FIXTURE, "index.js")), prompt_sha256: shaText(prompt) },
    usage: null, model_cost_usd: null, classifier_cost_usd: null, delegated_cost_usd: 0, other_cost_usd: 0,
  };
  let run, record = null;

  if (arm === "codex") {
    rec.classifier_cost_usd = 0;
    const env = { ...process.env, CODEX_HOME, LEANPI_OPENCODE_SESSION: session };
    const args = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C", ws,
      "-o", join(dir, "answer.txt"), "-c", "model_provider=opencode-go", "-c", "approval_policy=never", "-m", MODEL, prompt];
    run = await spawnArm("codex", args, { cwd: ws, env, logPaths, timeoutMs: CEILING_MS });
    const p = parseCodex(run.stdout);
    rec.codex = { turns: p.turns, items: p.items, tool_calls: p.tools, errors: p.errors, invalid_counts: p.invalid, delegation_suspected: p.delegation, exit: run.code, signal: run.signal, timed_out: run.timedOut, spawn_error: run.spawnError, wall_ms: run.wallMs };
    if (p.completed && !p.invalid) { rec.usage = p.usage; rec.model_cost_usd = codexCost(p.usage); }
    if (p.delegation) rec.delegated_cost_usd = null;
  } else {
    const agentDir = join(dir, "agentdir");
    rmSync(agentDir, { recursive: true, force: true }); mkdirSync(agentDir, { recursive: true });
    assert(readdirSync(agentDir).length === 0, "leanpi agentDir must start empty");
    const telemetryPath = join(dir, "telemetry.jsonl");
    const telemetryTaskId = `codex-pilot:${task.id}:leanpi`;
    const env = { ...process.env, LEANPI_OPENCODE_SESSION: session, WORKSPACE: ws, AGENT_DIR: agentDir,
      TELEMETRY_PATH: telemetryPath, SESSION_ID: session, TELEMETRY_TASK_ID: telemetryTaskId,
      TASK_ID: task.id, PROMPT_B64: Buffer.from(prompt).toString("base64") };
    run = await spawnArm(process.execPath, [SELF, "--leanpi-worker"], { cwd: ws, env, logPaths, timeoutMs: CEILING_MS });
    const marker = run.stdout.split("\n").filter((l) => l.startsWith("LEANPI_RESULT ")).at(-1);
    let worker = null;
    if (marker) { try { worker = JSON.parse(marker.slice("LEANPI_RESULT ".length)); } catch {} }
    record = worker?.record ?? null;
    rec.worker = worker ? { error: worker.error, records: worker.records, tool_calls: record?.execution?.tool_calls ?? null } : null;
    if (!worker && !run.spawnError && !run.timedOut) rec.worker = { error: "no LEANPI_RESULT marker", records: 0 };
    const cost = record?.cost?.api_usd;
    const usage = record?.usage;
    if (typeof usage?.input_tokens === "number") rec.usage = usage;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) rec.model_cost_usd = cost;
    const jev = jevClassCost(ws);
    rec.classifier = jev;
    rec.classifier_cost_usd = jev.usd; // null when the decisions schema was unreadable
    rec.delegated_cost_usd = 0;
  }

  const failed = run.spawnError || run.timedOut || (arm === "leanpi" && rec.worker?.error && !record);
  rec.protected_files_unchanged = ["test.js", "package.json"].every((name) => shaFile(join(ws, name)) === shaFile(join(FIXTURE, name)));
  if (!failed) {
    cpSync(GOLD, join(ws, "test.js"));
    const acc = runAccept(ws); // hidden golden installed only now, after the arm
    rec.external_golden = { status: acc.status, passed: acc.passed, failed: acc.failed, verified: acc.status === 0 && acc.passed === 25, tail: acc.out.slice(-800) };
  } else {
    rec.external_golden = null;
  }
  rec.status = run.spawnError ? "error" : run.timedOut ? "timeout" : rec.codex?.invalid_counts ? "invalid"
    : !rec.protected_files_unchanged ? "invalid" : rec.external_golden?.verified ? "passed" : (record || rec.usage ? "failed" : "error");
  rec.wall_ms = run.wallMs;
  rec.finished_at = new Date().toISOString();
  if (existsSync(join(ws, "index.js"))) rec.end_index_sha256 = shaFile(join(ws, "index.js"));
  writeFileSync(join(dir, "result.json"), JSON.stringify(rec, null, 2) + "\n");
  return rec;
}

async function runPair() {
  const proof = JSON.parse(readFileSync(join(OUT, "preflight/acceptance.json"), "utf8"));
  assert(proof.hashes.gold_sha256 === shaFile(GOLD) && proof.hashes.fixture_index_sha256 === shaFile(join(FIXTURE, "index.js")) && Object.values(proof.base.checks).every(Boolean) && Object.values(proof.good.checks).every(Boolean), "offline acceptance preflight must still match");
  const task = readTask();
  const results = [];
  for (const arm of ["codex", "leanpi"]) {
    if (arm === "leanpi") {
      const prev = results[0];
      if (prev && typeof prev.model_cost_usd === "number" && prev.model_cost_usd > SPEND_GUARD_USD) {
        results.push({ arm: "leanpi", skipped: true, reason: `codex spend $${prev.model_cost_usd.toFixed(6)} exceeds guard $${SPEND_GUARD_USD}` });
        break;
      }
    }
    results.push(await runArm(arm, task));
  }
  const attempts = results.filter((r) => !r.skipped).map((r) => ({
    task: r.task, arm: r.arm, trial: 1, status: r.status,
    cost_usd: { model: r.model_cost_usd ?? null, classifier: r.classifier_cost_usd ?? null, delegated: r.delegated_cost_usd ?? null, other: r.other_cost_usd ?? 0 },
    seconds: r.wall_ms / 1000,
  }));
  const parity = {
    parity_verified: false,
    parity_evidence: "Request-level match only (offline 400 listener): both arms observed reasoning enabled at medium (Codex reasoning.effort=medium; LeanPI thinking.type=enabled, reasoning_effort=medium). API conversion equivalence is unverified and there is no upstream attestation.",
  };
  const report = {
    generated_at: new Date().toISOString(), model: MODEL, provider: PROVIDER, rates_usd_per_mtok: RATES,
    fixture: FIXTURE, gold_sha256: shaFile(GOLD), summarize_input: "summary-input.json", ...parity, results,
  };
  assert(apiCalls > 0, "a run must have made model calls");
  writeFileSync(join(OUT, "result.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(OUT, "summary-input.json"), JSON.stringify({ ...parity, attempts }, null, 2) + "\n");
  console.log(`RUN DONE attempts=${attempts.length} statuses=${attempts.map((a) => `${a.arm}:${a.status}`).join(" ")}`);
}

// ---------- LeanPI child worker ----------
async function leanPiWorker() {
  const ws = process.env.WORKSPACE, agentDir = process.env.AGENT_DIR, telemetryPath = process.env.TELEMETRY_PATH;
  const sessionId = process.env.SESSION_ID, telemetryTaskId = process.env.TELEMETRY_TASK_ID;
  const prompt = Buffer.from(process.env.PROMPT_B64, "base64").toString("utf8");
  process.env.LEANPI_OPENCODE_SESSION = sessionId; // must exist before loadConfig/activate resolves the header name
  const out = { error: null, record: null, records: 0 };
  try {
    const { loadConfig } = await import(pathToFileURL(join(SNAP, "core/config.js")).href);
    const config = loadConfig(ROOT, {}, process.env);
    const { createLeanPiSession } = await import(pathToFileURL(join(SNAP, "index.js")).href);
    const { leanPiAttempt } = await import(pathToFileURL(join(SNAP, "bench/adapters.js")).href);
    const row = { id: "leanpi-flash", label: "LeanPI JEV on DeepSeek v4.1 Flash", adapter: "leanpi", jev: "enabled", executor_model: MODEL, budget_usd: SPEND_GUARD_USD };
    const attempt = { task: { id: process.env.TASK_ID, prompt }, config: row, workspace: ws, session_id: `${sessionId}:leanpi`, telemetry_task_id: telemetryTaskId, telemetry_path: telemetryPath };
    const executor = leanPiAttempt({
      config,
      timeoutMs: CEILING_MS,
      session: async (att, cfg) => createLeanPiSession({ cwd: att.workspace, agentDir, config: cfg }),
      verdict: async () => ({ verdict: "not_run", kind: "upstream-test", adjudicator: "external", reason: "adjudicated externally after run", rubric_model: null, reviewer_model: null }),
    });
    try { await executor(attempt); } catch (e) { out.error = String(e?.message ?? e).slice(0, 300); }
    if (existsSync(telemetryPath)) {
      const rows = readFileSync(telemetryPath, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((r) => r.task_id === telemetryTaskId);
      out.records = rows.length; out.record = rows.at(-1) ?? null;
    }
  } catch (e) {
    out.error = String(e?.stack ?? e?.message ?? e).slice(0, 600);
  }
  process.stdout.write(`\nLEANPI_RESULT ${JSON.stringify(out)}\n`);
}

// ---------- entry ----------
if (process.argv.includes("--leanpi-worker")) await leanPiWorker();
else if (process.argv.includes("--run")) await runPair();
else await preflight();
