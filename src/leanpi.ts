/**
 * The extension entry the `leanpi` launcher attaches.
 *
 * Pi names a loaded extension after its file, so attaching `dist/index.js`
 * puts `[Extensions] dist` on the user's first screen. This file exists so the
 * name reads `leanpi`; it adds nothing else.
 */
export { default } from "./index.js";
