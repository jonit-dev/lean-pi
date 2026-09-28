/**
 * `pi-claude-code-ui`, attached so the backgrounding `bash` gets its row.
 *
 * Runs the package's factory unchanged and keeps a copy of its `bash` row for the
 * background adapter; `src/cli/background.ts` carries the why. Loaded by Pi
 * through jiti, as the background adapter is.
 */
import compactUi from "pi-claude-code-ui/extensions/index.ts";
import { compactUiAdapter } from "../../dist/cli/background.js";

export default compactUiAdapter(compactUi as never);
