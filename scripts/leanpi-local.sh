#!/bin/sh
# Version-independent launcher, linked into ~/.local/bin by `pnpm link:bin`:
# `npm link` binds `leanpi` to one nvm version's bin directory, so the command
# vanishes the moment a project selects another. This runs the checkout it lives
# in with the first Node that meets the package's >=22.19 requirement.
# The launch clock `src/cli/startup-trace.ts` stamps against (GNU date; elsewhere node starts it).
LEANPI_T0="$(date +%s%3N)"
export LEANPI_T0
root="$(dirname "$(dirname "$(readlink -f "$0")")")"
exec 4>&1
for candidate in "$(command -v node)" "$HOME"/.nvm/versions/node/v*/bin/node; do
	[ -x "$candidate" ] || continue
	# fd 3 carries runtime rejection separately from valid CLI exit codes;
	# fd 4 streams stdout to the caller while the shell waits for that result.
	unsupported="$(PATH="$(dirname "$candidate"):$PATH" "$candidate" -e '
		const [major, minor] = process.versions.node.split(".").map(Number);
		const fs = require("fs");
		if (major < 22 || (major === 22 && minor < 19)) {
			fs.writeSync(3, "unsupported");
			process.exit(1);
		}
		fs.closeSync(3);
		fs.closeSync(4);
		const { pathToFileURL } = require("url");
		const root = process.argv[1];
		process.argv[1] = `${root}/bin/leanpi.js`;
		(async () => {
			try {
				const { vendorThinkingFold } = await import(pathToFileURL(`${root}/scripts/vendor-thinking-fold.mjs`));
				vendorThinkingFold();
			} catch {
				process.exit(1);
			}
			const { devBuild } = await import(pathToFileURL(`${root}/scripts/dev-build.mjs`));
			await devBuild();
			await import(pathToFileURL(process.argv[1]));
		})();
	' "$root" "$@" 3>&1 1>&4)"
	status=$?
	[ -n "$unsupported" ] && continue
	exit "$status"
done
echo "leanpi: no Node >= 22.19 found" >&2
exit 1
