/**
 * Scratch paired pilot driver — same-model LeanPi vs stock Pi.
 *
 * Owned artifact of the real-session audit. It reuses the compiled bench
 * runner/adjudicator (snapshotted under ./runtime/dist so the candidate cannot
 * change mid-pilot) and a patched scratch stock-pi adapter that preserves the
 * provider's headers/compat/cost for the opencode-go endpoint.
 *
 * Usage: node run-pilot.mjs <slugify|express> [repeats]
 */
import { cpSync, mkdirSync, readFileSync, rmSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = "/home/joao/projects/lean-pi";
const { runBench } = await import(join(HERE, "runtime/dist/bench/runner.js"));
const { loadConfig } = await import(join(HERE, "runtime/dist/core/config.js"));
const { leanPiSessionFactory } = await import(join(HERE, "runtime/dist/bench/lane.js"));

// --- env: load .env by parsing KEY=VALUE, never eval/echo a secret -------------
for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const TASKS = {
  slugify: { suite: "suites/slugify", id: "slugify-counter-duplicate-slug" },
  express: { suite: "suites/express", id: "express-send-transfer-encoding-etag" },
};
const ARMS = [
  { config: "leanpi-flash", tag: "leanpi" },
  { config: "stock-pi-deepseek", tag: "stock" },
];
const RATES = { input: 0.15, output: 0.6, cacheRead: 0.003, jev: 0.042 }; // USD / Mtok
const ATTEMPT_CEILING_MS = 180_000;
const TOTAL_BUDGET_USD = 1.0;

const taskKey = process.argv[2];
const repeats = Number(process.argv[3] ?? 2);
if (!TASKS[taskKey]) throw new Error(`unknown task "${taskKey}"`);
const task = TASKS[taskKey];
const taskDir = join(ROOT, "bench/suites/seed", task.id);
const fixture = join(HERE, "fixtures", task.id);

// --- provenance: identical start snapshot + model/option facts ----------------
function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function gitOut(args) {
  return execFileSync("git", ["-C", fixture, ...args], { encoding: "utf8" }).trim();
}
const sourceFacts = {
  fixture: fixture,
  commit: gitOut(["rev-parse", "HEAD"]),
  tree_hash: gitOut(["ls-files", "-s"]).split("\n").sort().join("\n"),
  task_yaml_sha256: hashFile(join(taskDir, "task.yaml")),
};
sourceFacts.tree_hash = createHash("sha256").update(sourceFacts.tree_hash).digest("hex");

const config = loadConfig(ROOT, {}, process.env);
config.bench = { ...(config.bench ?? {}), leanpiTimeoutMs: ATTEMPT_CEILING_MS, goldenTimeoutMs: ATTEMPT_CEILING_MS };
const backend = config.backends["opencode-go"];
const modelFacts = {
  provider: "opencode-go",
  model: config.models.balanced?.model,
  baseUrl: backend?.baseUrl,
  api: backend?.api,
  thinkingFormat: backend?.compat?.thinkingFormat ?? null,
  headerKeys: Object.keys(backend?.headers ?? {}),
  contextWindow: backend?.contextWindow,
  maxTokens: backend?.maxTokens,
  rates: RATES,
  leanpiThinkingLevel: "medium (Pi default, unset in config)",
  stockThinkingLevel: "medium (explicit, scratch adapter)",
  hasApiKey: typeof backend?.apiKey === "string" && backend.apiKey.length > 0,
};
// The stock arm's models.json, as the patched adapter will write it (no secret).
function stockModelsShape(cfg) {
  const out = {};
  for (const [name, b] of Object.entries(cfg.backends)) {
    if (b.type !== "native" || typeof b.baseUrl !== "string") continue;
    const models = Object.entries(cfg.models)
      .filter(([role, e]) => ["quick", "balanced", "strong", "specialist", "review_quick", "review_strong"].includes(role) && e?.backend === name)
      .map(([, e]) => ({ id: e.model, reasoning: b.reasoning, contextWindow: b.contextWindow, maxTokens: b.maxTokens, cost: b.cost }));
    if (!models.length) continue;
    out[name] = { baseUrl: b.baseUrl, api: b.api ?? "openai-completions", headers: b.headers, compat: b.compat, hasApiKey: typeof b.apiKey === "string" && b.apiKey.length > 0, models };
  }
  return out;
}
modelFacts.stockModelsJsonShape = stockModelsShape(config);
modelFacts.leanpiModels = Object.entries(config.models).map(([role, e]) => ({ role, backend: e.backend, model: e.model }));

// --- prepare: copy the frozen fixture into each attempt's workspace -----------
function prepare(candidate, runDir) {
  const dir = join(runDir, "workspaces", candidate.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  cpSync(fixture, dir, { recursive: true });
  return { dir, cleanup() {} };
}

const rows = [];
const logLines = [];
function log(text) {
  const line = `[${new Date().toISOString()}] ${text}`;
  logLines.push(line);
  console.log(line);
  appendFileSync(join(HERE, "logs", `exec-${taskKey}.log`), `${line}\n`);
}
function priceOf(usage) {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cached = usage.cached_input_tokens ?? 0;
  const jev = usage.jev_tokens ?? 0;
  return (input * RATES.input + output * RATES.output + cached * RATES.cacheRead + jev * RATES.jev) / 1e6;
}
function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const schedule = [];
for (let r = 1; r <= repeats; r += 1) {
  const order = r % 2 === 1 ? ARMS : [...ARMS].reverse();
  for (const arm of order) schedule.push({ repeat: r, arm });
}

log(`task=${task.id} fixture=${sourceFacts.commit} tree=${sourceFacts.tree_hash.slice(0, 12)} repeats=${repeats}`);
log(`model=${modelFacts.model} provider=${modelFacts.provider} thinkingFormat=${modelFacts.thinkingFormat} headers=[${modelFacts.headerKeys}] ctx=${modelFacts.contextWindow} maxTokens=${modelFacts.maxTokens}`);
log(`schedule=${schedule.map((s) => `${s.arm.tag}:r${s.repeat}`).join(" ")}`);

let spent = 0;
for (const [i, step] of schedule.entries()) {
  const arm = step.arm;
  const stamp = Date.now();
  const session = `real-session-audit-${taskKey}-${arm.tag}-r${step.repeat}-${stamp}`;
  process.env.LEANPI_OPENCODE_SESSION = session;
  const runId = `audit-${taskKey}-${arm.tag}-r${step.repeat}-${stamp}`;
  log(`attempt ${i + 1}/${schedule.length} arm=${arm.tag} repeat=${step.repeat} runId=${runId} session=${session}`);
  const started = Date.now();
  let status = "ok";
  let run = null;
  try {
    run = await runBench({
      cwd: ROOT,
      config,
      suiteDir: join(HERE, task.suite),
      configDir: join(HERE, "configs"),
      configIds: [arm.config],
      outDir: join(HERE, "out"),
      runId,
      keepWorkspaces: true,
      prepare,
      adapterDeps: { session: leanPiSessionFactory },
      env: process.env,
    });
  } catch (error) {
    status = "error";
    log(`  ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }
  const wallMs = Date.now() - started;
  if (run) {
    const ledger = readJsonl(run.ledger_path);
    const telemetry = readJsonl(run.telemetry_path);
    const row = ledger[0] ?? {};
    const rec = telemetry[telemetry.length - 1] ?? {};
    const usage = rec.usage ?? {};
    const priced = priceOf(usage);
    spent += priced;
    rows.push({
      task: task.id,
      arm: arm.tag,
      config: arm.config,
      repeat: step.repeat,
      run_id: runId,
      session,
      verdict: row.adjudication?.verdict ?? "missing",
      complete: row.adjudication?.verdict === "complete",
      reported_success: row.reported_success ?? null,
      adjudicator: row.adjudication?.adjudicator ?? null,
      reason: row.adjudication?.reason ?? null,
      wall_ms: rec.execution?.wall_ms ?? null,
      tool_calls: rec.execution?.tool_calls ?? null,
      input_tokens: usage.input_tokens ?? 0,
      cached_input_tokens: usage.cached_input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      reasoning_tokens: usage.reasoning_tokens ?? 0,
      jev_tokens: usage.jev_tokens ?? 0,
      cost_usd_from_rates: Number(priced.toFixed(6)),
      cost_usd_recorded: rec.cost?.effective_cost ?? rec.cost?.api_usd ?? null,
      adapter_note: row.adapter?.note ?? null,
      status,
    });
    log(`  verdict=${rows.at(-1).verdict} wall=${wallMs}ms in=${usage.input_tokens} cache=${usage.cached_input_tokens} out=${usage.output_tokens} reason=${usage.reasoning_tokens} jev=${usage.jev_tokens} cost=$${priced.toFixed(6)}`);
  } else {
    rows.push({ task: task.id, arm: arm.tag, config: arm.config, repeat: step.repeat, run_id: runId, session, status, wall_ms: wallMs });
    log(`  FAILED after ${wallMs}ms (cost-bearing, recorded)`);
  }
  if (spent >= TOTAL_BUDGET_USD) { log(`STOP: budget $${spent.toFixed(4)} >= $${TOTAL_BUDGET_USD}`); break; }
}

const result = { generated_at: new Date().toISOString(), task: task.id, source_facts: sourceFacts, model_facts: modelFacts, rates: RATES, total_spent_usd: Number(spent.toFixed(6)), rows };
writeFileSync(join(HERE, `results-${taskKey}.json`), `${JSON.stringify(result, null, 2)}\n`);
const csvHeader = "task,arm,repeat,run_id,status,verdict,complete,wall_ms,tool_calls,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,jev_tokens,cost_usd_from_rates,cost_usd_recorded";
const csv = [csvHeader, ...rows.map((r) => [r.task, r.arm, r.repeat, r.run_id, r.status, r.verdict ?? "", r.complete ?? "", r.wall_ms ?? "", r.tool_calls ?? "", r.input_tokens ?? "", r.cached_input_tokens ?? "", r.output_tokens ?? "", r.reasoning_tokens ?? "", r.jev_tokens ?? "", r.cost_usd_from_rates ?? "", r.cost_usd_recorded ?? ""].join(","))].join("\n");
writeFileSync(join(HERE, `results-${taskKey}.csv`), `${csv}\n`);
log(`DONE task=${task.id} attempts=${rows.length} spent=$${spent.toFixed(6)}`);
