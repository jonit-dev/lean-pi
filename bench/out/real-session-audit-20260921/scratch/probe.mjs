import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
const OUT = "/home/joao/projects/lean-pi/bench/out/real-session-audit-20260921";
const SNAP = join(OUT, "scratch/dist-snap");
const { loadConfig } = await import(join(SNAP, "core/config.js"));
const { stockPiExtensions, writeStockPiModels } = await import(join(SNAP, "bench/adapters.js"));
const piAgent = await import("@earendil-works/pi-coding-agent");
const config = loadConfig("/home/joao/projects/lean-pi", {}, process.env);
const dir = join(OUT, "scratch/probe-ws");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const agentDir = join(dir, ".bench-agent");
await stockPiExtensions(dir, agentDir);
writeStockPiModels(config, agentDir);
const services = await piAgent.createAgentSessionServices({ cwd: dir, agentDir, resourceLoaderOptions: { extensionFactories: [] } });
const model = services.modelRuntime.getModel("opencode-go", "deepseek-v4.1-flash");
console.log("model found:", !!model, model?.id ?? null);
const { session } = await piAgent.createAgentSessionFromServices({ services, sessionManager: piAgent.SessionManager.inMemory(), model });
try { session.setThinkingLevel("medium"); } catch (e) { console.log("think set fail:", String(e).slice(0, 120)); }
console.log("thinking:", session.thinkingLevel);
const t0 = Date.now();
const killer = setTimeout(() => { try { session.agent.abort(); } catch {} }, 120_000);
try {
  await session.prompt("Reply with exactly the word PONG and nothing else.");
} catch (e) { console.log("prompt threw:", String(e?.message ?? e).slice(0, 300)); }
clearTimeout(killer);
console.log("wall_s:", Math.round((Date.now() - t0) / 1000), "messages:", session.messages.length);
for (const m of session.messages) {
  console.log("-", m.role ?? "?", JSON.stringify(m.usage ?? null), String(m.content?.[0]?.text ?? m.text ?? JSON.stringify(m.content ?? "").slice(0, 120)).slice(0, 120));
}
