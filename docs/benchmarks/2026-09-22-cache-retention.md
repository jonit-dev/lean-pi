# Long prompt-cache retention: `short` vs `long` on the validated suite

**2026-09-22 · one model held constant · `opencode-go/deepseek-v4.1-flash`**

PRD-046's AC-3. Pi defaults `PI_CACHE_RETENTION` to `short`; LeanPi's
`launchEnv()` now sets `long` unless the operator already set the variable. This
run is the measurement that decides whether that default ships, using the same
four-task validated suite and LeanPi arm as the four-way harness comparison.

## TL;DR

`long` is **not more expensive**: **$0.024343 per verified completion** against
`short`'s **$0.031927**, both at **4/4**. The decision rule is satisfied, so the
default ships `long`.

The gap is **23.8%**, but it is not a clean cache effect — at one trial per task
it is dominated by reasoning-token variance, the same 2.4× within-arm swing the
[four-way run](./2026-09-21-four-way-harness-cost.md) documented. What the run
establishes is the *decision rule's* condition ("not more expensive"), not a
causal claim that a 1h TTL saves a quarter of the bill.

## Arms

Same code, same model, same suite, one variable: `PI_CACHE_RETENTION`.

| arm | env | run |
| --- | --- | --- |
| `short` | `PI_CACHE_RETENTION=short` | `bench/out/cache-short/` |
| `long` | `PI_CACHE_RETENTION=long` | `bench/out/cache-long/` |

Both are the `leanpi-flash` config (LeanPi extension, JEV on,
`deepseek-v4.1-flash`) over `bench/suites/validated` (4 tasks), one attempt per
task. git `419c444`, working tree carrying PRD-046's `launchEnv()` change.

## Results

`bench/out/cache-{short,long}/report.md`, §53 metrics:

| arm | attempts | verified | **cost / verified completion** | effective cost total | median time |
| --- | --: | --: | --: | --: | --: |
| short | 4 | 4/4 | $0.031927 | $0.127709 | 146.8 s |
| **long** | 4 | 4/4 | **$0.024343** | **$0.097371** | 131.0 s |

### Per task

| task | short | long |
| --- | --: | --: |
| express-send-transfer-encoding-etag | $0.008282 | $0.008150 |
| flask-ipv6-server-name-parsing | $0.019512 | $0.017836 |
| preact-suspense-hook-state-loss | $0.089197 | $0.060200 |
| slugify-counter-duplicate-slug | $0.010718 | $0.011185 |

`long` is cheaper on three of four tasks; `slugify` is 4.4% more expensive.
`preact` carries most of the aggregate difference.

## Why the gap is variance, not the TTL

Reasoning tokens drive cost, and they moved more between arms than the cache did:

| arm | input | cached input | output | reasoning | JEV |
| --- | --: | --: | --: | --: | --: |
| short | 238,443 | 10,084,864 | 26,510 | 68,076 | 117,457 |
| long | 273,760 | 4,974,336 | 21,179 | 39,583 | 117,372 |

`long` spent **42% fewer reasoning tokens**, which alone explains the cost
difference. Cached-input tokens fell too, but that tracks the smaller number of
turns the shorter run took, not cache expiry. One trial per arm cannot separate
the two, and the four-way run's own guidance is that this needs ~28 trials per
arm to resolve a 20% effect. The honest reading: `long` did not cost more, so
the default stands; whether it reliably saves is unproven at n=4.

## Limits

- **n=1 per task per arm.** A single sample per task; the aggregate is four
  samples. No confidence interval is claimed.
- **Cache-write cost is not in these numbers.** The provider's usage reports
  `cache_write_tokens: 0` and the rate card prices `input`/`output`/`cacheRead`
  only, so the 2x-vs-1.25x write premium the PRD names (risk 2) is invisible
  here. A provider that reports and bills cache writes could order the arms
  differently.
- **Usage-value estimates** against a rate card, not invoices.
- **No stock-Pi baseline row** ran in this invocation, so no §4 relative
  comparison is printed. The comparison is between the two LeanPi arms only,
  which is what the AC asks.

## Reproduce

```sh
pnpm build
set -a; . ./.env; set +a
export XDG_CONFIG_HOME="$PWD/bench/profiles/bench"
export LEANPI_OPENCODE_SESSION="leanpi-cache-$(date +%s)"

PI_CACHE_RETENTION=short node dist/bench/lane.js \
  --suite bench/suites/validated --configs leanpi-flash \
  --out bench/out --run-id cache-short
PI_CACHE_RETENTION=long node dist/bench/lane.js \
  --suite bench/suites/validated --configs leanpi-flash \
  --out bench/out --run-id cache-long
```

Cost per verified completion is the `cost/verified success` column of each
run's `report.md`, folded from the §52 records under `bench/out/cache-*/`.
