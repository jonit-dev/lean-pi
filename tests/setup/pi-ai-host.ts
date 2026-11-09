/**
 * `@earendil-works/pi-ai` as Pi hands it to an extension: the compat entry plus
 * TypeBox's `Type`, which the published package stopped re-exporting in 1.5.0.
 * Pi and LeanPi's launcher map extension imports this way; vitest loads the
 * bundled extension packages directly, so `vitest.config.ts` maps them here.
 */
export * from "@earendil-works/pi-ai/compat";
export { Type } from "typebox";
