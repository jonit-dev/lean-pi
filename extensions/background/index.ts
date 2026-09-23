/**
 * `pi-patty-bg-tasks`, attached so its `bash` survives the compact UI.
 *
 * Runs the package's factory with its `bash` held back to `session_start`;
 * `src/cli/background.ts` carries the why. Loaded by Pi through jiti, so the
 * package's `@earendil-works/*` imports resolve to Pi's own modules, as the
 * `/usage` adapter's do.
 */
import backgroundTasks from "pi-patty-bg-tasks/index.ts";
import { backgroundTasksAdapter } from "../../dist/cli/background.js";

export default backgroundTasksAdapter(backgroundTasks as never);
