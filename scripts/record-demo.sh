#!/usr/bin/env bash
#
# Record a LeanPi sample task to a `.cast`, and render it to a `.gif`.
#
#   pnpm record:demo                 # -> docs/demos/leanpi-demo.{cast,gif}
#   OUT=/tmp/demos pnpm record:demo  # somewhere else
#
# The task is fixed and cheap: a failing test with a one-character bug, in a
# throwaway project under `$TMPDIR`. The demo is the loop, not the bug — route,
# execute, verify, and the status line that says what it decided.
#
# asciinema records a terminal, so the terminal is built rather than borrowed.
# A detached tmux session runs `leanpi`; a background driver types into it once
# the recorder has attached; asciinema records a client attached to that
# session. Re-run this and the demo is the same, with no human at the keyboard.
#
# Needs `asciinema` and `agg` on PATH (both ship static binaries:
# https://asciinema.org/download), `tmux`, Node 22+, and a LeanPi that can reach
# a model. Nothing is written outside `$OUT` and the temp dir.
set -euo pipefail

root="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
out="${OUT:-$root/docs/demos}"
cast="$out/leanpi-demo.cast"
gif="$out/leanpi-demo.gif"

# 100x30 fits the compact UI's footer without wrapping; the same size is given
# to asciinema so the client never resizes the window mid-recording.
cols=100
rows=30
task="cart discounts start a dollar too late - fix it and prove the tests pass"
# The turn is over when the footer says so. This bounds the wait for a model
# that never answers, and for a footer string that one day moves.
turn_timeout="${TURN_TIMEOUT:-300}"
socket="leanpi-demo"
session="leanpi-demo"

for tool in asciinema agg tmux; do
	command -v "$tool" >/dev/null || {
		echo "record-demo: $tool is not on PATH" >&2
		exit 1
	}
done
[ -f "$root/dist/cli/launch.js" ] || {
	echo "record-demo: run \`pnpm build\` first (dist/ is missing)" >&2
	exit 1
}

work="$(mktemp -d)"
project="$work/demo-project"
mkdir -p "$project/src" "$project/test" "$out"

# --- the throwaway project: red before the task, green after ---------------
cat >"$project/package.json" <<'JSON'
{
  "name": "demo-project",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
JSON

cat >"$project/src/cart.js" <<'JS'
export function subtotal(items) {
	return items.reduce((sum, item) => sum + item.price, 0);
}

/** 10% off once the subtotal reaches $100. */
export function total(items) {
	const sum = subtotal(items);
	return sum > 100 ? sum * 0.9 : sum;
}
JS

cat >"$project/test/cart.test.js" <<'JS'
import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/cart.js";

test("10% off at exactly $100", () => {
	assert.equal(total([{ price: 60 }, { price: 40 }]), 90);
});

test("no discount below $100", () => {
	assert.equal(total([{ price: 60 }, { price: 39 }]), 99);
});
JS

# --- the terminal the demo is recorded from --------------------------------
# `-f` keeps the operator's own tmux config out of the recording, and `-L` puts
# this server on its own socket so their sessions are never touched.
cat >"$work/tmux.conf" <<'CONF'
set -g status off
set -g escape-time 0
set -g extended-keys on
CONF

# The fixture lives in a temp dir, so point sessions at one too: re-recording
# must not pile up empty sessions in the operator's real store.
tmux -L "$socket" -f "$work/tmux.conf" new-session -d -s "$session" \
	-x "$cols" -y "$rows" -c "$project" \
	"node $root/bin/leanpi.js --session-dir $work/sessions -n 'cart discount fix'"

cleanup() {
	tmux -L "$socket" kill-server 2>/dev/null || true
	rm -rf "$work"
}
trap cleanup EXIT

# --- the driver ------------------------------------------------------------
# Waits for the recorder before typing anything: the session exists before
# asciinema attaches, and a task typed into that gap is a task no one sees.
(
	until tmux -L "$socket" list-clients -t "$session" 2>/dev/null | grep -q .; do sleep 0.2; done
	until tmux -L "$socket" capture-pane -p -t "$session" 2>/dev/null | grep -q "leanpi v"; do sleep 0.2; done
	sleep 1

	tmux -L "$socket" send-keys -t "$session" -l "$task"
	sleep 1
	tmux -L "$socket" send-keys -t "$session" Enter

	for _ in $(seq 1 $((turn_timeout / 2))); do
		sleep 2
		if tmux -L "$socket" capture-pane -p -t "$session" 2>/dev/null | grep -q "Turn took"; then
			break
		fi
	done

	sleep 3
	tmux -L "$socket" send-keys -t "$session" -l "/status"
	sleep 1
	tmux -L "$socket" send-keys -t "$session" Enter
	sleep 6

	# `app.exit` is ctrl+d on an empty editor; that closes the window, which
	# ends the session, which is what stops the recording.
	tmux -L "$socket" send-keys -t "$session" C-d
) &

asciinema rec --headless --overwrite \
	--window-size "${cols}x${rows}" --idle-time-limit 2 \
	--title "LeanPi — a verified fix" \
	--command "tmux -L $socket attach -t $session" \
	"$cast"

wait

agg --font-size 14 --speed 1.5 --idle-time-limit 2 --theme asciinema "$cast" "$gif"

ls -lh "$cast" "$gif"
