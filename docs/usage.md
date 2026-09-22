# Using LeanPi

Requires Node 22+ (`engines.node >=22.19.0`); developed and tested on Node 22.
`npx leanpi` is the short path — see the [README](../README.md#quick-start).

**From a checkout (contributors).** Requires `git` too. The published 2026-09-19
benchmark used Node 20; the 2026-09-19 audit smoke-tested this path on Node 22.

```sh
npm install
npm run build
npm link          # puts `leanpi` on PATH
leanpi            # run it anywhere
```

**First run configures itself.** With no `leanpi.config.yaml` anywhere above the
working directory, `leanpi` asks the machine what it has — which vendor CLIs are
installed *and* signed in (`claude auth status`, `codex login status`,
`opencode auth list`), which models those CLIs report, and whether Pi already
holds a provider credential — then writes
`~/.config/leanpi/leanpi.config.yaml` with JEV allocating the six roles over
those models from published capability and price data. It is an ordinary file:
edit it, or delete it to have it written again. No credential is ever written
into it.

Before it writes that file, a first run at a terminal asks the one thing the
machine cannot work out for itself: your JEV key. It is a single masked line,
validated once — press Enter to skip and the run continues on the heuristics,
exactly as it would with no key at all. The answer matters here and nowhere
later: the key decides the role map this same run writes, and that map is never
recomputed. Answer it without a prompt with any of the three ways below.

```
leanpi — tell me your goal, I figure out the rest.
  models   quick opencode-go deepseek-v4.1-flash  ·  balanced codex gpt-6-astra  ·  strong claude opus[1m]
  review   opencode-go deepseek-v4.1-flash → claude opus[1m]
  control  JEV configured (source: env file)
```

While a turn runs, the footer carries the decision it made:
`Auto: opus (1m) (Medium) — MEDIUM complexity — Executor lane`. On a native
backend Pi's own loop is the executor, so LeanPi's verification and proof gate
do not run on that turn and the footer says so — `… — Pi loop — unverified —
/verify` — and `/verify` runs the contract's verifiers and the gate against the
workspace whenever you want the evidence.

LeanPi's commands are ordinary Pi slash commands: `/help` lists them, and
`/status`, `/route`, `/model`, `/context`, `/doctor`, `/config`, `/cost`,
`/skills`, `/mcp`, `/permissions`, `/jev`, `/todo`, `/goal`, `/review`,
`/verify` and `/prd` are all typed into the same prompt as a task.

**The JEV key is optional, and it pays for itself.** The task compiler, the
skill disclosure and the proof gate are JEV decisions; with a key they route on
what a task actually needs. Without one, every site falls back to a
deterministic heuristic — LeanPi still runs, it just routes worse and spends
more tokens per task, and says so on startup. On a first run at a terminal it is
asked for once, before the config is written; answer it up front instead with:

```sh
leanpi --jev-key <key>          # stored at ~/.config/leanpi/credentials.json (0600)
export JEV_API_KEY=<key>        # or this shell
echo 'JEV_API_KEY=<key>' >> .env  # or this project — read, never exported
leanpi --no-jev                 # or skip the control plane deliberately
```

**Or run the control plane locally.** The same typed questions can be answered
by [Laya](https://huggingface.co/convaiinnovations/laya), an Apache-2.0 decision
model that runs on your own machine — no key, no per-token cost, and nothing
leaves the box:

```sh
leanpi --laya                   # this run (`--jev` forces the hosted service)
/jev provider laya              # now and every run after: saved to your user config
/jev provider typesafe          # back to the hosted service, also saved
/jev provider                   # which one is active
```

The switch sets `jev.provider` in `~/.config/leanpi/leanpi.config.yaml`; you can
set it there by hand too. The first-run JEV key prompt still appears when Laya is
selected — press Enter to skip it; Laya needs no key.

Laya is not installed on the first run, so LeanPi provisions it: a Python
environment, `torch` and the model weights (~3 GB) under
`~/.local/share/leanpi/laya`. `/jev setup-laya` does the same ahead of time, and
`jev.laya.autoSetup: false` turns a missing runtime into a clear error instead
of a download.

⚠️ **Laya is a different trade, not a free upgrade.** Measured on 76 labelled
cases drawn from LeanPi's own decision sites (`experiments/laya-vs-jev`), it is
5× faster (p50 19 ms vs 109 ms) and free, but less accurate: `Choice` accuracy
0.612 vs JEV's 0.845, `Score` error 2.3× higher, and its `Score` answers barely
separate a relevant file from an irrelevant one. LeanPi adapts Laya's confidence
to JEV's scale so the answers are usable at all; it does not close the accuracy
gap. Use JEV when the decisions matter most, Laya when they must stay on your
machine or cost nothing.

Tool authorization is per scope (`read`, `edit`, `shell`, `network`, `mcp`,
`external_dir`, `subagent`, `git_destructive`, `package_install`), resolved from
the built-in defaults, your `~/.config/leanpi/permissions.json` and the
project's `permissions:` block, which may only tighten. `/permissions` shows
each scope's decision and where it came from; `/permissions set <scope>
<allow|ask|deny>` changes it for good.

`--safety` overrides all of that for one session, and is off unless passed:

```sh
leanpi --safety low      # every scope allow: nothing prompts, nothing refuses
leanpi --safety medium   # the built-in column: read allow, most ask, destructive deny
leanpi --safety high     # read allow, edit ask, everything else deny
```

A level is the whole policy — your stored scopes and every capability rule are
ignored while it is in force, since a level a forgotten `/permissions set` could
undercut would not be a level.

Tool calls render as Claude Code's compact rows — one line per call, the output
behind `ctrl+o` (`ctrl+shift+o` for the long form), in whatever theme is active.
How much shows is a session-level choice, and a durable one:

```sh
/cc-tools status            # what every switch is set to right now
/cc-tools detail on         # the long form by default, without the keystroke
/cc-tools thinking full     # keep finished thinking expanded, not just live
/cc-tools group off         # one row per call instead of grouped runs
leanpi --ui plain           # Pi's own rendering, for a session or for good
```

`/cc-tools` writes `.pi/settings.json`, so the choice survives the session;
`readOutputMode`, `previewLines`, `bashCollapsedLines` and the rest can be set
there directly. Colours, borders and diff tints follow `themes/leanpi.json` on
their own (`/cc-theme status` shows what they resolved to); the one thing a
theme cannot reach is the syntax highlighting inside a diff, so the first run
seeds `diffTheme` in `~/.pi/settings.json` — and never touches a key you set.

Reasoning collapses by default: a streaming thinking block is one
`Thinking … (ctrl+t to expand)` line from the first frame, `ctrl+t` expands the
full trace, and `ctrl+t` again hides it. `/thinking-fold
off` detaches that renderer and gives you Pi's own live thinking instead;
`/thinking-fold` alone says which is set. The choice is which extension the
launcher attaches, so it applies from the next session, and it is stored in
`$XDG_CONFIG_HOME/leanpi/ui.json`.

Two other entry points, one code path:

```sh
# As a Pi extension by hand (what `leanpi` does for you)
npx pi --extension ./dist/leanpi.js --no-skills

# As a library (the same activate() path the tests exercise)
node -e "import('./dist/index.js').then(async (m) => {
  const session = await m.createLeanPiSession();
  await session.runTurn('summarize this repository');
  console.log(session.session.messages.at(-1).content);
})"
```

Configuration lives in `leanpi.config.yaml` beside the working directory (or in
`$XDG_CONFIG_HOME/leanpi/`): `backends` (native OpenAI-compatible endpoints and
`external_harness` CLIs), `models` (the six roles `quick`/`balanced`/`strong`/
`specialist`/`review_quick`/`review_strong`), `jev`, `capabilities`,
`permissions`, `limits`. Credentials are resolved from the environment by name —
no key is ever written into the repo.

Annotated example: [`leanpi.config.yaml`](../leanpi.config.yaml).

## Subagents

LeanPi attaches [`pi-subagents`](https://pi.dev/packages/pi-subagents) (pinned
`0.70.1`) as one resource path through Pi's native loader. It resolves the exact
enabled extension path Pi's own settings expose and passes that path (the CLI
adds one `--extension`, the SDK one `additionalExtensionPaths` entry), so Pi's
canonical-path merge keeps a single copy even when the operator has configured
the same package globally. LeanPi's own `attach` adds only the operator limit
clamp and its command; it does not register the package a second time. Selection
fails closed with an actionable message on a mismatched
version, more than one enabled copy, a malformed config, or (in the CLI's
global-only preflight) a project-scoped copy that could load on top later.
Move or remove a project-local copy before launching LeanPi; this conservative
check can also reject a physical copy disabled by a project filter.
Whether the *model* can delegate depends on who answers the turn:

| parent mode | who answers the turn | model can call `subagent` | supported delegation entrypoint |
| --- | --- | --- | --- |
| `leanpi` CLI / `createLeanPiSession`, native backends | Pi's loop | yes | the `subagent` tool |
| external-harness parent (all roles `external_harness`) | the vendor CLI | no | host-owned `/run` with an available Pi-native child model |

An external vendor CLI owns its own turn and never sees Pi's tools, so LeanPi
does not claim a model-driven subagent call there; the host-owned `/run` command
is the supported path and runs the same upstream workflow engine. No adapter or
scheduler is invented to bridge the two.

Try `/run delegate summarize this file`. `delegate` is an upstream built-in
agent; no custom agent file is needed. A native parent can also ask its model to
use the `subagent` tool. An external-harness parent needs a Pi-native child
provider/model (for example, set `subagents.defaultModel` in Pi settings to a
model already available to Pi); a vendor CLI model alone cannot run the child.

**Per-run limit.** LeanPi ships `globalConcurrencyLimit: 3`: at most three
children of one delegation run (one workflow call) overlap. Upstream already
enforces it per run with a fresh semaphore, so independent calls each get their
own — this is a per-run ceiling, not a process-wide cap, and LeanPi does not
claim otherwise.

```
/subagents-limit          # show the active and saved value
/subagents-limit 4        # save 4; a lower per-call override still wins
/subagents-limit reset    # back to the default 3
```

Upstream reads its config once when its extension starts, so a saved change
applies after `/reload` or a restart; the command says so, and it never writes
on invalid input or a config file it cannot safely round-trip. The limit is
stored in Pi's upstream config at `getAgentDir()/extensions/subagent/config.json`
(`PI_CODING_AGENT_DIR` when set).
The SDK's `agentDir` option controls resource discovery separately and does not
change this config location or the process environment. A config with no
`asyncByDefault` is written as `false`: LeanPi's native providers are registered
in-process, and an async child is a separate process that cannot see them. To
run children asynchronously, name a child-visible `backend`/`model` in the
child's agent config and set `asyncByDefault: true`; otherwise a child resolves
`backend/model` only on the foreground path.

**Cost.** `/subagent-cost` (upstream) reports its child usage. LeanPi's `/cost`
does not aggregate that child usage. The model-tool clamp applies to model-issued
workflow overrides; trusted direct extension/RPC callers use upstream's own API.
