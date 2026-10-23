/**
 * `pi-claude-code-ui`, attached so the backgrounding `bash` gets its row.
 *
 * Runs the package's factory unchanged and keeps a copy of its `bash` row for the
 * background adapter; `src/cli/background.ts` carries the why. Both adapters
 * are precompiled and use the native bridge for Pi's runtime modules.
 */
import compactUi from "pi-claude-code-ui/extensions/index.ts";
import { compactUiAdapter } from "../../dist/cli/background.js";

export default compactUiAdapter(compactUi as never);
