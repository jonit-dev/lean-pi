# Bench report cost-f-noskills

- suite: /home/joao/projects/lean-pi/.worktrees/production-readiness-audit/bench/suites/cost-express (1 tasks)
- generated: 2026-09-19T22:55:13.088Z
- §52 telemetry rows joined: 1
- §4 targets are printed for comparison only; the exit code never depends on them.

## §53 metrics

| config | attempts | verified solve rate | cost/verified success | generator tokens/verified success | time to verified success | false completion rate | effective cost total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| leanpi-flash | 1 | 0.0000 (0/1) | n/a (0 verified successes) | n/a (0 verified successes) | median n/a / p95 (nearest-rank, n=0) n/a | n/a (0 reported successes) | $0.005295 |

## configuration rows

### leanpi-flash — LeanPi on the same model as the omp baseline

- adapter: leanpi (operator leanpi)
- executor model: deepseek-v4.1-flash
- capability: index: unavailable — model "deepseek-v4.1-flash" is not listed in /home/joao/projects/lean-pi/.worktrees/production-readiness-audit/src/capability/models.json
- loaded extensions: leanpi
- features: jev, context-engine, skill-selection, mcp-disclosure, lsp, verification
- adjudicators: npx mocha --require test/support/env --check-leaks test/res.send.js
- subscription usage recorded: 0
- budget per attempt: $6

## per-task pairing

The same task under each configuration that ran it, with each side's own adjudication and measured cost:

| task | leanpi-flash |
| --- | --- |
| express-send-transfer-encoding-etag | incomplete / $0.005295 / reported false |

## adjudicator identity per attempt

| task | config | adjudicator | verdict | reviewer model | rubric model |
| --- | --- | --- | --- | --- | --- |
| express-send-transfer-encoding-etag | leanpi-flash | npx mocha --require test/support/env --check-leaks test/res.send.js | incomplete | - | - |

## §4 aspirational targets (comparison context, not a gate)

- no baseline row in this invocation, so no relative comparison is printed (no baseline row ran in this invocation: the §4 comparison needs one of claude-code, codex or stock-pi)

_ROADMAP §4 — product targets, not claims about current performance_
