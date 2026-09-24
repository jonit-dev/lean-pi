/**
 * `pi-patty-bg-tasks`, attached so its `bash` survives the compact UI.
 *
 * Runs the package's factory with its `bash` held back to `session_start`;
 * `src/cli/background.ts` carries the why. Loaded by Pi through jiti, so the
 * package's `@earendil-works/*` imports resolve to Pi's own modules, as the
 * `/usage` adapter's do.
 */
import { TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import backgroundTasks from "pi-patty-bg-tasks/index.ts";
import { backgroundTasksAdapter } from "../../dist/cli/background.js";

// Ctrl+B is background tasks, as in Claude Code. Pi's default also binds it to
// cursor-left and warns about the clash on every start. Only the default drops
// it, so a user's own `tui.editor.cursorLeft` binding still wins.
TUI_KEYBINDINGS["tui.editor.cursorLeft"].defaultKeys = ["left"];

export default backgroundTasksAdapter(backgroundTasks as never);
