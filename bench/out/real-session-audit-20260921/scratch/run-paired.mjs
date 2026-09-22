/**
 * Scratch paired pilot driver (owned scratch only).
 * Compares LeanPI (full, JEV enabled) vs stock Pi on the SAME model
 * (deepseek-v4.1-flash via opencode-go native endpoint), same task text,
 * same start files, same golden command, alternating order, fresh provider
 * session per attempt, 180s ceiling per model run, max 1 transport retry.
 *
 * Reads: leanpi.config.snap.yaml (frozen copy), task.yaml files (read-only).
 * Writes: only under OUT dir (runs/, templates/, results).
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";

const OUT = "/home/joao/projects/lean-pi/bench/out/real-session-audit-20260921";
const SNAP = join(OUT, "scratch/dist-snap");
const RUNS = join(OUT, "runs");
const TEMPLATES = join(OUT, "templates");
const CEILING_MS = 180_000;
const RATES = { input: 0.15, output: 0.6, cacheRead: 0.003, jev: 0.042 }; // USD per Mtok

const { createLeanPiSession } = await import(join(SNAP, "index.js"));
const { leanPiAttempt, stockPiAttempt, configForRow } = await import(join(SNAP, "bench/adapters.js"));
const { adjudicateAttempt } = await import(join(SNAP, "bench/adjudicate.js"));
const { readDecisions } = await import(join(SNAP, "jev/log.js"));
const piAgent = await import("@earendil-works/pi-coding-agent");

function sh(cmd, cwd, timeoutMs = 120_000) {
  const r = spawnSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, error: r.error?.message ?? null, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-3000) };
}
function shaFile(p) { return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16); }
function priceModel(u) {
  // Same explicit rate card both arms; reasoning is a subset of output already
  // priced at output rate (adapter hands priceCall the non-reasoning remainder).
  return (u.input_tokens * RATES.input + u.cached_input_tokens * RATES.cacheRead + u.output_tokens * RATES.output) / 1e6;
}
function priceJev(inputTokens) { return (inputTokens * RATES.jev) / 1e6; }

const args = process.argv.slice(2);
const taskIds = args.length > 0 ? args : ["slugify-counter-duplicate-slug"];
const repeats = 2;

const config = parseYaml(readFileSync(join(OUT, "scratch/leanpi.config.snap.yaml"), "utf8"));
const rows = [
  { id: "leanpi-same", label: "LeanPI full JEV", adapter: "leanpi", jev: "enabled", executor_model: "deepseek-v4.1-flash", budget_usd: 2 },
  { id: "stock-fixed", label: "Stock Pi same-model", adapter: "stock-pi", jev: "disabled", executor_model: "deepseek-v4.1-flash", budget_usd: 2 },
];
const modelFacts = { backend: "opencode-go", model: "deepseek-v4.1-flash", api: config.backends["opencode-go"].api, thinking: "medium (explicit both arms)", reasoning_dialect: "deepseek" };

function loadTask(taskId) {
  const f = `/home/joao/projects/lean-pi/bench/suites/validated/${taskId}/task.yaml`;
  return { ...parseYaml(readFileSync(f, "utf8")), _file: f };
}

function ensureTemplate(task) {
  const dir = join(TEMPLATES, task.id);
  if (!existsSync(join(dir, ".git"))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(TEMPLATES, { recursive: true });
    console.log(`[tpl] cloning ${task.id}`);
    let r = sh(`git clone --filter=blob:none --no-checkout --quiet ${task.source.repo} ${dir}`, TEMPLATES, 300_000);
    if (r.status !== 0) throw new Error(`clone failed: ${r.out}`);
    r = sh(`git checkout --quiet ${task.source.commit}`, dir, 120_000);
    if (r.status !== 0) throw new Error(`checkout failed: ${r.out}`);
    for (const cmd of task.setup ?? []) {
      console.log(`[tpl] setup: ${cmd}`);
      r = sh(cmd, dir, 600_000);
      if (r.status !== 0) throw new Error(`setup failed: ${cmd}: ${r.out}`);
    }
  }
  return dir;
}

function calibrate(task, tplDir) {
  // Fail-before-fix check on a scratch copy: checkout fix test files, run golden, expect nonzero.
  const cal = join(OUT, "runs", `_calib_${task.id}`);
  rmSync(cal, { recursive: true, force: true });
  mkdirSync(cal, { recursive: true });
  cpSync(tplDir, join(cal, "ws"), { recursive: true });
  const ws = join(cal, "ws");
  const files = (task.golden.files ?? []).join(" ");
  sh(`git checkout --quiet ${task.source.fix_commit} -- ${files}`, ws, 120_000);
  const r = sh(task.golden.command, ws, 300_000);
  const failedBefore = (r.status ?? 1) !== 0;
  rmSync(cal, { recursive: true, force: true });
  return { failedBefore, status: r.status, tail: r.out.slice(-500) };
}

const results = [];
const runId = `pilot-${new Date().toISOString().slice(0, 10)}`;
mkdirSync(RUNS, { recursive: true });

for (const taskId of taskIds) {
  const task = loadTask(taskId);
  const tpl = ensureTemplate(task);
  const cal = calibrate(task, tpl);
  console.log(`[calib] ${task.id}: fails-before-fix=${cal.failedBefore} (status=${cal.status})`);
  if (!cal.failedBefore) console.log(`[calib] WARNING: golden passes on base commit; pair still runs but fix-signal is weak`);
  const tplHash = shaFile(join(tpl, "package.json"));

  // Alternating arm order across repeats: R1 leanpi-first, R2 stock-first
  for (let rep = 1; rep <= repeats; rep++) {
    const order = rep % 2 === 1 ? [rows[0], rows[1]] : [rows[1], rows[0]];
    for (const row of order) {
      const attemptTag = `${taskId}__${row.id}__r${rep}`;
      const ws = join(RUNS, runId, attemptTag);
      rmSync(ws, { recursive: true, force: true });
      mkdirSync(ws, { recursive: true });
      cpSync(tpl, ws, { recursive: true });
      const storePath = join(RUNS, runId, "store.jsonl");
      const sessionId = `${runId}:${row.id}:${taskId}:r${rep}`;
      process.env.LEANPI_OPENCODE_SESSION = `leanpi-pilot-${Date.now()}-${row.id}-r${rep}`;
      const attempt = {
        task: { id: task.id, prompt: task.prompt },
        config: row,
        workspace: ws,
        session_id: sessionId,
        telemetry_task_id: `${taskId}@${row.id}#r${rep}`,
        telemetry_path: storePath,
      };
      const isLean = row.adapter === "leanpi";
      let executor, status = "ok", failReason = null, wallMs = 0, record = null, adjud = null;
      let thinkBefore = null, thinkAfter = null, retries = 0;
      const t0 = Date.now();
      try {
        if (isLean) {
          executor = leanPiAttempt({
            config,
            timeoutMs: CEILING_MS,
            session: async (att, cfg) => {
              const booted = await createLeanPiSession({ cwd: att.workspace, config: cfg });
              try { booted.session.setThinkingLevel("medium"); } catch {}
              thinkBefore = booted.session.thinkingLevel ?? "unknown";
              return booted;
            },
          });
        } else {
          executor = stockPiAttempt({
            config,
            session: async (att, services) => {
              const bindings = Object.entries(config.models).filter(([r]) => ["quick", "balanced", "strong", "specialist", "review_quick", "review_strong"].includes(r));
              const bal = config.models.balanced;
              const model = services.modelRuntime.getModel(bal.backend, row.executor_model);
              const { session } = await piAgent.createAgentSessionFromServices({ services, sessionManager: piAgent.SessionManager.inMemory(), model });
              try { session.setThinkingLevel("medium"); } catch {}
              thinkBefore = session.thinkingLevel ?? "unknown";
              const killer = setTimeout(() => { try { session.agent.abort(); } catch {} }, CEILING_MS);
              killer.unref?.();
              session._pilotKiller = killer;
              return session;
            },
          });
        }
        let execResult;
        for (let t = 0; t <= 1; t++) {
          try { execResult = await executor(attempt); break; }
          catch (e) {
            const msg = String(e?.message ?? e);
            if (t === 0 && /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket|network|fetch failed/i.test(msg)) { retries = 1; continue; }
            throw e;
          }
        }
        wallMs = Date.now() - t0;
        adjud = await adjudicateAttempt({ ...attempt, task }, { base: "/home/joao/projects/lean-pi", config });
      } catch (e) {
        wallMs = Date.now() - t0;
        status = "error";
        failReason = String(e?.message ?? e).slice(0, 300);
      }
      // Read back §52 record joined on telemetry task id
      try {
        const lines = existsSync(storePath) ? readFileSync(storePath, "utf8").trim().split("\n").filter(Boolean) : [];
        const recs = lines.map((l) => JSON.parse(l)).filter((r) => r.task_id === attempt.telemetry_task_id);
        record = recs.at(-1) ?? null;
      } catch {}
      let jevInput = 0;
      try { for (const d of readDecisions(ws)) jevInput += d.input_tokens ?? d.inputTokens ?? 0; } catch {}
      const u = record?.usage ?? {};
      const modelCost = priceModel({ input_tokens: u.input_tokens ?? 0, cached_input_tokens: u.cached_input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 });
      const jevCost = isLean ? priceJev(jevInput) : 0;
      const reported = record?.cost?.effective_cost ?? record?.cost?.total ?? null;
      const row_out = {
        task: taskId, arm: row.id, repeat: rep, status, failReason, wall_ms: wallMs, retries,
        session_id: sessionId, thinking_before: thinkBefore,
        input: u.input_tokens ?? 0, cached: u.cached_input_tokens ?? 0, output: u.output_tokens ?? 0,
        reasoning: u.reasoning_tokens ?? 0, tool_calls: record?.execution?.tool_calls ?? null,
        jev_input_tokens: jevInput, model_cost_usd: +modelCost.toFixed(6), jev_cost_usd: +jevCost.toFixed(6),
        total_cost_usd: +(modelCost + jevCost).toFixed(6), record_cost_usd: reported,
        golden_verdict: adjud?.verdict ?? "error", golden_reason: (adjud?.reason ?? "").slice(0, 200),
        template_pkg_hash: tplHash,
      };
      results.push(row_out);
      writeFileSync(join(RUNS, runId, "results.json"), JSON.stringify({ run_id: runId, modelFacts, rates: RATES, results }, null, 2));
      console.log(`[run] ${attemptTag}: status=${status} verdict=${row_out.golden_verdict} in=${row_out.input} out=${row_out.output} reasoning=${row_out.reasoning} cost=$${row_out.total_cost_usd} wall=${Math.round(wallMs / 1000)}s`);
      if (status === "error" && /exhaust|quota|credit|insufficient/i.test(failReason ?? "")) {
        console.log("[run] credit exhaustion suspected; stopping");
        rep = 99;
        break;
      }
    }
  }
}

// CSV
const cols = Object.keys(results[0] ?? { note: 1 });
const csv = [cols.join(","), ...results.map((r) => cols.map((c) => JSON.stringify(r[c] ?? "")).join(","))].join("\n");
writeFileSync(join(RUNS, runId, "results.csv"), csv + "\n");
console.log(`[done] ${results.length} attempts -> ${join(RUNS, runId, "results.json")}`);
