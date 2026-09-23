# Bench report cost-beat-minimal-20260923

- suite: /home/joao/projects/lean-pi/bench/suites/validated (4 tasks)
- generated: 2026-09-23T21:15:38.290Z
- §52 telemetry rows joined: 8
- §4 targets are printed for comparison only; the exit code never depends on them.

## §53 metrics

| config | attempts | verified solve rate | cost/verified success | generator tokens/verified success | time to verified success | false completion rate | effective cost total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| leanpi-flash | 4 | 0.7500 (3/4) | $0.032351 | 1638285 tokens | median 182262ms / p95 (nearest-rank, n=3) 286145ms | n/a (0 reported successes) | $0.097052 |
| stock-pi-deepseek | 4 | 1.0000 (4/4) | $0.020856 | 1523228 tokens | median 172133ms / p95 (nearest-rank, n=4) 272665ms | 0.0000 (0/4) | $0.083423 |

## configuration rows

### leanpi-flash — LeanPi on the same model as the omp baseline

- adapter: leanpi (operator leanpi)
- executor model: deepseek-v4.1-flash
- capability: index 74, blended price 0.525 USD/Mtok, speed fast (/home/joao/projects/lean-pi/src/capability/models.json)
- loaded extensions: leanpi
- features: jev, context-engine, skill-selection, mcp-disclosure, lsp, verification
- adjudicators: npx mocha --require test/support/env --check-leaks test/res.send.js | .venv/bin/python -m pytest tests/test_basic.py -q | npx vitest run compat/test/browser/suspense.test.jsx | npx ava test.js
- subscription usage recorded: 0
- budget per attempt: $6

### stock-pi-deepseek — Stock Pi (no LeanPi extension) on the same DeepSeek v4.1 Flash / opencode-go

- adapter: stock-pi (operator stock-pi)
- executor model: deepseek-v4.1-flash
- capability: index 74, blended price 0.525 USD/Mtok, speed fast (/home/joao/projects/lean-pi/src/capability/models.json)
- loaded extensions: none (no LeanPi)
- features: none
- adjudicators: npx mocha --require test/support/env --check-leaks test/res.send.js | .venv/bin/python -m pytest tests/test_basic.py -q | npx vitest run compat/test/browser/suspense.test.jsx | npx ava test.js
- subscription usage recorded: 0
- budget per attempt: $2

## per-task pairing

The same task under each configuration that ran it, with each side's own adjudication and measured cost:

| task | leanpi-flash | stock-pi-deepseek |
| --- | --- | --- |
| express-send-transfer-encoding-etag | complete / $0.006166 / reported false | complete / $0.013973 / reported true |
| flask-ipv6-server-name-parsing | complete / $0.018523 / reported false | complete / $0.020139 / reported true |
| preact-suspense-hook-state-loss | complete / $0.054420 / reported false | complete / $0.042436 / reported true |
| slugify-counter-duplicate-slug | incomplete / $0.017943 / reported false | complete / $0.006875 / reported true |

## adjudicator identity per attempt

| task | config | adjudicator | verdict | reviewer model | rubric model |
| --- | --- | --- | --- | --- | --- |
| express-send-transfer-encoding-etag | leanpi-flash | npx mocha --require test/support/env --check-leaks test/res.send.js | complete | - | - |
| flask-ipv6-server-name-parsing | leanpi-flash | .venv/bin/python -m pytest tests/test_basic.py -q | complete | - | - |
| preact-suspense-hook-state-loss | leanpi-flash | npx vitest run compat/test/browser/suspense.test.jsx | complete | - | - |
| slugify-counter-duplicate-slug | leanpi-flash | npx ava test.js | incomplete | - | - |
| express-send-transfer-encoding-etag | stock-pi-deepseek | npx mocha --require test/support/env --check-leaks test/res.send.js | complete | - | - |
| flask-ipv6-server-name-parsing | stock-pi-deepseek | .venv/bin/python -m pytest tests/test_basic.py -q | complete | - | - |
| preact-suspense-hook-state-loss | stock-pi-deepseek | npx vitest run compat/test/browser/suspense.test.jsx | complete | - | - |
| slugify-counter-duplicate-slug | stock-pi-deepseek | npx ava test.js | complete | - | - |

## §4 aspirational targets (comparison context, not a gate)

- no baseline row in this invocation, so no relative comparison is printed (no baseline row ran in this invocation: the §4 comparison needs one of claude-code, codex or stock-pi)

_ROADMAP §4 — product targets, not claims about current performance_
