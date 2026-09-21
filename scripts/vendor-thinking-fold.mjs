/**
 * Copies `@99percentpeople/pi-thinking-fold`'s build into `vendor/` as `.ts`.
 *
 * The package ships only `index.min.js`, and Pi native-imports a `.js`
 * extension instead of routing it through jiti's virtual-module map: its
 * `AssistantMessageComponent.prototype.updateContent` patch then lands on a
 * second copy of the class, and nothing that renders ever sees it. The same
 * bytes under a `.ts` name are transformed by jiti, resolve Pi's own modules,
 * and fold. `src/cli/spinner.ts` documents the identical trap.
 *
 * `model-behaviors.json` comes along because the extension reads it relative to
 * its own `import.meta.url`, so the two have to stay siblings.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = dirname(createRequire(import.meta.url).resolve("@99percentpeople/pi-thinking-fold/index.min.js"));
const target = join(root, "vendor", "pi-thinking-fold");

mkdirSync(target, { recursive: true });
copyFileSync(join(source, "index.min.js"), join(target, "index.min.ts"));
copyFileSync(join(source, "model-behaviors.json"), join(target, "model-behaviors.json"));
process.stderr.write(`vendored pi-thinking-fold -> ${target}\n`);
