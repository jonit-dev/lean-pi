# Bench report audit-028-preflight-omp

- suite: /home/joao/projects/lean-pi/.worktrees/production-readiness-audit/bench/suites/validated (4 tasks)
- generated: 2026-09-19T20:54:38.884Z
- §52 telemetry rows joined: 4
- §4 targets are printed for comparison only; the exit code never depends on them.

## §53 metrics

| config | attempts | verified solve rate | cost/verified success | generator tokens/verified success | time to verified success | false completion rate | effective cost total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| omp | 4 | 1.0000 (4/4) | $0.019635 | 1228778 tokens | median 107529ms / p95 (nearest-rank, n=4) 383288ms | 0.0000 (0/3) | $0.078540 |

## configuration rows

### omp — omp (oh-my-pi) on the same model, with its own default surface

- adapter: omp (operator omp)
- executor model: deepseek-v4.1-flash
- capability: index: unavailable — model "deepseek-v4.1-flash" is not listed in /home/joao/projects/lean-pi/.worktrees/production-readiness-audit/src/capability/models.json
- loaded extensions: omp
- features: own-system-prompt, own-tool-surface, own-skill-discovery
- adjudicators: npx mocha --require test/support/env --check-leaks test/res.send.js | .venv/bin/python -m pytest tests/test_basic.py -q | npx vitest run compat/test/browser/suspense.test.jsx | npx ava test.js
- subscription usage recorded: 0
- budget per attempt: $6

## per-task pairing

The same task under each configuration that ran it, with each side's own adjudication and measured cost:

| task | omp |
| --- | --- |
| express-send-transfer-encoding-etag | complete / $0.010671 / reported true |
| flask-ipv6-server-name-parsing | complete / $0.021677 / reported true |
| preact-suspense-hook-state-loss | complete / $0.030410 / reported false |
| slugify-counter-duplicate-slug | complete / $0.015782 / reported true |

## adjudicator identity per attempt

| task | config | adjudicator | verdict | reviewer model | rubric model |
| --- | --- | --- | --- | --- | --- |
| express-send-transfer-encoding-etag | omp | npx mocha --require test/support/env --check-leaks test/res.send.js | complete | - | - |
| flask-ipv6-server-name-parsing | omp | .venv/bin/python -m pytest tests/test_basic.py -q | complete | - | - |
| preact-suspense-hook-state-loss | omp | npx vitest run compat/test/browser/suspense.test.jsx | complete | - | - |
| slugify-counter-duplicate-slug | omp | npx ava test.js | complete | - | - |

## §4 aspirational targets (comparison context, not a gate)

- baseline row: omp
- target: 90–95% or more of a contemporary Claude Code / Codex baseline; cost at or below 25% of the baseline's cost per verified success (stretch 10%)
- omp: solve rate 1.0000, cost/verified success $0.019635, relative to baseline 100.0%

_ROADMAP §4 — product targets, not claims about current performance_
