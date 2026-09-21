/**
 * The suite must not read the developer's own LeanPi configuration.
 *
 * `configPathFor` walks up from the working directory and then falls back to
 * `$XDG_CONFIG_HOME/leanpi/leanpi.config.yaml` — the machine-wide config the
 * first run writes. That is right for a user running `leanpi` anywhere, and
 * poison for a fixture: a test whose temp directory deliberately has *no*
 * config silently loaded this machine's instead, and one written by
 * `leanpi`'s own first run (all subscription backends) flipped
 * `ownsExecutionLoop` and changed how skills are disclosed — a green suite
 * turning red because a real config appeared in `$HOME`.
 *
 * Only `$XDG_CONFIG_HOME` moves, to an empty directory: it is what config
 * discovery, the credential store and the permission defaults fall back to.
 * `HOME` stays real, because the specs that do assert against the machine's own
 * skill roots (`~/.claude`, `~/.agents/skills`) are opt-in — `LEANPI_REAL_SKILLS`
 * and `LEANPI_PRD_REAL_SKILLS` — and need the real one when they are asked for.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "leanpi-suite-xdg-"));
