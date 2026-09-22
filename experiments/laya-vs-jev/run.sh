#!/usr/bin/env bash
# Reproduce the Laya-vs-JEV comparison end to end.
#
#   ./run.sh                 # both providers, all three Laya checkpoints
#   ./run.sh --device cpu    # no GPU
#   ./run.sh --no-jev        # Laya only (no JEV_API_KEY needed)
#
# Requires: uv, node, python3, and JEV_API_KEY in the environment or in the
# repo's .env for the JEV arm. First run downloads ~2.5 GB of CUDA wheels and
# ~2.2 GB of Laya checkpoints.
set -euo pipefail
cd "$(dirname "$0")"

DEVICE="cuda"
WITH_JEV=1
while [[ $# -gt 0 ]]; do
	case "$1" in
		--device) DEVICE="$2"; shift 2 ;;
		--no-jev) WITH_JEV=0; shift ;;
		*) echo "unknown argument: $1" >&2; exit 2 ;;
	esac
done

echo "== cases =="
python3 cases.py

echo "== environment =="
[[ -d .venv ]] || uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python torch --index-url https://download.pytorch.org/whl/cu124 >/dev/null
uv pip install --python .venv/bin/python laya >/dev/null

echo "== Laya =="
USE_TF=0 .venv/bin/python laya_runner.py --device "$DEVICE"
for sub in typed-decisions multilingual; do
	USE_TF=0 .venv/bin/python laya_runner.py --device "$DEVICE" --subfolder "$sub"
done

if [[ "$WITH_JEV" == "1" ]]; then
	echo "== JEV =="
	if [[ -z "${JEV_API_KEY:-}" && -f ../../../.env ]]; then
		set -a; . ../../../.env; set +a
	fi
	node jev_runner.mjs
fi

echo "== drop-in =="
node drop_in.mjs

echo "== score =="
inputs=(out/laya-*.jsonl)
[[ -f out/jev.jsonl ]] && inputs=(out/jev.jsonl "${inputs[@]}")
python3 score.py "${inputs[@]}" --diff | tee out/report.txt
