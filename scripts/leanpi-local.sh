#!/bin/sh
# Version-independent launcher, linked into ~/.local/bin by `pnpm link:bin`:
# `npm link` binds `leanpi` to one nvm version's bin directory, so the command
# vanishes the moment a project selects another. This runs the checkout it lives
# in with the first Node that meets the package's >=22.19 requirement.
root="$(dirname "$(dirname "$(readlink -f "$0")")")"
for candidate in "$(command -v node)" "$HOME"/.nvm/versions/node/v*/bin/node; do
	[ -x "$candidate" ] || continue
	"$candidate" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' || continue
	PATH="$(dirname "$candidate"):$PATH"
	export PATH
	# The `leanpi` package script's steps, run directly: `pnpm --dir` costs ~1s
	# and runs the script inside the checkout, so the session opened there
	# instead of in the caller's directory.
	node "$root/scripts/vendor-thinking-fold.mjs" 2>/dev/null &&
		"$root/node_modules/.bin/tsc" -b "$root/tsconfig.json" &&
		exec node "$root/bin/leanpi.js" "$@"
	exit
done
echo "leanpi: no Node >= 22.19 found" >&2
exit 1
