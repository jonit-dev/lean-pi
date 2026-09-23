# Bench report cost-beat-smoke-20260923

- suite: /home/joao/projects/lean-pi/bench/suites/cost-express (1 tasks)
- generated: 2026-09-23T20:51:26.167Z
- §52 telemetry rows joined: 2
- §4 targets are printed for comparison only; the exit code never depends on them.

## §53 metrics

| config | attempts | verified solve rate | cost/verified success | generator tokens/verified success | time to verified success | false completion rate | effective cost total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| leanpi-flash | 1 | 1.0000 (1/1) | $0.010495 | 334853 tokens | median 43813ms / p95 (nearest-rank, n=1) 43813ms | n/a (0 reported successes) | $0.010495 |
| stock-pi-deepseek | 1 | 1.0000 (1/1) | $0.013365 | 666287 tokens | median 85283ms / p95 (nearest-rank, n=1) 85283ms | 0.0000 (0/1) | $0.013365 |

## configuration rows

### leanpi-flash — LeanPi on the same model as the omp baseline

- adapter: leanpi (operator leanpi)
- executor model: deepseek-v4.1-flash
- capability: index 74, blended price 0.525 USD/Mtok, speed fast (/home/joao/projects/lean-pi/src/capability/models.json)
- loaded extensions: leanpi
- features: jev, context-engine, skill-selection, mcp-disclosure, lsp, verification
- adjudicators: npx mocha --require test/support/env --check-leaks test/res.send.js
- subscription usage recorded: 0
- budget per attempt: $6

### stock-pi-deepseek — Stock Pi (no LeanPi extension) on the same DeepSeek v4.1 Flash / opencode-go

- adapter: stock-pi (operator stock-pi)
- executor model: deepseek-v4.1-flash
- capability: index 74, blended price 0.525 USD/Mtok, speed fast (/home/joao/projects/lean-pi/src/capability/models.json)
- loaded extensions: none (no LeanPi)
- features: none
- adjudicators: npx mocha --require test/support/env --check-leaks test/res.send.js
- subscription usage recorded: 0
- budget per attempt: $2

## per-task pairing

The same task under each configuration that ran it, with each side's own adjudication and measured cost:

| task | leanpi-flash | stock-pi-deepseek |
| --- | --- | --- |
| express-send-transfer-encoding-etag | complete / $0.010495 / reported false | complete / $0.013365 / reported true |

## adjudicator identity per attempt

| task | config | adjudicator | verdict | reviewer model | rubric model |
| --- | --- | --- | --- | --- | --- |
| express-send-transfer-encoding-etag | leanpi-flash | npx mocha --require test/support/env --check-leaks test/res.send.js | complete | - | - |
| express-send-transfer-encoding-etag | stock-pi-deepseek | npx mocha --require test/support/env --check-leaks test/res.send.js | complete | - | - |

## §4 aspirational targets (comparison context, not a gate)

- no baseline row in this invocation, so no relative comparison is printed (no baseline row ran in this invocation: the §4 comparison needs one of claude-code, codex or stock-pi)

_ROADMAP §4 — product targets, not claims about current performance_
