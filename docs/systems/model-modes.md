# Model modes: Auto and Manual

**Plane:** surface · **Entry symbol:** `routePins().model`, `compilerLane()` · **Spec:** PRD-048, PRD-051

LeanPi has two modes, and only two.

| | **Auto** (default) | **Manual** |
|---|---|---|
| Entered by | starting LeanPi; `/model` → auto | `/model` → pick a model |
| Who picks the model | the router, per turn | the operator, once |
| Contract, JEV, PRD gate, exploration, review, proof gate, goal boundary | yes | **none** |
| Output | the answer plus the proof verdict | the model's reply, nothing else |
| Footer | router's pick, `Auto` | the pinned model, `Manual` in red; redrawn the moment `/model` changes — no `LeanPi: …` phase |
| Chat | Pi's messages, or LeanPi's report | a regular Pi turn on the pinned model, native or CLI: prompt, spinner, reply, Esc, usage |
| Survives `/new`, `/resume` | — | yes |
| Survives a restart | — | only with `remember_manual_model: true` |

**Auto** is LeanPi: the harness classifies the turn, routes it to a model, and
proves the result.

**Manual** is a plain harness: the prompt goes to the model you picked, and its
reply comes back. It stays in effect until `/model` switches back to Auto.

```mermaid
flowchart TD
    T[turn] --> P{"/model pin?"}
    P -- no --> A[Auto: compile contract → route → execute → review → proof gate → goal]
    P -- yes --> K{pinned backend}
    K -- native --> N["Pi's own loop on the pinned model"]
    K -- CLI vendor --> N2["Pi's own loop on the &lt;backend&gt;-cli provider"]
    N2 --> C[its stream runs the vendor CLI on the prompt as-is]
    N --> R[reply]
    C --> R
    A --> V[answer + proof verdict]
```

## Lifetime

```mermaid
stateDiagram-v2
    [*] --> Auto: start
    Auto --> Manual: /model &lt;pick&gt;
    Manual --> Manual: /model &lt;other pick&gt;, /new, /resume
    Manual --> Auto: /model auto
    Manual --> Auto: restart (default)
    Manual --> Manual: restart with remember_manual_model
```

- The pin is session-process state, never a config write.
- `remember_manual_model: true` in `leanpi.config.yaml` (default `false`) also saves the pick
  to `~/.leanpi/model.json`; startup reads it and comes back in Manual. `/model auto` deletes it.
- A CLI pin keeps its conversation through the vendor's session id (`claude --resume` and
  equivalents); `/new`, `/resume`, `/model auto` or a repin start a fresh one.
- A CLI pin is a Pi model (PRD-051, `src/backends/cli-provider.ts`): `/model` registers a
  `<backend>-cli` provider (never the backend's own name — Pi ships `opencode` and `opencode-go`)
  and `setModel`s it, so Pi's footer names it and Pi's loop runs the turn. The provider's stream
  sends the last user message to the vendor CLI, maps its reply and usage onto the assistant
  message, and kills the vendor on Esc. Pi's tool declarations are ignored: the CLI uses its own.
- `claude --model opus` runs an alias. The result's `modelUsage` names the full id, which is saved
  to `~/.leanpi/model-ids.json`; the pin, the footer and the `/model` picker then use it
  (`claude-opus-5-5`). Only a real run teaches an id — nothing is guessed.
- Role bindings are a different thing: `/role` writes the config the router uses in Auto.
