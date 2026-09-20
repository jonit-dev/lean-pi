#!/usr/bin/env bash
# One alternating baseline/treatment pair of bench runs, at the conditions the
# benchmark requires:
#
#   * a permission profile (XDG_CONFIG_HOME) that allows edit/shell/network/
#     package_install — without it every such call resolves to `ask`, and a
#     headless session refuses it, so the run measures a read-only agent;
#   * a fresh provider session id per run, so prompt-cache state is symmetric;
#   * one arm at a time, so the two arms never overlap on the provider.
#
# Usage: bench/cost/run-pair.sh <suite-dir> <tag> [--keep-workspaces]
#
# The baseline arm is a worktree at the revision under comparison, built there:
#   git worktree add ../cost-baseline <rev> && (cd ../cost-baseline && npm run build)
# Its path is $LEANPI_BASELINE_WORKTREE (default ../cost-baseline).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
BASE=${LEANPI_BASELINE_WORKTREE:-$(dirname "$ROOT")/cost-baseline}
SUITE=${1:?usage: run-pair.sh <suite-dir> <tag> [--keep-workspaces]}
TAG=${2:?usage: run-pair.sh <suite-dir> <tag> [--keep-workspaces]}
KEEP=${3:-}

: "${OPENCODE_API_KEY:?export OPENCODE_API_KEY before running}"
# A run whose JEV key is missing still completes — every site takes its
# deterministic fallback — but it measures a harness with its control plane
# switched off, and the pair's numbers say nothing about LeanPi's decisions.
# LeanPi reads no `.env` itself: the shell has to load it.
if [ -f "$ROOT/.env" ]; then
	set -a
	. "$ROOT/.env"
	set +a
fi
if [ -z "${JEV_API_KEY:-}" ]; then
	printf '[%s] WARNING: JEV_API_KEY is unset — every JEV site will take its deterministic fallback, so this pair measures a JEV-less harness\n' "$(date +%H:%M:%S)"
fi
export XDG_CONFIG_HOME="$ROOT/bench/profiles/bench"

run_arm() {
	local arm=$1 dir=$2
	[ "$arm" = base ] && dir=$BASE
	export LEANPI_OPENCODE_SESSION="leanpi-cost-${TAG}-${arm}-$(date +%s)"
	printf '[%s] %s (%s)\n' "$(date +%H:%M:%S)" "$TAG-$arm" "$arm"
	(cd "$dir" && node dist/bench/lane.js \
		--suite "$SUITE" --configs leanpi-flash --out "$ROOT/bench/out" \
		--run-id "cost-$TAG-$arm" $KEEP)
}

run_arm base "$BASE"
run_arm treat "$ROOT"
printf '[%s] %s done\n' "$(date +%H:%M:%S)" "$TAG"
