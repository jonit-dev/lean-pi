import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "parity");
const CODEX_HOME = path.join(HERE, "..", "codex-home");
const WORKSPACE = path.join(HERE, "..", "attempts", "codex", "workspace");
const AGENT_DIR = path.join(OUT, "agentdir");
const MODEL = "deepseek-v4.1-flash";
const MARKERS = [
  ["optional_skills_marker", /SKILL\.md|available skills|skill catalog/i],
  ["agents_marker", /AGENTS\.md|<codex_agent_instructions>/i],
];

fs.mkdirSync(path.join(OUT, "agentdir"), { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });

function scanFlags(text) {
  const flags = {};
  for (const [key, re] of MARKERS) flags[key] = typeof text === "string" && re.test(text);
  return flags;
}

function extract(body) {
  const meta = {
    model: body?.model ?? null,
    reasoning: body?.reasoning ?? null,
    thinking: body?.thinking ?? null,
    reasoning_effort: body?.reasoning_effort ?? null,
    max_output_tokens: body?.max_output_tokens ?? null,
    max_tokens: body?.max_tokens ?? null,
    stream: body?.stream ?? null,
    tool_count: Array.isArray(body?.tools) ? body.tools.length : null,
    tool_names: Array.isArray(body?.tools)
      ? body.tools.map((t) => t?.name ?? t?.function?.name ?? t?.type ?? "?").slice(0, 60)
      : null,
    top_level_keys: body && typeof body === "object" ? Object.keys(body).sort() : null,
  };
  const raw = JSON.stringify(body ?? {});
  Object.assign(meta, scanFlags(raw + "\n" + (body?.instructions ?? "")));
  return meta;
}

function startListener(label) {
  const state = { label, request: null, path: null, headers_observed: null, resolve: null };
  const server = http.createServer((req, res) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      if (!state.request && body) {
        state.request = extract(body);
        state.path = req.url;
        state.headers_observed = {
          content_type: req.headers["content-type"] ?? null,
          accept: req.headers["accept"] ?? null,
          auth_header_present: Boolean(req.headers["authorization"]),
        };
        state.resolve?.();
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "offline parity probe", type: "invalid_request_error" } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.port = server.address().port;
      state.close = () => server.close();
      state.wait = (ms) => new Promise((r) => {
        state.resolve = r;
        setTimeout(r, ms);
      });
      resolve(state);
    });
  });
}

function runCodex(listener) {
  const config = `model = "${MODEL}"
model_provider = "opencode-go"
model_supports_reasoning_summaries = true
model_reasoning_effort = "${process.env.PROBE_EFFORT ?? "none"}"
project_doc_max_bytes = 0

[model_providers.opencode-go]
name = "OpenCode Go Zen (offline probe)"
base_url = "http://127.0.0.1:${listener.port}/v1"
env_key = "OPENCODE_API_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0

[skills]
include_instructions = false
[[skills.config]]
path = "/home/joao/.agents/skills"
enabled = false
[[skills.config]]
path = "/home/joao/.codex/skills"
enabled = false

[projects."${WORKSPACE}"]
trust_level = "trusted"
`;
  fs.writeFileSync(path.join(CODEX_HOME, "config.toml"), config);
  const child = spawn("codex", [
    "exec", "--json", "--ephemeral", "--skip-git-repo-check",
    "--sandbox", "workspace-write", "-C", WORKSPACE, "Reply PONG",
  ], {
    detached: true,
    env: { ...process.env, CODEX_HOME, OPENCODE_API_KEY: "offline-probe-no-remote" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 20000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ exit_code: code, signal, version_line: /codex-cli \S+/.exec(stderr + stdout)?.[0] ?? null });
    });
  });
}

async function runLeanPi(listener) {
  const distDir = "/home/joao/projects/lean-pi/bench/out/real-session-audit-20260921/runtime/dist";
  const { createLeanPiSession } = await import(`file://${distDir}/index.js`);
  const { loadConfig } = await import(`file://${distDir}/core/config.js`);
  const binding = { backend: "native", model: MODEL };
  const config = loadConfig(WORKSPACE, {
    backends: {
      native: {
        type: "native",
        baseUrl: `http://127.0.0.1:${listener.port}/v1`,
        api: "openai-completions",
        apiKey: "offline-probe-no-remote",
        reasoning: true,
        compat: { thinkingFormat: "deepseek" },
      },
    },
    models: { quick: binding, balanced: binding, strong: binding, specialist: binding, review_quick: binding, review_strong: binding },
    jev: { mode: "disabled", apiKey: null },
  });
  const bundle = await createLeanPiSession({ cwd: WORKSPACE, agentDir: AGENT_DIR, config });
  const session = bundle.session;
  session.setThinkingLevel("off");
  let error = null;
  const prompt = session.prompt("Reply PONG").catch((e) => { error = String(e?.message ?? e).slice(0, 200); });
  await Promise.race([prompt, new Promise((r) => setTimeout(r, 20000))]);
  try { session.abort?.(); } catch {}
  try { await bundle.dispose?.(); } catch {}
  return { error };
}

const result = { model: MODEL, generated_at: new Date().toISOString(), codex: null, leanpi: null, limitations: [] };

const codexA = await startListener("codex");
const codexRun = runCodex(codexA);
await codexA.wait(20000);
const codexState = { path: codexA.path, ...codexA.request, http: codexA.headers_observed };
await codexRun;
codexA.close();
result.codex = codexState;
if (!codexA.request) result.limitations.push("Codex: no request body reached localhost listener");

try {
  const leanpiA = await startListener("leanpi");
  const leanpiRun = runLeanPi(leanpiA);
  await Promise.race([leanpiRun, leanpiA.wait(25000)]);
  result.leanpi = { path: leanpiA.path, ...leanpiA.request, http: leanpiA.headers_observed, harness_error: null };
  leanpiA.close();
} catch (e) {
  result.limitations.push("LeanPI: harness init failed — " + String(e?.message ?? e).slice(0, 200));
}

fs.writeFileSync(path.join(OUT, "request-metadata.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
