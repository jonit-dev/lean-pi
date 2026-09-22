#!/bin/sh
# Version-independent launcher, linked into ~/.local/bin by `pnpm refresh:bin`:
# `npm link` binds `leanpi` to one nvm version's bin directory, so the command
# vanishes the moment a project selects another. This runs the checkout it lives
# in with the first Node that meets the package's >=22.19 requirement.
root="$(dirname "$(dirname "$(readlink -f "$0")")")"
for candidate in "$HOME"/.nvm/versions/node/v*/bin/node "$(command -v node)"; do
	[ -x "$candidate" ] || continue
	"$candidate" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' || continue
	PATH="$(dirname "$candidate"):$PATH"
	export PATH
	exec pnpm --silent --dir "$root" leanpi "$@"
done
echo "leanpi: no Node >= 22.19 found" >&2
exit 1
