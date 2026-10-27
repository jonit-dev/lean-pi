/**
 * `pi-context-view`, attached as `/context-view` so LeanPi's `/context` keeps
 * its name; `src/cli/context-view.ts` carries the why. The native bridge
 * resolves the precompiled package's `@earendil-works/*` imports.
 */
import contextView from "pi-context-view/src/index.ts";
import { contextViewAdapter } from "../../dist/cli/context-view.js";

export default contextViewAdapter(contextView as never);
